import { describe, expect, it } from "vitest";
import { ApiError } from "./errors";
import { validateSyncRequest } from "./validation";

function validRequest(): unknown {
  return {
    schemaVersion: 1,
    cursor: "0",
    mutations: [
      {
        id: "mutation_1",
        entityType: "entry",
        entityId: "entry_1",
        baseVersion: 0,
        payload: {
          id: "entry_1",
          amountMinor: -1250,
          note: "lunch",
          occurredAt: "2026-07-30T04:00:00.000Z",
          localDateKey: "2026-07-30",
          localMonthKey: "2026-07",
          timezoneOffsetMinutes: -480,
          createdAt: "2026-07-30T04:01:00.000Z",
          updatedAt: "2026-07-30T04:01:00.000Z",
        },
      },
    ],
  };
}

describe("validateSyncRequest", () => {
  it("accepts a strict version-one entry mutation", () => {
    expect(validateSyncRequest(validRequest())).toMatchObject({
      schemaVersion: 1,
      cursor: "0",
      mutations: [{ entityType: "entry", entityId: "entry_1" }],
    });
  });

  it("rejects unknown fields", () => {
    const request = validRequest() as Record<string, unknown>;
    request.unexpected = true;
    expect(() => validateSyncRequest(request)).toThrowError(ApiError);
  });

  it("rejects a local date that disagrees with the stored timezone", () => {
    const request = validRequest() as {
      mutations: Array<{ payload: Record<string, unknown> }>;
    };
    request.mutations[0].payload.localDateKey = "2026-07-29";
    expect(() => validateSyncRequest(request)).toThrowError("Entry payload is invalid");
  });

  it("rejects non-canonical or out-of-range cursors", () => {
    const request = validRequest() as Record<string, unknown>;
    request.cursor = "01";
    expect(() => validateSyncRequest(request)).toThrowError("decimal string");
    request.cursor = "9223372036854775808";
    expect(() => validateSyncRequest(request)).toThrowError("decimal string");
  });

  it("rejects duplicate mutation IDs before applying writes", () => {
    const request = validRequest() as { mutations: unknown[] };
    request.mutations.push(structuredClone(request.mutations[0]));
    expect(() => validateSyncRequest(request)).toThrowError("must be unique");
  });

  it("rejects multiple version steps for the same entity in one request", () => {
    const request = validRequest() as {
      mutations: Array<{
        id: string;
        baseVersion: number;
        payload: Record<string, unknown>;
      }>;
    };
    const second = structuredClone(request.mutations[0]);
    second.id = "mutation_2";
    second.baseVersion = 1;
    second.payload.note = "second edit";
    request.mutations.push(second);

    expect(() => validateSyncRequest(request)).toThrowError(
      "At most one mutation per entity",
    );
  });

  it("accepts a create-then-delete tombstone without requiring its local attachment", () => {
    const request = validRequest() as {
      mutations: Array<{ payload: Record<string, unknown> }>;
    };
    request.mutations[0].payload.note = "";
    request.mutations[0].payload.attachmentId = "attachment_local_only";
    request.mutations[0].payload.deletedAt = "2026-07-30T04:01:00.000Z";
    const parsed = validateSyncRequest(request);
    expect(parsed.mutations[0].payload).not.toHaveProperty("attachmentId");
  });
});
