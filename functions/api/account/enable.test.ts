import { describe, expect, it } from "vitest";
import { onRequest } from "./enable";

describe("cloud sync enable endpoint", () => {
  it("rejects non-POST requests before authentication", async () => {
    const request = new Request("https://jiyibi.pages.dev/api/account/enable", {
      method: "PUT",
    });
    const response = await onRequest({ request } as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    await expect(response.json()).resolves.toEqual({
      error: { code: "method_not_allowed", message: "Method not allowed" },
    });
  });
});
