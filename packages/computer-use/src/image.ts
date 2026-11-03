import { crc32, deflateSync } from "node:zlib";
import { ComputerUseError } from "./errors.ts";
import type { Rect, Size } from "./types.ts";

/** Tightly packed 8-bit RGB pixels, row-major. */
export interface RgbImage extends Size {
  data: Uint8Array;
}

const chunk = (type: string, body: Uint8Array): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body, crc32(head.subarray(4))), 0);
  return Buffer.concat([head, body, crc]);
};

/** A minimal truecolor PNG with the Sub filter on every row; screenshots are
 * mostly flat colour, which that filter and zlib compress well. */
export const encodePng = (image: RgbImage): Buffer => {
  const { width, height, data } = image;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const out = y * (stride + 1);
    const row = y * stride;
    raw[out] = 1;
    for (let i = 0; i < stride; i += 1) {
      raw[out + 1 + i] = (data[row + i]! - (i >= 3 ? data[row + i - 3]! : 0)) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array()),
  ]);
};

/** Crops `region` and scales it to `output` by area averaging, so text stays
 * legible instead of aliasing the way nearest-neighbour sampling does. */
export const resample = (image: RgbImage, region: Rect, output: Size): RgbImage => {
  if (region.x < 0 || region.y < 0 || region.x + region.width > image.width || region.y + region.height > image.height) {
    throw new ComputerUseError("invalid-input", "region is outside the screen");
  }
  const { width, height } = output;
  const data = new Uint8Array(width * height * 3);
  const sx = region.width / width;
  const sy = region.height / height;
  // Precompute horizontal spans: first source column and per-column weights.
  const columns = Array.from({ length: width }, (_, x) => {
    const left = region.x + x * sx;
    const right = left + sx;
    const first = Math.floor(left);
    const last = Math.min(region.x + region.width, Math.ceil(right)) - 1;
    const weights: number[] = [];
    for (let c = first; c <= last; c += 1) weights.push(Math.min(right, c + 1) - Math.max(left, c));
    return { first, weights };
  });
  const accumulator = new Float64Array(width * 3);
  for (let y = 0; y < height; y += 1) {
    accumulator.fill(0);
    const top = region.y + y * sy;
    const bottom = top + sy;
    let total = 0;
    for (let r = Math.floor(top); r < Math.min(region.y + region.height, Math.ceil(bottom)); r += 1) {
      const wy = Math.min(bottom, r + 1) - Math.max(top, r);
      const rowOffset = r * image.width * 3;
      for (let x = 0; x < width; x += 1) {
        const { first, weights } = columns[x]!;
        let red = 0, green = 0, blue = 0;
        for (let i = 0; i < weights.length; i += 1) {
          const at = rowOffset + (first + i) * 3;
          const w = weights[i]!;
          red += image.data[at]! * w;
          green += image.data[at + 1]! * w;
          blue += image.data[at + 2]! * w;
        }
        const slot = x * 3;
        accumulator[slot] = accumulator[slot]! + red * wy;
        accumulator[slot + 1] = accumulator[slot + 1]! + green * wy;
        accumulator[slot + 2] = accumulator[slot + 2]! + blue * wy;
      }
      total += wy;
    }
    for (let x = 0; x < width; x += 1) {
      const area = total * columns[x]!.weights.reduce((sum, w) => sum + w, 0);
      const out = (y * width + x) * 3;
      data[out] = Math.round(accumulator[x * 3]! / area);
      data[out + 1] = Math.round(accumulator[x * 3 + 1]! / area);
      data[out + 2] = Math.round(accumulator[x * 3 + 2]! / area);
    }
  }
  return { width, height, data };
};

const XWD_FILE_VERSION = 7;
const Z_PIXMAP = 2;

/** Decodes the `xwd -root` dump of a TrueColor display (24 or 32 bits per
 * pixel, the depth every current X server uses). */
export const decodeXwd = (file: Buffer): RgbImage => {
  if (file.length < 100) throw new ComputerUseError("driver-failed", "xwd returned a truncated image");
  const header = (index: number) => file.readUInt32BE(index * 4);
  const headerSize = header(0);
  if (header(1) !== XWD_FILE_VERSION || header(2) !== Z_PIXMAP) {
    throw new ComputerUseError("driver-failed", "xwd returned an image format this tool does not read");
  }
  const width = header(4);
  const height = header(5);
  const byteOrder = header(7);
  const bitsPerPixel = header(11);
  const bytesPerLine = header(12);
  const redMask = header(14);
  const greenMask = header(15);
  const blueMask = header(16);
  // ncolors: the XWDColor records (12 bytes each) written after the header.
  const colormapEntries = header(19);
  if (bitsPerPixel !== 32 && bitsPerPixel !== 24) {
    throw new ComputerUseError("unsupported", `The X display uses ${bitsPerPixel}-bit pixels; only 24 and 32 bits are supported`);
  }
  const start = headerSize + colormapEntries * 12;
  if (file.length < start + bytesPerLine * height) throw new ComputerUseError("driver-failed", "xwd returned a truncated image");
  const shiftOf = (mask: number) => mask === 0 ? 0 : 31 - Math.clz32(mask & -mask);
  const channel = (mask: number) => {
    const shift = shiftOf(mask);
    const max = mask >>> shift;
    return (pixel: number) => max === 255 ? (pixel >>> shift) & 255 : Math.round((((pixel & mask) >>> shift) / max) * 255);
  };
  const red = channel(redMask);
  const green = channel(greenMask);
  const blue = channel(blueMask);
  const bytes = bitsPerPixel / 8;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const row = start + y * bytesPerLine;
    for (let x = 0; x < width; x += 1) {
      const at = row + x * bytes;
      let pixel = 0;
      // byteOrder 0 = LSBFirst.
      for (let b = 0; b < bytes; b += 1) {
        pixel |= file[at + b]! << (8 * (byteOrder === 0 ? b : bytes - 1 - b));
      }
      pixel >>>= 0;
      const out = (y * width + x) * 3;
      data[out] = red(pixel);
      data[out + 1] = green(pixel);
      data[out + 2] = blue(pixel);
    }
  }
  return { width, height, data };
};
