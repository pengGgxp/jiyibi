import { getAttachment, putAttachment } from "../../lib/attachments";
import { ApiError, handleAuthenticated, methodNotAllowed } from "../../lib/http";
import type { Env } from "../../lib/types";
import { isValidId } from "../../lib/validation";

function attachmentIdFromParams(value: string | string[]): string {
  if (typeof value !== "string" || !isValidId(value)) {
    throw new ApiError(400, "invalid_attachment_id", "Attachment ID is invalid");
  }
  return value;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== "GET" && context.request.method !== "PUT") {
    return methodNotAllowed(["GET", "PUT"]);
  }
  return handleAuthenticated(context, async (user, syncState) => {
    const attachmentId = attachmentIdFromParams(context.params.id);
    return context.request.method === "GET"
      ? getAttachment(context.env, user, syncState.generation, attachmentId)
      : putAttachment(
          context.request,
          context.env,
          user,
          syncState.generation,
          attachmentId,
        );
  }, { requireGeneration: true });
};
