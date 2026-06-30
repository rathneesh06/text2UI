// bff/design-rag/hash.test.ts — offline. Encodes real PNGs to validate decode.
import assert from "node:assert";
import { deflateSync } from "node:zlib";
import { decodePngToGray, dHash, perceptualHash, phash, hamming, isSimilarHash, contentHash } from "./hash";

// ---- minimal PNG encoder (RGBA, 8-bit) for fixtures ------------------------
function crc32(buf: Buffer): number {
  let c = ~0 >>> 0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = px(x, y); const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ---- decode: dimensions + grayscale of known pixels ------------------------
{
  const img = decodePngToGray(encodePng(4, 3, (x) => (x === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255])));
  assert.ok(img, "valid PNG decodes");
  assert.equal(img!.width, 4); assert.equal(img!.height, 3);
  assert.equal(img!.gray[0], 0, "black pixel -> 0");
  assert.equal(img!.gray[1], 255, "white pixel -> 255");
  assert.equal(decodePngToGray(Buffer.from("not a png")), null, "garbage -> null");
}

// ---- dHash: deterministic, 16-hex, direction-sensitive ---------------------
{
  const gradLR = encodePng(16, 16, (x) => { const v = Math.round((x / 15) * 255); return [v, v, v, 255]; });
  const gradRL = encodePng(16, 16, (x) => { const v = Math.round(((15 - x) / 15) * 255); return [v, v, v, 255]; });
  const hL = dHash(decodePngToGray(gradLR)!);
  const hL2 = dHash(decodePngToGray(gradLR)!);
  const hR = dHash(decodePngToGray(gradRL)!);
  assert.match(hL, /^[0-9a-f]{16}$/, "16-hex (64-bit) dHash");
  assert.equal(hL, hL2, "deterministic");
  assert.ok(hamming(hL, hR) > 30, `opposite gradients are far apart (got ${hamming(hL, hR)})`);
}

// ---- hamming + isSimilarHash on literal hashes -----------------------------
{
  assert.equal(hamming("0000000000000000", "0000000000000001"), 1, "1-bit difference");
  assert.equal(hamming("00", "0000"), Infinity, "length mismatch -> Infinity");
  assert.ok(isSimilarHash("00000000000000ff", "00000000000000fe", 5), "1 bit within 5 -> similar");
  assert.ok(!isSimilarHash("0000000000000000", "00000000000003ff", 5), "10 bits beyond 5 -> not similar");
  assert.ok(isSimilarHash("abc", "abc", 5), "identical -> similar");
  assert.ok(!isSimilarHash("c:deadbeef", "c:deadbef0", 5), "content-hash fallback -> exact only");
  assert.ok(isSimilarHash("c:deadbeef", "c:deadbeef", 5), "identical content hashes match");
}

// ---- perceptualHash fallback + phash determinism ---------------------------
{
  const png = encodePng(8, 8, () => [120, 120, 120, 255]);
  assert.match(perceptualHash(png), /^[0-9a-f]{16}$/, "PNG -> perceptual hash");
  const junk = Buffer.from("design-A");
  assert.ok(perceptualHash(junk).startsWith("c:"), "non-PNG -> content-hash fallback");
  assert.equal(perceptualHash(junk), "c:" + contentHash(junk), "fallback = c:+sha256");
  assert.equal(phash(junk), phash(Buffer.from("design-A")), "deterministic");
  assert.notEqual(phash(junk), phash(Buffer.from("design-B")), "different inputs differ");
}

console.log("ok design-rag/hash");
