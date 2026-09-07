import { existsSync } from "node:fs";
import type { SpaceStorage } from "@polyth/contracts";
import { readJsonFile, spacePackageFile, writeJsonFile } from "./spaceJson.ts";

const KEY = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_VALUE = 8 * 1024;
const MAX_TOTAL = 64 * 1024;

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

const fileOf = (storage: SpaceStorage, packageId: string): string =>
  spacePackageFile(storage, packageId, "kv.json");

function load(storage: SpaceStorage, packageId: string): Record<string, string> {
  const parsed = readJsonFile<Record<string, unknown>>(fileOf(storage, packageId), {});
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function save(storage: SpaceStorage, packageId: string, data: Record<string, string>): void {
  const serialized = JSON.stringify(data);
  if (serialized.length > MAX_TOTAL) fail("INVALID_REQUEST", "package storage quota exceeded");
  writeJsonFile(fileOf(storage, packageId), data);
}

export function kvGet(storage: SpaceStorage, packageId: string, key: string): string | null {
  if (!KEY.test(key)) fail("INVALID_REQUEST", "storage key is invalid");
  return load(storage, packageId)[key] ?? null;
}

export function kvSet(storage: SpaceStorage, packageId: string, key: string, value: string): void {
  if (!KEY.test(key)) fail("INVALID_REQUEST", "storage key is invalid");
  if (typeof value !== "string") fail("INVALID_REQUEST", "storage value must be a string");
  if (value.length > MAX_VALUE) fail("INVALID_REQUEST", "storage value exceeds limit");
  const data = load(storage, packageId);
  data[key] = value;
  save(storage, packageId, data);
}

export function kvDelete(storage: SpaceStorage, packageId: string, key: string): void {
  if (!KEY.test(key)) fail("INVALID_REQUEST", "storage key is invalid");
  const data = load(storage, packageId);
  delete data[key];
  save(storage, packageId, data);
}

export function kvClear(storage: SpaceStorage, packageId: string): void {
  const file = fileOf(storage, packageId);
  if (existsSync(file)) writeJsonFile(file, {});
}
