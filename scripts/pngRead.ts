// Dependency-free PNG reader for tests: header facts and decoded RGBA pixels
// for the non-interlaced 8-bit PNGs the release icon generators write. Release
// tools (sharp) are not installed in the ordinary root tree, so the checked-in
// icons are verified with this instead.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

export interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  /** PNG colour type: 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA. */
  colorType: number;
  interlace: number;
}

const SIGNATURE = "89504e470d0a1a0a";

function chunks(file: Buffer): Array<{ type: string; data: Buffer }> {
  if (file.subarray(0, 8).toString("hex") !== SIGNATURE) throw new Error("not a PNG");
  const out: Array<{ type: string; data: Buffer }> = [];
  for (let at = 8; at + 8 <= file.length; ) {
    const length = file.readUInt32BE(at);
    out.push({ type: file.toString("latin1", at + 4, at + 8), data: file.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return out;
}

export function readPngInfo(path: string): PngInfo {
  const header = chunks(readFileSync(path)).find((chunk) => chunk.type === "IHDR");
  if (!header) throw new Error(`no IHDR in ${path}`);
  return {
    width: header.data.readUInt32BE(0),
    height: header.data.readUInt32BE(4),
    bitDepth: header.data[8]!,
    colorType: header.data[9]!,
    interlace: header.data[12]!,
  };
}

/** True when the colour type carries an alpha channel (or a palette, which may). */
export function hasAlpha(info: PngInfo): boolean {
  return info.colorType === 4 || info.colorType === 6 || info.colorType === 3;
}

/** Decode to RGBA (8 bits per channel). Supports 8-bit grey/RGB/palette/grey+alpha/RGBA, non-interlaced. */
export function readPngRgba(path: string): { width: number; height: number; data: Uint8Array } {
  const file = readFileSync(path);
  const info = readPngInfo(path);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[info.colorType];
  if (info.bitDepth !== 8 || !channels || info.interlace !== 0) {
    throw new Error(`unsupported PNG layout in ${path}: ${JSON.stringify(info)}`);
  }
  const raw = inflateSync(Buffer.concat(chunks(file).filter((c) => c.type === "IDAT").map((c) => c.data)));
  const stride = info.width * channels;
  const pixels = new Uint8Array(stride * info.height);
  for (let y = 0; y < info.height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const line = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[y * stride + x] = (raw[line + x]! + predictor) & 0xff;
    }
  }
  const parts = chunks(file);
  const palette = parts.find((c) => c.type === "PLTE")?.data;
  const transparency = parts.find((c) => c.type === "tRNS")?.data;
  const data = new Uint8Array(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i += 1) {
    const s = i * channels;
    const d = i * 4;
    if (info.colorType === 3) {
      if (!palette) throw new Error(`palette PNG without PLTE: ${path}`);
      const index = pixels[s]!;
      data[d] = palette[index * 3]!;
      data[d + 1] = palette[index * 3 + 1]!;
      data[d + 2] = palette[index * 3 + 2]!;
      data[d + 3] = transparency && index < transparency.length ? transparency[index]! : 255;
    } else if (channels === 1 || channels === 2) {
      data[d] = data[d + 1] = data[d + 2] = pixels[s]!;
      data[d + 3] = channels === 2 ? pixels[s + 1]! : 255;
    } else {
      data[d] = pixels[s]!;
      data[d + 1] = pixels[s + 1]!;
      data[d + 2] = pixels[s + 2]!;
      data[d + 3] = channels === 4 ? pixels[s + 3]! : 255;
    }
  }
  return { width: info.width, height: info.height, data };
}

/** Bounding box of opaque pixels (alpha > 8) in an RGBA image, or null. */
export function opaqueBox(image: { width: number; height: number; data: Uint8Array }) {
  let top = image.height;
  let bottom = -1;
  let left = image.width;
  let right = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3]! > 8) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
  }
  if (bottom < top || right < left) return null;
  return { left, top, width: right - left + 1, height: bottom - top + 1, size: image.width };
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
