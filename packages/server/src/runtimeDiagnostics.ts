// A runtime that never starts used to be invisible: `/api/models` fans out with
// `Promise.allSettled`, so a project whose `opencode serve` could not be spawned
// contributed nothing and reported nothing. The catalog came back `[]`, the
// composer said "check that the backend is running", the server log stayed
// empty, and the one fact that would have fixed it in ten seconds — *why* the
// runtime is unavailable — existed only inside a swallowed rejection.
//
// This records the last failure per runtime key, logs each distinct reason once
// (the browser retries with backoff forever; repeating one message every few
// seconds is noise, not information), and exposes it so the UI can state the
// real reason instead of a guess.
import type { RuntimeUnavailableReport } from "@polyth/contracts";

export interface RuntimeDiagnostics {
  /** Wrap a runtime acquisition so its outcome is recorded either way. */
  observe<T>(
    key: string,
    location: { projectId: string; cwd: string },
    acquire: () => Promise<T>,
  ): Promise<T>;
  list(): RuntimeUnavailableReport[];
  /** Newest first; the composer only ever shows one reason. */
  latest(): RuntimeUnavailableReport | undefined;
}

interface Entry extends RuntimeUnavailableReport {
  loggedMessages: Set<string>;
}

const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : "error";
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const searchedLocations = (error: unknown): string[] | undefined => {
  const searched = (error as { searched?: unknown } | null)?.searched;
  if (!Array.isArray(searched)) return undefined;
  const paths = searched.filter((entry): entry is string => typeof entry === "string");
  return paths.length > 0 ? paths : undefined;
};

export function createRuntimeDiagnostics(
  options: { log?: (message: string) => void } = {},
): RuntimeDiagnostics {
  const log = options.log ?? ((message: string) => console.error(message));
  const entries = new Map<string, Entry>();

  const record = (
    key: string,
    location: { projectId: string; cwd: string },
    error: unknown,
  ): void => {
    const now = new Date().toISOString();
    const message = errorMessage(error);
    const previous = entries.get(key);
    const entry: Entry = {
      projectId: location.projectId,
      cwd: location.cwd,
      code: errorCode(error),
      message,
      ...(searchedLocations(error) ? { searched: searchedLocations(error) } : {}),
      attempts: (previous?.attempts ?? 0) + 1,
      firstFailedAt: previous?.firstFailedAt ?? now,
      lastFailedAt: now,
      loggedMessages: previous?.loggedMessages ?? new Set<string>(),
    };
    entries.set(key, entry);
    if (entry.loggedMessages.has(message)) return;
    entry.loggedMessages.add(message);
    log(`[polyth] OpenCode runtime unavailable for ${location.projectId} (${location.cwd}): ${message}`);
  };

  return {
    async observe(key, location, acquire) {
      try {
        const value = await acquire();
        const previous = entries.get(key);
        if (previous) {
          entries.delete(key);
          log(
            `[polyth] OpenCode runtime recovered for ${location.projectId} (${location.cwd})`
            + ` after ${previous.attempts} failed attempt${previous.attempts === 1 ? "" : "s"}`,
          );
        }
        return value;
      } catch (error) {
        record(key, location, error);
        throw error;
      }
    },
    list() {
      return [...entries.values()]
        .map(({ loggedMessages: _ignored, ...report }) => report)
        .sort((left, right) => right.lastFailedAt.localeCompare(left.lastFailedAt));
    },
    latest() {
      return this.list()[0];
    },
  };
}
