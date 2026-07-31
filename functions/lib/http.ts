import type { AuthenticatedUser, CloudSyncState, Env } from "./types";
import { authenticate, ensureUser } from "./auth";
import { ApiError } from "./errors";

export { ApiError } from "./errors";

const JSON_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

export function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

export function methodNotAllowed(allowed: string[]): Response {
  return jsonResponse(
    { error: { code: "method_not_allowed", message: "Method not allowed" } },
    405,
    { Allow: allowed.join(", ") },
  );
}

function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return jsonResponse(
      { error: { code: error.code, message: error.message } },
      error.status,
    );
  }
  console.error("Unhandled API error", error);
  return jsonResponse(
    { error: { code: "internal_error", message: "Internal server error" } },
    500,
  );
}

export async function handleAuthenticated(
  context: { request: Request; env: Env },
  handler: (
    user: AuthenticatedUser,
    syncState: CloudSyncState,
  ) => Promise<Response>,
  options: {
    allowSyncDisabled?: boolean;
    allowDeletionInProgress?: boolean;
    requireGeneration?: boolean;
  } = {},
): Promise<Response> {
  try {
    const user = await authenticate(context.request, context.env);
    const syncState = await ensureUser(context.env.DB, user, options);
    if (options.requireGeneration) {
      const value = context.request.headers.get("x-jiyibi-sync-generation")?.trim();
      if (!value || !/^[1-9]\d{0,15}$/.test(value) || Number(value) !== syncState.generation) {
        throw new ApiError(
          409,
          "stale_cloud_generation",
          "Cloud sync generation changed; explicitly enable sync on this device",
        );
      }
    }
    return await handler(user, syncState);
  } catch (error) {
    if (
      !(error instanceof ApiError) &&
      error instanceof Error &&
      error.message.includes("stale_cloud_generation")
    ) {
      return errorResponse(new ApiError(
        409,
        "stale_cloud_generation",
        "Cloud sync generation changed; explicitly enable sync on this device",
      ));
    }
    if (
      !(error instanceof ApiError) &&
      error instanceof Error &&
      error.message.includes("account_deletion_in_progress")
    ) {
      return errorResponse(new ApiError(
        409,
        "account_deletion_in_progress",
        "Cloud account deletion is in progress",
      ));
    }
    if (
      !(error instanceof ApiError) &&
      error instanceof Error &&
      error.message.includes("cloud_sync_not_enabled")
    ) {
      return errorResponse(new ApiError(
        409,
        "cloud_sync_disabled",
        "Cloud sync must be explicitly enabled",
      ));
    }
    return errorResponse(error);
  }
}

export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  const declaredSize = request.headers.get("content-length");
  if (declaredSize !== null) {
    const size = Number(declaredSize);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      throw new ApiError(413, "request_too_large", "Request body is too large");
    }
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new ApiError(413, "request_too_large", "Request body is too large");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON");
  }
}
