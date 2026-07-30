import { useCallback, useEffect, useState, type ClipboardEvent, type ChangeEvent } from "react";
import type { Attachment, ProcessedImage } from "../domain";
import { ImageProcessingError, processImage } from "../lib/image";
import { useObjectUrl } from "./useObjectUrl";

function imageErrorMessage(error: unknown): string {
  if (error instanceof ImageProcessingError) {
    switch (error.code) {
      case "not-image":
        return "请选择 JPG、PNG 或 WebP 图片";
      case "source-too-large":
        return "原图不能超过 25 MiB";
      case "output-too-large":
        return "压缩后仍然过大，请换一张图片";
      case "decode-failed":
        return "无法读取这张图片，请换一张重试";
      default:
        return "当前浏览器无法处理这张图片";
    }
  }
  return "图片处理失败，请换一张重试";
}

export interface ImageAttachmentState {
  image?: ProcessedImage;
  removeExistingImage: boolean;
  previewUrl?: string;
  hasImage: boolean;
  processing: boolean;
  error?: string;
  choose(event: ChangeEvent<HTMLInputElement>): Promise<void>;
  paste(event: ClipboardEvent<HTMLElement>): void;
  remove(): void;
  reset(): void;
}

export function useImageAttachment(existingAttachment?: Attachment): ImageAttachmentState {
  const [image, setImage] = useState<ProcessedImage>();
  const [removeExistingImage, setRemoveExistingImage] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string>();
  const previewUrl = useObjectUrl(
    image?.blob ?? (removeExistingImage ? undefined : existingAttachment?.blob),
  );

  const reset = useCallback(() => {
    setImage(undefined);
    setRemoveExistingImage(false);
    setError(undefined);
    setProcessing(false);
  }, []);

  useEffect(() => reset(), [existingAttachment?.id, reset]);

  const process = useCallback(async (blob: Blob) => {
    setProcessing(true);
    setError(undefined);
    try {
      setImage(await processImage(blob));
      setRemoveExistingImage(Boolean(existingAttachment));
    } catch (reason) {
      setError(imageErrorMessage(reason));
    } finally {
      setProcessing(false);
    }
  }, [existingAttachment]);

  const choose = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await process(file);
  }, [process]);

  const paste = useCallback((event: ClipboardEvent<HTMLElement>) => {
    const file = Array.from(event.clipboardData.files).find((candidate) =>
      candidate.type.startsWith("image/"),
    );
    if (file) void process(file);
  }, [process]);

  const remove = useCallback(() => {
    if (image) {
      setImage(undefined);
      setRemoveExistingImage(Boolean(existingAttachment));
    } else if (existingAttachment) {
      setRemoveExistingImage(true);
    }
    setError(undefined);
  }, [existingAttachment, image]);

  return {
    image,
    removeExistingImage,
    previewUrl,
    hasImage: Boolean(image || (existingAttachment && !removeExistingImage)),
    processing,
    error,
    choose,
    paste,
    remove,
    reset,
  };
}
