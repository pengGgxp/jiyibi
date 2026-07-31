import {
  clearGitHubOAuthNonceCookie,
  completeGitHubOAuth,
} from "../lib/auth";
import { ApiError } from "../lib/errors";
import { jsonResponse, methodNotAllowed } from "../lib/http";
import type { Env } from "../lib/types";

function oauthErrorResponse(error: unknown): Response {
  if (!(error instanceof ApiError)) {
    console.error("GitHub OAuth callback failed", error);
  }
  const apiError = error instanceof ApiError
    ? error
    : new ApiError(500, "internal_error", "Internal server error");
  return jsonResponse(
    { error: { code: apiError.code, message: apiError.message } },
    apiError.status,
    { "Set-Cookie": clearGitHubOAuthNonceCookie() },
  );
}

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
  try {
    const completed = await completeGitHubOAuth(context.request, context.env);
    const location = new URL(completed.returnTo, new URL(context.request.url).origin);
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      Location: location.toString(),
      "Referrer-Policy": "no-referrer",
    });
    headers.append("Set-Cookie", clearGitHubOAuthNonceCookie());
    headers.append("Set-Cookie", completed.sessionCookie);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return oauthErrorResponse(error);
  }
};
