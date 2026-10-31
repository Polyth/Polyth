import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SpaceStorage } from "@polyth/contracts";
import { atomicWriteSync } from "./atomicWrite.ts";

export function spacePackageFile(storage: SpaceStorage, packageId: string, name: string): string {
  return join(storage.path(`packages/${packageId}`), name);
}

export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(path: string, data: unknown, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = typeof data === "string" ? data : JSON.stringify(data);
  atomicWriteSync(path, body, mode);
}
