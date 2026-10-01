/**
 * Image attachments for user messages.
 *
 * The panel lets a user paste (or drop) a screenshot into the composer; the
 * bytes travel to the core as a data URL, are normalised here once, and are
 * then handed to whichever provider is configured. Keeping the validation in
 * `src/core` means the CLI and the tests exercise exactly the same rules as the
 * editor, and that a malformed paste is rejected before it ever reaches an API.
 */

import type { ChatMessage, ImageAttachment } from './types';

/** Formats every supported vision backend understands. */
export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** Per-image ceiling on the decoded bytes (providers reject much more). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Ceiling on images attached to a single message. */
export const MAX_IMAGES_PER_MESSAGE = 8;

/**
 * Rough token cost of one image. Real cost depends on the resolution and the
 * provider's tiling, but the context meter only needs the right order of
 * magnitude — ignoring images entirely was the bigger error.
 */
export const IMAGE_TOKEN_ESTIMATE = 800;

export interface ImageParseError {
  /** Index in the caller's input, so the UI can say which paste failed. */
  index: number;
  name?: string;
  reason: string;
}

export interface NormalizeResult {
  images: ImageAttachment[];
  errors: ImageParseError[];
}

/** Anything the UI layers may hand us for a single attachment. */
export type RawImageInput =
  | string
  | {
      dataUrl?: string;
      data?: string;
      mediaType?: string;
      mimeType?: string;
      type?: string;
      name?: string;
    };

export function isSupportedImageType(mediaType: string): boolean {
  return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(mediaType.toLowerCase());
}

/** Decoded byte length of a base64 payload, without allocating a Buffer. */
export function base64Bytes(data: string): number {
  const clean = data.replace(/\s+/g, '');
  if (!clean) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

const DATA_URL = /^data:([a-z0-9.+/-]+);base64,([\s\S]*)$/i;
const BASE64 = /^[A-Za-z0-9+/\r\n]+={0,2}$/;

/** Split `data:image/png;base64,AAA…` into its parts. */
export function parseDataUrl(value: string): { mediaType: string; data: string } | undefined {
  const match = DATA_URL.exec(value.trim());
  if (!match) return undefined;
  return { mediaType: match[1].toLowerCase(), data: match[2].replace(/\s+/g, '') };
}

/** `data:` URL for an attachment, for display in the webview. */
export function toDataUrl(image: ImageAttachment): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

/**
 * Validate and canonicalise one attachment. Returns `undefined` plus a reason
 * instead of throwing, because one bad paste should not drop the others.
 */
export function normalizeImage(raw: RawImageInput): { image?: ImageAttachment; reason?: string } {
  if (!raw) return { reason: 'empty attachment' };

  let mediaType: string | undefined;
  let data: string | undefined;
  let name: string | undefined;

  if (typeof raw === 'string') {
    const parsed = parseDataUrl(raw);
    if (!parsed) return { reason: 'not a base64 data URL' };
    mediaType = parsed.mediaType;
    data = parsed.data;
  } else {
    name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 120) : undefined;
    if (typeof raw.dataUrl === 'string' && raw.dataUrl) {
      const parsed = parseDataUrl(raw.dataUrl);
      if (!parsed) return { reason: 'not a base64 data URL' };
      mediaType = parsed.mediaType;
      data = parsed.data;
    } else if (typeof raw.data === 'string' && raw.data) {
      const parsed = parseDataUrl(raw.data);
      if (parsed) {
        mediaType = parsed.mediaType;
        data = parsed.data;
      } else {
        data = raw.data.replace(/\s+/g, '');
      }
    }
    mediaType = (raw.mediaType || raw.mimeType || raw.type || mediaType || '').toLowerCase() || undefined;
  }

  if (!data) return { reason: 'no image data' };
  if (!mediaType) return { reason: 'unknown image type' };
  if (!isSupportedImageType(mediaType)) {
    return { reason: `unsupported image type ${mediaType} (use PNG, JPEG, GIF or WebP)` };
  }
  if (!BASE64.test(data)) return { reason: 'image data is not valid base64' };

  const bytes = base64Bytes(data);
  if (bytes <= 0) return { reason: 'image is empty' };
  if (bytes > MAX_IMAGE_BYTES) {
    return { reason: `image is ${formatBytes(bytes)}, over the ${formatBytes(MAX_IMAGE_BYTES)} limit` };
  }

  return { image: { mediaType, data, bytes, ...(name ? { name } : {}) } };
}

/** Normalise a whole paste batch, capping it at {@link MAX_IMAGES_PER_MESSAGE}. */
export function normalizeImages(raws: readonly RawImageInput[] | undefined): NormalizeResult {
  const images: ImageAttachment[] = [];
  const errors: ImageParseError[] = [];
  if (!raws?.length) return { images, errors };

  raws.forEach((raw, index) => {
    if (images.length >= MAX_IMAGES_PER_MESSAGE) {
      errors.push({ index, reason: `only ${MAX_IMAGES_PER_MESSAGE} images can be attached to one message` });
      return;
    }
    const { image, reason } = normalizeImage(raw);
    if (image) images.push(image);
    else errors.push({ index, name: typeof raw === 'object' ? raw?.name : undefined, reason: reason ?? 'invalid image' });
  });

  return { images, errors };
}

/** Token estimate for the images carried by a message. */
export function estimateImageTokens(message: Pick<ChatMessage, 'images'>): number {
  return (message.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE;
}

/**
 * Text stand-in used when the model cannot see images (mock provider, or a
 * text-only endpoint): the prompt still mentions that something was attached,
 * which is far less confusing than silently dropping it.
 */
export function describeImages(images: readonly ImageAttachment[] | undefined): string {
  if (!images?.length) return '';
  const parts = images.map((img, i) => `${img.name || `image ${i + 1}`} (${img.mediaType}, ${formatBytes(img.bytes ?? base64Bytes(img.data))})`);
  return `[${images.length} attached image${images.length === 1 ? '' : 's'}: ${parts.join('; ')}]`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
