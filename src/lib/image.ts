import type { ProcessedImage } from "../domain/types";

export const MAX_IMAGE_DIMENSION = 2048;
export const MAX_PROCESSED_IMAGE_BYTES = 1024 * 1024;
export const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;

export type ImageProcessingErrorCode =
  | "not-image"
  | "source-too-large"
  | "decode-failed"
  | "canvas-unavailable"
  | "encode-failed"
  | "output-too-large";

export class ImageProcessingError extends Error {
  constructor(message: string, public readonly code: ImageProcessingErrorCode) {
    super(message);
    this.name = "ImageProcessingError";
  }
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

async function decodeWithImageBitmap(blob: Blob): Promise<DecodedImage | undefined> {
  if (typeof createImageBitmap !== "function") return undefined;
  try {
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  } catch {
    return undefined;
  }
}

async function decodeWithImageElement(blob: Blob): Promise<DecodedImage> {
  if (typeof Image === "undefined" || typeof URL?.createObjectURL !== "function") {
    throw new ImageProcessingError("当前浏览器无法处理图片", "canvas-unavailable");
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch {
    URL.revokeObjectURL(url);
    throw new ImageProcessingError("无法读取这张图片", "decode-failed");
  }
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  if (typeof document === "undefined") {
    throw new ImageProcessingError("当前环境无法处理图片", "canvas-unavailable");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new ImageProcessingError("图片压缩失败", "encode-failed"));
    }, mimeType, quality);
  });
}

function fitWithin(width: number, height: number, maxDimension: number): [number, number] {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

export async function processImage(blob: Blob): Promise<ProcessedImage> {
  if (!blob.type.startsWith("image/")) {
    throw new ImageProcessingError("请选择图片文件", "not-image");
  }
  if (blob.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new ImageProcessingError("原图不能超过 25 MiB", "source-too-large");
  }

  const decoded = (await decodeWithImageBitmap(blob)) ?? (await decodeWithImageElement(blob));
  try {
    if (decoded.width < 1 || decoded.height < 1) {
      throw new ImageProcessingError("图片尺寸无效", "decode-failed");
    }

    let [width, height] = fitWithin(decoded.width, decoded.height, MAX_IMAGE_DIMENSION);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new ImageProcessingError("当前浏览器无法处理图片", "canvas-unavailable");
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(decoded.source, 0, 0, width, height);

    const outputType = "image/jpeg";
    let quality = 0.86;
    let output = await canvasToBlob(canvas, outputType, quality);

    while (output.size > MAX_PROCESSED_IMAGE_BYTES && quality > 0.46) {
      quality -= 0.1;
      output = await canvasToBlob(canvas, outputType, quality);
    }

    while (output.size > MAX_PROCESSED_IMAGE_BYTES && Math.max(width, height) > 640) {
      width = Math.max(1, Math.round(width * 0.8));
      height = Math.max(1, Math.round(height * 0.8));
      const resizedCanvas = createCanvas(width, height);
      const resizedContext = resizedCanvas.getContext("2d", { alpha: false });
      if (!resizedContext) {
        throw new ImageProcessingError("当前浏览器无法处理图片", "canvas-unavailable");
      }
      resizedContext.fillStyle = "#ffffff";
      resizedContext.fillRect(0, 0, width, height);
      resizedContext.drawImage(canvas, 0, 0, width, height);
      canvas.width = width;
      canvas.height = height;
      const finalContext = canvas.getContext("2d", { alpha: false });
      if (!finalContext) {
        throw new ImageProcessingError("当前浏览器无法处理图片", "canvas-unavailable");
      }
      finalContext.drawImage(resizedCanvas, 0, 0);
      output = await canvasToBlob(canvas, outputType, 0.58);
    }

    if (output.size > MAX_PROCESSED_IMAGE_BYTES) {
      throw new ImageProcessingError("图片压缩后仍然过大，请换一张图片", "output-too-large");
    }

    return {
      blob: output,
      mimeType: outputType,
      size: output.size,
      width,
      height,
    };
  } finally {
    decoded.close();
  }
}
