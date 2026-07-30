import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_IMAGE_DIMENSION,
  processImage,
} from "./image";

describe("processImage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects non-images before decoding", async () => {
    await expect(processImage(new Blob(["text"], { type: "text/plain" }))).rejects.toMatchObject({
      code: "not-image",
    });
  });

  it("re-encodes and constrains the longest dimension", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({
      width: 4096,
      height: 2048,
      close,
    }));
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
      fillRect: vi.fn(),
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type) => {
      callback(new Blob(["compressed"], { type: type ?? "image/jpeg" }));
    });

    const result = await processImage(new Blob(["source"], { type: "image/png" }));
    expect(result).toMatchObject({
      mimeType: "image/jpeg",
      width: MAX_IMAGE_DIMENSION,
      height: MAX_IMAGE_DIMENSION / 2,
    });
    expect(drawImage).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });
});
