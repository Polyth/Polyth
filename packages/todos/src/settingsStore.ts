import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";
import { parseTodoRuleSettings, TODOS_PACKAGE_ID, type TodoRuleSettings } from "./rule.ts";

// The rule joins the deployment-wide global behavior (one text for every
// Space and harness), so its settings live in the shared package root rather
// than per-Space storage. Writes require instance-owner authority.

const VERSION = 1;

export interface TodoRuleSettingsState {
  revision: number;
  settings: TodoRuleSettings;
}

export interface TodoRuleSettingsStore {
  read(): TodoRuleSettingsState;
  save(settings: unknown, expectedRevision: number): TodoRuleSettingsState;
}

const unreadable = (message: string): Error => Object.assign(new Error(message), { code: "storage-unavailable" });

export function createTodoRuleSettingsStore(storageDir: string): TodoRuleSettingsStore {
  const file = join(storageDir, "packages", TODOS_PACKAGE_ID, "rule.json");
  let cached: TodoRuleSettingsState | undefined;

  const load = (): TodoRuleSettingsState => {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { revision: 0, settings: parseTodoRuleSettings(undefined) };
      throw cause;
    }
    const document = JSON.parse(raw) as { version?: unknown; revision?: unknown; settings?: unknown };
    if (!document || document.version !== VERSION || !Number.isSafeInteger(document.revision) || Number(document.revision) < 1) {
      throw unreadable("todo rule settings use an unsupported format");
    }
    return { revision: Number(document.revision), settings: parseTodoRuleSettings(document.settings) };
  };

  const read = (): TodoRuleSettingsState => {
    cached ??= load();
    return { revision: cached.revision, settings: { ...cached.settings } };
  };

  return {
    read,
    save(value, expectedRevision) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw Object.assign(new Error("expectedRevision must be a non-negative integer"), { code: "invalid-input" });
      }
      const settings = parseTodoRuleSettings(value);
      cached = undefined;
      const current = read();
      if (current.revision !== expectedRevision) {
        throw Object.assign(new Error("todo rule settings changed elsewhere"), { code: "conflict" });
      }
      if (current.settings.enabled === settings.enabled && current.settings.text === settings.text) return current;
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const next = { revision: current.revision + 1, settings };
      atomicWriteSync(file, JSON.stringify({ version: VERSION, ...next }, null, 2), 0o600);
      cached = next;
      return read();
    },
  };
}
