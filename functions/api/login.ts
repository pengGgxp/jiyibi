import { beginGitHubOAuth } from "../lib/auth";
import { ApiError } from "../lib/errors";
import { handleAuthenticated, jsonResponse, methodNotAllowed } from "../lib/http";
import type { Env } from "../lib/types";

export function safeReturnUrl(request: Request): URL {
  const requestUrl = new URL(request.url);
  const value = requestUrl.searchParams.get("returnTo") ?? "/";
  if (value.length > 2048 || !value.startsWith("/") || value.startsWith("//")) {
    return new URL("/", requestUrl.origin);
  }
  const target = new URL(value, requestUrl.origin);
  if (
    target.origin !== requestUrl.origin ||
    target.pathname === "/api" ||
    target.pathname.startsWith("/api/")
  ) {
    return new URL("/", requestUrl.origin);
  }
  return target;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
  const returnUrl = safeReturnUrl(context.request);
  if (
    context.request.headers.get("Cf-Access-Jwt-Assertion")?.trim() ||
    (context.env.ENVIRONMENT === "development" && context.env.LOCAL_AUTH_EMAIL)
  ) {
    return handleAuthenticated(
      context,
      async () => Response.redirect(returnUrl.toString(), 302),
      { allowSyncDisabled: true, allowDeletionInProgress: true },
    );
  }
  try {
    const returnTo = `${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`;
    const started = await beginGitHubOAuth(context.request, context.env, returnTo);
    return new Response(null, {
      status: 302,
      headers: {
        "Cache-Control": "private, no-store",
        Location: started.authorizationUrl,
        "Referrer-Policy": "no-referrer",
        "Set-Cookie": started.nonceCookie,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    }
    console.error("GitHub OAuth start failed", error);
    return jsonResponse(
      { error: { code: "internal_error", message: "Internal server error" } },
      500,
    );
  }
};
