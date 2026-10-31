import { mkdirSync, readFileSync } from "node:fs";
import type { SpaceContext, SpaceStorage } from "@polyth/contracts";
import { atomicWriteSync } from "@polyth/plugins";
import {
  CUSTOM_TITLES_PACKAGE_ID,
  CUSTOM_TITLES_SETTINGS_VERSION,
  DEFAULT_CUSTOM_TITLE_SETTINGS,
  customTitleSettingsEqual,
  parseCustomTitleSettings,
  type CustomTitleSettings,
} from "./settings.ts";

interface SettingsDocument {
  version: typeof CUSTOM_TITLES_SETTINGS_VERSION;
  revision: number;
  settings: CustomTitleSettings;
}

export interface CustomTitleSettingsState {
  revision: number;
  settings: CustomTitleSettings;
}

const SETTINGS_DIRECTORY = `packages/${CUSTOM_TITLES_PACKAGE_ID}`;
const SETTINGS_FILE = `${SETTINGS_DIRECTORY}/settings.json`;
const cloneGenerator = (generator: CustomTitleSettings["generator"]): CustomTitleSettings["generator"] => ({ ...generator });
const cloneSettings = (settings: CustomTitleSettings): CustomTitleSettings => ({
  ...settings,
  generator: cloneGenerator(settings.generator),
});

const parseDocument = (value: unknown): SettingsDocument => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("custom title settings are unreadable"), { code: "storage-unavailable" });
  }
  const input = value as Record<string, unknown>;
  if (
    input.version !== CUSTOM_TITLES_SETTINGS_VERSION
    || !Number.isSafeInteger(input.revision)
    || Number(input.revision) < 1
  ) {
    throw Object.assign(new Error("custom title settings use an unsupported format"), { code: "storage-unavailable" });
  }
  return {
    version: CUSTOM_TITLES_SETTINGS_VERSION,
    revision: Number(input.revision),
    settings: parseCustomTitleSettings(input.settings),
  };
};

export interface CustomTitleSettingsStore {
  read(space: SpaceContext): CustomTitleSettingsState;
  save(space: SpaceContext, settings: unknown, expectedRevision: number): CustomTitleSettingsState;
}

export function createCustomTitleSettingsStore(storageFor: (space: SpaceContext) => SpaceStorage): CustomTitleSettingsStore {
  const read = (space: SpaceContext): CustomTitleSettingsState => {
    const storage = storageFor(space);
    const path = storage.path(SETTINGS_FILE);
    try {
      const document = parseDocument(JSON.parse(readFileSync(path, "utf8")) as unknown);
      return { revision: document.revision, settings: cloneSettings(document.settings) };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return { revision: 0, settings: cloneSettings(DEFAULT_CUSTOM_TITLE_SETTINGS) };
      }
      throw cause;
    }
  };

  return {
    read,
    save(space, value, expectedRevision) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw Object.assign(new Error("expectedRevision must be a non-negative integer"), { code: "invalid-input" });
      }
      const settings = parseCustomTitleSettings(value);
      const current = read(space);
      if (current.revision !== expectedRevision) {
        throw Object.assign(new Error("custom title settings changed in another session"), { code: "conflict" });
      }
      if (customTitleSettingsEqual(current.settings, settings)) return current;
      const storage = storageFor(space);
      const directory = storage.path(SETTINGS_DIRECTORY);
      const path = storage.path(SETTINGS_FILE);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      atomicWriteSync(path, JSON.stringify({
        version: CUSTOM_TITLES_SETTINGS_VERSION,
        revision: current.revision + 1,
        settings,
      } satisfies SettingsDocument, null, 2), 0o600);
      return { revision: current.revision + 1, settings: cloneSettings(settings) };
    },
  };
}
