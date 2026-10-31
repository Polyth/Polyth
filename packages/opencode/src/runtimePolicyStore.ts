import { mkdirSync, readFileSync } from "node:fs";
import { DEFAULT_OPENCODE_RUNTIME_POLICY, type OpenCodeRuntimePolicyStateDto, type SpaceContext, type SpaceStorage } from "@polyth/contracts";
import { atomicWriteSync } from "@polyth/plugins";
import { parseOpenCodeRuntimePolicy } from "./runtimePolicy.ts";

const DIRECTORY = "packages/opencode";
const FILE = `${DIRECTORY}/runtime-policy.json`;
const unavailable = (): Error => Object.assign(new Error("OpenCode runtime policy storage is unavailable"), { code: "storage-unavailable" });

export function createOpenCodeRuntimePolicyStore(storageFor: (space: SpaceContext) => SpaceStorage) {
  const read = (space: SpaceContext): OpenCodeRuntimePolicyStateDto => {
    let path: string;
    try { path = storageFor(space).path(FILE); } catch { throw unavailable(); }
    try {
      const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (document?.version !== 1 || !Number.isSafeInteger(document.revision) || Number(document.revision) < 1) throw unavailable();
      return { revision: Number(document.revision), settings: parseOpenCodeRuntimePolicy(document.settings) };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { revision: 0, settings: { ...DEFAULT_OPENCODE_RUNTIME_POLICY } };
      }
      throw unavailable();
    }
  };
  return {
    read,
    save(space: SpaceContext, value: unknown, expectedRevision: unknown): OpenCodeRuntimePolicyStateDto {
      if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) {
        throw Object.assign(new Error("expectedRevision must be a non-negative integer"), { code: "invalid-input" });
      }
      const settings = parseOpenCodeRuntimePolicy(value);
      const current = read(space);
      if (current.revision !== expectedRevision) throw Object.assign(new Error("OpenCode runtime policy changed in another window"), { code: "conflict" });
      if (current.settings.mode === settings.mode && current.settings.idleTtlMinutes === settings.idleTtlMinutes && current.settings.maxWarmWorkspaces === settings.maxWarmWorkspaces) return current;
      const revision = current.revision + 1;
      try {
        const storage = storageFor(space);
        const directory = storage.path(DIRECTORY);
        const path = storage.path(FILE);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        atomicWriteSync(path, JSON.stringify({ version: 1, revision, settings }), 0o600);
      } catch { throw unavailable(); }
      return { revision, settings };
    },
  };
}
