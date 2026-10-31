import { readFileSync } from "node:fs";
import type { SpaceContext, SpaceStorage } from "@polyth/contracts";
import { atomicWriteSync } from "@polyth/plugins";
import { parseCommitSettings, type CommitSettings } from "./commitSettings.ts";

export function createCommitSettingsStore(storageFor: (space: SpaceContext) => SpaceStorage) {
  const read = (space: SpaceContext): { revision: number; settings: CommitSettings } => {
    try {
      const value = JSON.parse(readFileSync(`${storageFor(space).packageDir("git")}/commit-settings.json`, "utf8"));
      if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Invalid commit settings revision");
      return { revision: value.revision, settings: parseCommitSettings(value.settings) };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { revision: 0, settings: { mode: "session" } };
      throw cause;
    }
  };
  return { read, save(space: SpaceContext, input: unknown, expectedRevision: number) {
    const settings = parseCommitSettings(input);
    const current = read(space);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw Object.assign(new Error("Invalid revision"), { code: "invalid-input" });
    if (current.revision !== expectedRevision) throw Object.assign(new Error("Commit settings changed elsewhere. Reload settings."), { code: "conflict" });
    const next = { revision: current.revision + 1, settings };
    atomicWriteSync(`${storageFor(space).packageDir("git")}/commit-settings.json`, JSON.stringify(next), 0o600);
    return next;
  } };
}
