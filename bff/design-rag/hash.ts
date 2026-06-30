// bff/design-rag/hash.ts — the dedup key for the design corpus.
//
// phash() is a PERCEPTUAL hash: it decodes the PNG (pure JS via node:zlib — no
// native image lib, so no Windows/Linux binary hazard), downscales to a tiny
// grayscale grid, and computes a dHash. Visually near-identical screenshots get
// near-identical hashes, so dedup can catch them by Hamming distance (not exact
// equality). If decode fails for any reason, it falls back to a marked content
// hash ("c:"+sha256) and similarity treats that as exact-match-only — phash
// never throws.

import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

/** SHA-256 hex of the raw bytes. Exact (not perceptual). */
export function contentHash(png: Buffer): string {
  return createHash("sha256").update(png).digest("hex");
}

interface GrayImage { width: number; height: number; gray: Uint8Array; }

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode an 8-bit, non-interlaced PNG (gray/RGB/RGBA/palette) to grayscale.
 *  Returns null for anything unsupported (caller falls back to content hash). */
export function decodePngToGray(png: Buffer): GrayImage | null {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.length < 8) return null;
  for (let i = 0; i < 8; i++) if (png[i] !== SIG[i]) return null;

  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  let palette: Buffer | null = null;
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString("ascii", pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len; // length(4) + type(4) + data + crc(4)
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : colorType === 3 ? 1 : 0;
  if (!channels || (colorType === 3 && !palette)) return null;

  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  const out = Buffer.alloc(stride * height);
  const bpp = channels;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const v = raw[rowStart + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let val: number;
      switch (filter) {
        case 0: val = v; break;
        case 1: val = v + a; break;
        case 2: val = v + b; break;
        case 3: val = v + ((a + b) >> 1); break;
        case 4: val = v + paeth(a, b, c); break;
        default: return null;
      }
      out[y * stride + x] = val & 0xff;
    }
  }

  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * stride + x * channels;
      let r: number, g: number, b: number;
      if (colorType === 0 || colorType === 4) { r = g = b = out[i]; }
      else if (colorType === 3) { const idx = out[i]; r = palette![idx * 3]; g = palette![idx * 3 + 1]; b = palette![idx * 3 + 2]; }
      else { r = out[i]; g = out[i + 1]; b = out[i + 2]; }
      gray[y * width + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
  }
  return { width, height, gray };
}

function resizeGray(img: GrayImage, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / w));
      const sy = Math.min(img.height - 1, Math.floor((y * img.height) / h));
      out[y * w + x] = img.gray[sy * img.width + sx];
    }
  }
  return out;
}

/** Difference hash: 9x8 grayscale, compare adjacent pixels -> 64 bits -> 16 hex. */
export function dHash(img: GrayImage): string {
  const W = 9, H = 8;
  const small = resizeGray(img, W, H);
  const bytes = new Uint8Array(8);
  let bit = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      if (small[y * W + x] > small[y * W + x + 1]) bytes[bit >> 3] |= 1 << (7 - (bit & 7));
      bit++;
    }
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Perceptual hash with a graceful content-hash fallback (never throws). */
export function perceptualHash(png: Buffer): string {
  try { const img = decodePngToGray(png); if (img) return dHash(img); } catch { /* fall through */ }
  return "c:" + contentHash(png);
}

/** The dedup key stored in _design_refs.phash. */
export function phash(png: Buffer): string {
  return perceptualHash(png);
}

/** Bit difference between two equal-length hex hashes; Infinity if incomparable. */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    if (Number.isNaN(x)) return Infinity;
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/** Two hashes are "the same design" if equal, or perceptually within maxHamming.
 *  Content-hash fallbacks ("c:") only match exactly. */
export function isSimilarHash(a: string, b: string, maxHamming: number): boolean {
  if (a === b) return true;
  if (a.startsWith("c:") || b.startsWith("c:")) return false;
  return hamming(a, b) <= maxHamming;
}
