import type { SpaceStorage } from "@polyth/contracts";
import { readJsonFile, spacePackageFile, writeJsonFile } from "./spaceJson.ts";

function stateFile(storage: SpaceStorage, packageId: string): string {
  return spacePackageFile(storage, packageId, "enabled.json");
}

export function readSpaceEnabled(storage: SpaceStorage, packageId: string): boolean {
  const parsed = readJsonFile<{ enabled?: unknown }>(stateFile(storage, packageId), {});
  return parsed.enabled === true;
}

export function writeSpaceEnabled(storage: SpaceStorage, packageId: string, enabled: boolean): void {
  writeJsonFile(stateFile(storage, packageId), { enabled });
}
