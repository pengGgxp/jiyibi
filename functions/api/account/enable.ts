import { validateCloudSyncEnableRequest } from "../../lib/account";
import { enableCloudSync } from "../../lib/auth";
import {
  handleAuthenticated,
  jsonResponse,
  methodNotAllowed,
  readJsonBody,
} from "../../lib/http";
import type { Env } from "../../lib/types";

const MAX_ENABLE_BODY_BYTES = 256;

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== "POST") return methodNotAllowed(["POST"]);
  return handleAuthenticated(
    context,
    async (user) => {
      const generation = validateCloudSyncEnableRequest(
        await readJsonBody(context.request, MAX_ENABLE_BODY_BYTES),
      );
      const enabledGeneration = await enableCloudSync(
        context.env.DB,
        user,
        generation,
      );
      return jsonResponse({
        schemaVersion: 1,
        syncStatus: "enabled",
        generation: enabledGeneration,
      });
    },
    { allowSyncDisabled: true },
  );
};
