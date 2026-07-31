import {
  handleAuthenticated,
  jsonResponse,
  methodNotAllowed,
  readJsonBody,
} from "../lib/http";
import {
  deleteCloudAccountData,
  validateAccountDeletionRequest,
} from "../lib/account";
import type { Env } from "../lib/types";

const MAX_DELETE_ACCOUNT_BODY_BYTES = 256;

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== "DELETE") return methodNotAllowed(["DELETE"]);
  return handleAuthenticated(
    context,
    async (user) => {
      const generation = validateAccountDeletionRequest(
        await readJsonBody(context.request, MAX_DELETE_ACCOUNT_BODY_BYTES),
      );
      const result = await deleteCloudAccountData(context.env, user.id, generation);
      return jsonResponse({
        schemaVersion: 1,
        ...result,
      }, result.complete ? 200 : 202, result.complete ? undefined : { "Retry-After": "5" });
    },
    { allowSyncDisabled: true, allowDeletionInProgress: true },
  );
};
