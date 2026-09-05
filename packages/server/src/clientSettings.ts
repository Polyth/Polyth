// Server-persisted client preferences (`data/client-settings.json`). The web
// client owns the schema — Appearance, chat, notification, and UI-preference
// records travel together as one opaque JSON object so every device that talks
// to this server paints with the same look. Writes are last-write-wins with a
// monotonic revision: clients drop the WS echo of their own change and ignore
// any broadcast whose revision they already hold.
import { mkdirSync, readFileSync } from "node:fs";
import { atomicWriteSync } from "./atomicWrite.ts";
import { dirname } from "node:path";
import type { ClientSettingsDto } from "@polyth/contracts";

/** Generous ceiling: the real payload is a few KB. Guards against a client
 *  streaming junk into the shared file. */
const MAX_BYTES = 256 * 1024;

export interface ClientSettingsService {
  get(): ClientSettingsDto;
  put(settings: unknown): ClientSettingsDto;
}

const invalid = (message: string): Error =>
  Object.assign(new Error(message), { code: "invalid-input" });

const empty = (): ClientSettingsDto => ({ revision: 0, updatedAt: 0, settings: {} });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createClientSettings(opts: { file: string }): ClientSettingsService {
  mkdirSync(dirname(opts.file), { recursive: true });

  let current: ClientSettingsDto = empty();
  try {
    const raw = JSON.parse(readFileSync(opts.file, "utf8")) as Partial<ClientSettingsDto>;
    if (isPlainObject(raw.settings)) {
      current = {
        revision: Number.isFinite(raw.revision) ? Math.max(0, Math.trunc(raw.revision as number)) : 1,
        updatedAt: Number.isFinite(raw.updatedAt) ? (raw.updatedAt as number) : Date.now(),
        settings: raw.settings,
      };
    }
  } catch {
    // first run, or a hand-mangled file — start from an empty record
  }

  return {
    get: () => ({ ...current }),
    put(settings) {
      if (!isPlainObject(settings)) throw invalid("client settings must be a JSON object");
      const serialized = JSON.stringify(settings);
      if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) {
        throw invalid("client settings exceed 256 KiB");
      }
      current = { revision: current.revision + 1, updatedAt: Date.now(), settings };
      atomicWriteSync(opts.file, JSON.stringify(current, null, 2));
      return { ...current };
    },
  };
}
