import { describe, expect, it } from "vitest";
import { onRequest } from "./account";

describe("account endpoint", () => {
  it("rejects non-DELETE requests before authentication", async () => {
    const request = new Request("https://jiyibi.pages.dev/api/account", {
      method: "POST",
    });
    const response = await onRequest({ request } as Parameters<typeof onRequest>[0]);

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("DELETE");
    await expect(response.json()).resolves.toEqual({
      error: { code: "method_not_allowed", message: "Method not allowed" },
    });
  });
});
