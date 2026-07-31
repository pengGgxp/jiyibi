export function attachmentGenerationPrefix(userId: string, generation: number): string {
  return `${userId}/g${generation}/`;
}

export function createAttachmentKey(
  userId: string,
  generation: number,
  attachmentId: string,
): string {
  return `${attachmentGenerationPrefix(userId, generation)}${attachmentId}/${crypto.randomUUID()}.jpg`;
}

export async function deleteAttachmentKeys(
  namespace: KVNamespace,
  keys: readonly string[],
): Promise<void> {
  await Promise.all(keys.map((key) => namespace.delete(key)));
}

export interface AttachmentKeyPage {
  keys: string[];
  cursor?: string;
  listComplete: boolean;
}

export async function listAttachmentKeys(
  namespace: KVNamespace,
  prefix: string,
  limit: number,
  cursor?: string,
): Promise<AttachmentKeyPage> {
  const result = await namespace.list({ prefix, limit, cursor });
  return {
    keys: result.keys.map((key) => key.name),
    cursor: result.list_complete ? undefined : result.cursor,
    listComplete: result.list_complete,
  };
}
