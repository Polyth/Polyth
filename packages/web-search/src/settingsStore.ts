import { mkdirSync, readFileSync } from "node:fs";
import type { SpaceContext, SpaceStorage } from "@polyth/contracts";
import { atomicWriteSync } from "@polyth/plugins";
import { webSearchError } from "./errors.ts";
import {
  DEFAULT_WEB_SEARCH_SETTINGS,
  parseWebSearchSettings,
  WEB_SEARCH_PACKAGE_ID,
  WEB_SEARCH_SETTINGS_VERSION,
  webSearchSettingsEqual,
  type WebSearchSettings,
} from "./settings.ts";

interface SettingsDocument {
  version: typeof WEB_SEARCH_SETTINGS_VERSION;
  revision: number;
  settings: WebSearchSettings;
}

export interface WebSearchSettingsState {
  revision: number;
  settings: WebSearchSettings;
}

const cloneSettings = (settings: WebSearchSettings): WebSearchSettings => ({ ...settings });
const SETTINGS_DIRECTORY = `packages/${WEB_SEARCH_PACKAGE_ID}`;
const SETTINGS_FILE = `${SETTINGS_DIRECTORY}/settings.json`;
const fileFor = (storage: SpaceStorage): string => storage.path(SETTINGS_FILE);

const parseDocument = (value: unknown): SettingsDocument => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw webSearchError("storage-unavailable", "web search settings are unreadable");
  }
  const input = value as Record<string, unknown>;
  if (input.version !== WEB_SEARCH_SETTINGS_VERSION || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1) {
    throw webSearchError("storage-unavailable", "web search settings use an unsupported format");
  }
  return {
    version: WEB_SEARCH_SETTINGS_VERSION,
    revision: Number(input.revision),
    settings: parseWebSearchSettings(input.settings),
  };
};

export interface WebSearchSettingsStore {
  read(space: SpaceContext): WebSearchSettingsState;
  save(space: SpaceContext, settings: WebSearchSettings, expectedRevision: number): WebSearchSettingsState;
}

export function createWebSearchSettingsStore(storageFor: (space: SpaceContext) => SpaceStorage): WebSearchSettingsStore {
  const read = (space: SpaceContext): WebSearchSettingsState => {
    let path: string;
    try {
      path = fileFor(storageFor(space));
    } catch {
      throw webSearchError("storage-unavailable", "web search settings could not be read");
    }
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return { revision: 0, settings: cloneSettings(DEFAULT_WEB_SEARCH_SETTINGS) };
      }
      throw webSearchError("storage-unavailable", "web search settings could not be read");
    }
    try {
      const document = parseDocument(JSON.parse(raw) as unknown);
      return { revision: document.revision, settings: cloneSettings(document.settings) };
    } catch (cause) {
      if ((cause as { code?: string }).code === "invalid-input") {
        throw webSearchError("storage-unavailable", "web search settings contain invalid values");
      }
      throw cause;
    }
  };

  return {
    read,
    save(space, settings, expectedRevision) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw webSearchError("invalid-input", "expectedRevision must be a non-negative integer");
      }
      const parsedSettings = parseWebSearchSettings(settings);
      const current = read(space);
      if (current.revision !== expectedRevision) {
        throw webSearchError("conflict", "web search settings changed in another session");
      }
      if (webSearchSettingsEqual(current.settings, parsedSettings)) return current;
      const storage = storageFor(space);
      let path: string;
      let directory: string;
      try {
        directory = storage.path(SETTINGS_DIRECTORY);
        path = fileFor(storage);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        atomicWriteSync(path, JSON.stringify({
          version: WEB_SEARCH_SETTINGS_VERSION,
          revision: current.revision + 1,
          settings: parsedSettings,
        } satisfies SettingsDocument), 0o600);
      } catch {
        throw webSearchError("storage-unavailable", "web search settings could not be saved");
      }
      return { revision: current.revision + 1, settings: cloneSettings(parsedSettings) };
    },
  };
}
