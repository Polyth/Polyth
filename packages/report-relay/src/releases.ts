import type { RelayLogger } from "./types.ts";

/** Accepted nightly app versions, from the public repository's release list.
 *  Fetched at most once per hour (unauthenticated unless a token is
 *  configured); a relay that could never read the list answers `unavailable`
 *  instead of accepting every version. */
export interface ReleaseCacheOptions {
  repo: string;
  fetchFn: typeof fetch;
  apiBase?: string;
  token?: () => string | undefined;
  logger?: RelayLogger;
  now: () => number;
  intervalMs?: number;
  timeoutMs?: number;
}

const HOUR = 3_600_000;
const DEFAULT_TIMEOUT = 10_000;
const NIGHTLY = /-nightly$/;

class ReleaseStatusError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`releases:${status}`);
    this.status = status;
  }
}

export class ReleaseCache {
  private readonly repo: string;
  private readonly fetchFn: typeof fetch;
  private readonly apiBase: string;
  private readonly token: () => string | undefined;
  private readonly logger: RelayLogger | undefined;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private versions: Set<string> | null = null;
  private attemptedAt = 0;
  private pending: Promise<void> | null = null;

  constructor(options: ReleaseCacheOptions) {
    this.repo = options.repo;
    this.fetchFn = options.fetchFn;
    this.apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
    this.token = options.token ?? (() => undefined);
    this.logger = options.logger;
    this.now = options.now;
    this.intervalMs = options.intervalMs ?? HOUR;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  }

  /** The known version set, or null when it has never been fetched. */
  async current(): Promise<Set<string> | null> {
    const now = this.now();
    if (now - this.attemptedAt < this.intervalMs) return this.versions;
    if (!this.pending) {
      this.pending = this.refresh(now).finally(() => { this.pending = null; });
    }
    await this.pending;
    return this.versions;
  }

  private async refresh(now: number): Promise<void> {
    // Stamp the attempt, not the success: a failing GitHub must not be asked on
    // every report.
    this.attemptedAt = now;
    try {
      const token = this.token();
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "polyth-report-relay",
      };
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await this.fetchFn(`${this.apiBase}/repos/${this.repo}/releases?per_page=100`, {
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new ReleaseStatusError(response.status);
      const releases = (await response.json()) as unknown;
      const versions = new Set<string>();
      if (Array.isArray(releases)) {
        for (const entry of releases) {
          if (typeof entry !== "object" || entry === null) continue;
          const record = entry as { tag_name?: unknown; draft?: unknown };
          if (typeof record.tag_name !== "string" || record.draft === true) continue;
          if (!record.tag_name.startsWith("v")) continue;
          const version = record.tag_name.slice(1);
          if (NIGHTLY.test(version)) versions.add(version);
        }
      }
      this.versions = versions;
    } catch (error) {
      // Keep a previously fetched set; otherwise the relay stays unavailable.
      this.logger?.({ github: "releases", status: error instanceof ReleaseStatusError ? error.status : 0 });
    }
  }
}
