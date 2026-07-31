import {
  handleAuthenticated,
  jsonResponse,
  methodNotAllowed,
  readJsonBody,
} from "../lib/http";
import { synchronize } from "../lib/sync";
import type { Env } from "../lib/types";
import {
  MAX_SYNC_BODY_BYTES,
  validateSyncRequest,
} from "../lib/validation";

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
  return handleAuthenticated(context, async (user, syncState) => {
    const body = validateSyncRequest(
      await readJsonBody(context.request, MAX_SYNC_BODY_BYTES),
    );
    return jsonResponse(await synchronize(
      context.env,
      user.id,
      syncState.generation,
      body,
    ));
  }, { requireGeneration: true });
};
