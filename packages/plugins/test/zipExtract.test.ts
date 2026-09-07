import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { packDirectory } from "@polyth/package-sdk/manifest";

import { extractZipBuffer } from "../src/zipExtract.ts";

const u16 = (value: number) => {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value);
  return buf;
};
const u32 = (value: number) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
};

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function zipFromEntries(entries: Array<{
  name: string;
  data: Buffer;
  flags?: number;
  method?: number;
  compressed?: Buffer;
  versionMadeBy?: number;
  externalAttr?: number;
  uncompressedSize?: number;
}>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const method = entry.method ?? 0;
    const payload = entry.compressed ?? entry.data;
    const flags = entry.flags ?? 0;
    const uncompressed = entry.uncompressedSize ?? entry.data.length;
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(crc32(entry.data)), u32(payload.length), u32(uncompressed),
      u16(name.length), u16(0), name, payload,
    ]);
    const central = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      u16(entry.versionMadeBy ?? 20), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(crc32(entry.data)), u32(payload.length), u32(uncompressed),
      u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32(entry.externalAttr ?? 0), u32(offset), name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  return Buffer.concat([
    ...locals,
    central,
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(offset), u16(0),
  ]);
}

test("zip extract round-trips a packed package and rejects traversal", async () => {
  const dest = mkdtempSync(join(tmpdir(), "polyth-zip-ok-"));
  const packed = await packDirectory(join(import.meta.dirname, "../../../examples/hello-package"));
  const files = await extractZipBuffer(packed, dest);
  assert.ok(files.some((name) => name.endsWith("polyth-package.json")));
  assert.match(readFileSync(join(dest, "polyth-package.json"), "utf8"), /com-example-hello/);
  rmSync(dest, { recursive: true, force: true });

  const bad = mkdtempSync(join(tmpdir(), "polyth-zip-bad-"));
  for (const name of ["../secret.txt", "..\\windows.txt", "/tmp/abs.txt", "C:/abs.txt"]) {
    await assert.rejects(
      () => extractZipBuffer(zipFromEntries([{ name, data: Buffer.from("x") }]), bad),
      /unsafe|invalid|absolute path/i,
    );
  }
  rmSync(bad, { recursive: true, force: true });
});

test("zip extract rejects encrypted entries, symlinks, bombs, and huge file counts", async () => {
  const dest = mkdtempSync(join(tmpdir(), "polyth-zip-adv-"));
  await assert.rejects(
    () => extractZipBuffer(zipFromEntries([{ name: "a.txt", data: Buffer.from("x"), flags: 0x0001 }]), dest),
    /encrypted|mismatch/,
  );
  await assert.rejects(
    () => extractZipBuffer(zipFromEntries([{
      name: "link",
      data: Buffer.from("target"),
      versionMadeBy: 3 << 8,
      externalAttr: (0o120000 << 16) >>> 0,
    }]), dest),
    /symlink/,
  );
  const zeros = Buffer.alloc(2 * 1024 * 1024);
  const packed = deflateRawSync(zeros, { level: 9 });
  assert.ok(zeros.length / packed.length > 100);
  await assert.rejects(
    () => extractZipBuffer(zipFromEntries([{
      name: "bomb.bin",
      data: zeros,
      method: 8,
      compressed: packed,
    }]), dest),
    /ratio|uncompressed/,
  );
  const many = Array.from({ length: 513 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from("x") }));
  await assert.rejects(() => extractZipBuffer(zipFromEntries(many), dest), /too many files/);
  rmSync(dest, { recursive: true, force: true });
});

test("zip extract aborts when actual output bytes disagree with size metadata", async () => {
  const dest = mkdtempSync(join(tmpdir(), "polyth-zip-lie-"));
  const data = Buffer.alloc(64 * 1024, 7);
  await assert.rejects(
    () => extractZipBuffer(zipFromEntries([{
      name: "payload.bin",
      data,
      uncompressedSize: 16,
    }]), dest),
    /invalid|size|uncompressed|crc/i,
  );
  await assert.rejects(
    () => extractZipBuffer(zipFromEntries([{
      name: "huge.bin",
      data: Buffer.alloc(33 * 1024 * 1024, 1),
    }]), dest),
    /uncompressed size exceeds limit/,
  );
  rmSync(dest, { recursive: true, force: true });
});
