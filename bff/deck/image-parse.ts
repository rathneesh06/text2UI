// bff/deck/image-parse.ts — the Image/Asset Parser. Reads intrinsic metadata (format +
// pixel dimensions) straight from the file header bytes for PNG/JPEG/GIF/WebP — no image
// decoding library required. Dimensions matter because the renderer needs the aspect ratio
// to place an image without distorting it. Returns null for anything it can't read.
import type { Asset } from "../../shared/ingest";
import { createHash } from "crypto";

interface Dims { mime: string; width?: number; height?: number }

function pngDims(b: Uint8Array): Dims | null {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return null; // \x89PNG
  const dv = new DataView(b.buffer, b.byteOffset);
  return { mime: "image/png", width: dv.getUint32(16), height: dv.getUint32(20) };
}
function gifDims(b: Uint8Array): Dims | null {
  if (b.length < 10 || b[0] !== 0x47 || b[1] !== 0x49) return null; // GIF
  return { mime: "image/gif", width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
}
function jpegDims(b: Uint8Array): Dims | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null; // SOI
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { mime: "image/jpeg", height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len <= 0) break;
    i += 2 + len;
  }
  return { mime: "image/jpeg" };
}
function webpDims(b: Uint8Array): Dims | null {
  if (b.length < 30 || b[0] !== 0x52 || b[8] !== 0x57) return null; // RIFF....WEBP
  // VP8X / VP8 / VP8L — read the common VP8X canvas size when present
  const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (fourcc === "VP8X") return { mime: "image/webp", width: 1 + ((b[24] | (b[25] << 8) | (b[26] << 16)) & 0xffffff), height: 1 + ((b[27] | (b[28] << 8) | (b[29] << 16)) & 0xffffff) };
  return { mime: "image/webp" };
}

function readDims(bytes: Uint8Array): Dims | null {
  return pngDims(bytes) || jpegDims(bytes) || gifDims(bytes) || webpDims(bytes);
}

const extMime: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };
const extOf = (f: string) => { const i = f.lastIndexOf("."); return i >= 0 ? f.slice(i).toLowerCase() : ""; };

export function isImageFile(filename: string): boolean { return extOf(filename) in extMime; }

/** Parse an uploaded image into an Asset (metadata + embeddable data URL). Null if not an image. */
export function parseImage(bytes: Uint8Array, filename: string): Asset | null {
  if (!isImageFile(filename)) return null;
  const dims = readDims(bytes);
  const mime = dims?.mime ?? extMime[extOf(filename)] ?? "application/octet-stream";
  const b64 = Buffer.from(bytes).toString("base64");
  // Content-hash id: re-uploading the same image yields the same id, so an ImageBlock that
  // references it keeps resolving across edit turns (uploads are re-sent each request).
  const id = "img_" + createHash("sha1").update(bytes).digest("hex").slice(0, 16);
  return {
    id, kind: "image", mime, width: dims?.width, height: dims?.height,
    bytes: bytes.byteLength, dataUrl: `data:${mime};base64,${b64}`, name: filename,
  };
}