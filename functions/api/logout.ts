import { clearGitHubSessionCookie, revokeGitHubSession } from "../lib/auth";
import { jsonResponse, methodNotAllowed } from "../lib/http";
import type { Env } from "../lib/types";
import { safeReturnUrl } from "./login";

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== "GET") return methodNotAllowed(["GET"]);
  try {
    await revokeGitHubSession(context.request, context.env);
    const returnUrl = safeReturnUrl(context.request);
    let location = returnUrl.toString();
    if (context.request.headers.get("Cf-Access-Jwt-Assertion")?.trim()) {
      const accessLogout = new URL("/cdn-cgi/access/logout", new URL(context.request.url).origin);
      accessLogout.searchParams.set("returnTo", returnUrl.toString());
      location = accessLogout.toString();
    }
    return new Response(null, {
      status: 302,
      headers: {
        "Cache-Control": "private, no-store",
        Location: location,
        "Referrer-Policy": "no-referrer",
        "Set-Cookie": clearGitHubSessionCookie(),
      },
    });
  } catch (error) {
    console.error("Logout failed", error);
    return jsonResponse(
      { error: { code: "internal_error", message: "Internal server error" } },
      500,
    );
  }
};
