import { join } from "node:path";

import {
  isTesterPassword, parseBugReport, type BugReportPayload, type BugReportResult,
} from "@polyth/contracts/bug-report";

import { githubFromDir, type GithubConfig } from "./config.ts";
import { FeedbackIntake } from "./feedback.ts";
import { FeedbackStore } from "./feedbackStore.ts";
import {
  commentBody, fingerprintOf, issueBody, issueLabels, issueTitle, type FormatContext, type ReportGroup,
} from "./format.ts";
import { GitHubClient } from "./github.ts";
import { passwordFromDir, verifyPassword, type ScryptRecord } from "./password.ts";
import { ReleaseCache } from "./releases.ts";
import { ReportState } from "./state.ts";
import { ReportStats, type RenderedStats } from "./stats.ts";
import {
  authenticate as authenticateToken, DEFAULT_DAY_CAP, DEFAULT_GROUP, tokenSetFromDir,
  type ReportIdentity, type TokenRecord,
} from "./tokens.ts";
import type { RelayGitHub, RelayLogEvent, RelayLogger } from "./types.ts";

export * from "./types.ts";
export { GitHubClient } from "./github.ts";
export { groupName } from "./format.ts";

const DAY = 86_400_000;
const MINUTE = 60_000;
const PASSWORD_WINDOW = 10 * MINUTE;
const RETENTION_DAYS = 30;
/** Feedback is kept longer than a bug report: ideas stay useful. */
const FEEDBACK_RETENTION_DAYS = 90;
const DEFAULT_PRUNE_INTERVAL = DAY;
/** Rate-window keys kept at most; past it new keys wait for the sweep. */
const MAX_WINDOWS = 50_000;
const MAX_FAILURE_KEYS = 20_000;
const MAX_PASSWORD_HEADER = 512;

/** No per-address or per-computer cap: a tester sends as many reports as they
 *  need. The service-wide daily cap bounds what a leaked password can file, and
 *  each group token carries its own smaller cap. */
export interface ReportRelayLimits {
  /** Issues and comments filed per day, the whole service. */
  globalDay: number;
  /** Failed password attempts per source address per 10 minutes. */
  passwordFailures: number;
  /** A token's daily cap when its `tokens.json` entry names none. */
  tokenDay: number;
  /** Feedback stored per rolling day, the whole service (stage 1's only cap). */
  feedbackDay: number;
}

export interface ReportRelayOptions {
  keysDir?: string;
  dataDir?: string;
  now?: () => number;
  logger?: RelayLogger;
  fetchFn?: typeof fetch;
  apiBase?: string;
  releasesRepo?: string;
  /** Test seam: decide versions without fetching GitHub releases. */
  allowVersion?: (version: string) => boolean;
  /** Test seam: a complete GitHub client (null = none configured). When
   *  omitted, the files in `keysDir` configure the real client. */
  github?: RelayGitHub | null;
  createGithub?: (config: GithubConfig) => RelayGitHub;
  /** Kill switch: every report answers `unavailable`. */
  off?: boolean;
  limits?: Partial<ReportRelayLimits>;
  retentionDays?: number;
  feedbackRetentionDays?: number;
  pruneIntervalMs?: number;
  pruneAtStart?: boolean;
  /** Test seam: group tokens without a `tokens.json` file. */
  tokens?: ReadonlyMap<string, TokenRecord>;
  /** Days the published `stats/YYYY-MM-DD.md` window covers. */
  statsWindowDays?: number;
  /** Test seam: publish no stats artifact at all. */
  statsUpload?: boolean;
}

/** One rate window per key: a fixed window that starts at a key's first
 *  request. Bounded, so a flood of keys cannot grow memory without limit. */
class RateWindow {
  private readonly values = new Map<string, { startedAt: number; count: number }>();
  private readonly windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  take(key: string, limit: number, now: number): boolean {
    if (this.values.size >= MAX_WINDOWS) {
      for (const [candidate, value] of this.values) if (now - value.startedAt >= this.windowMs) this.values.delete(candidate);
    }
    const prior = this.values.get(key);
    if (!prior || now - prior.startedAt >= this.windowMs) {
      if (!prior && this.values.size >= MAX_WINDOWS) return false;
      this.values.set(key, { startedAt: now, count: 1 });
      return true;
    }
    if (prior.count >= limit) return false;
    prior.count++;
    return true;
  }
}

class FailureWindow {
  private readonly values = new Map<string, { startedAt: number; count: number }>();

  count(key: string, now: number): number {
    const prior = this.values.get(key);
    if (!prior) return 0;
    if (now - prior.startedAt >= PASSWORD_WINDOW) { this.values.delete(key); return 0; }
    return prior.count;
  }

  record(key: string, now: number): void {
    const count = this.count(key, now);
    if (count === 0) {
      if (this.values.size >= MAX_FAILURE_KEYS) this.values.clear();
      this.values.set(key, { startedAt: now, count: 1 });
      return;
    }
    this.values.set(key, { startedAt: this.values.get(key)!.startedAt, count: count + 1 });
  }
}

const positive = (value: number | undefined, fallback: number): number =>
  Number.isInteger(value) && value! > 0 && value! <= 100_000 ? value! : fallback;

const bearer = (authorization: string | undefined): string | undefined => {
  if (typeof authorization !== "string" || authorization.length > MAX_PASSWORD_HEADER) return undefined;
  const match = /^Bearer (\S+)$/i.exec(authorization);
  return isTesterPassword(match?.[1]) ? match[1] : undefined;
};

/** `X.Y.N` of a version as numbers, for ordering. */
const versionParts = (version: string): number[] => version.replace(/-nightly$/, "").split(".").map(Number);

const compareVersions = (a: string, b: string): number => {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < 3; index++) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
};

/** A published nightly, or an older nightly the release list no longer shows
 *  (only the newest few are kept, and a tester may not have updated yet).
 *  Never a version newer than every published nightly: that is a local build
 *  nobody can reproduce from a release. */
export function acceptedVersion(version: string, published: ReadonlySet<string>): boolean {
  if (!version.endsWith("-nightly")) return false;
  if (published.has(version)) return true;
  let newest: string | null = null;
  for (const candidate of published) if (!newest || compareVersions(candidate, newest) > 0) newest = candidate;
  return newest !== null && compareVersions(version, newest) < 0;
}

/** Nightly bug-report intake: authenticates a tester password, checks the app
 *  version against published nightlies, files the report as a private GitHub
 *  issue plus its attachments and dedups repeats. Holds only the password hash,
 *  a bounded rate window and a 30-day state file. */
export class ReportRelay {
  private readonly options: ReportRelayOptions;
  private readonly now: () => number;
  private readonly logger: RelayLogger;
  private readonly limits: ReportRelayLimits;
  private readonly password: () => ScryptRecord | null;
  private readonly tokens: () => ReadonlyMap<string, TokenRecord>;
  private readonly githubConfig: () => GithubConfig | undefined;
  private readonly createGithub: (config: GithubConfig) => RelayGitHub;
  private readonly state: ReportState | null;
  private readonly stats: ReportStats | null;
  private readonly releases: ReleaseCache;
  private readonly fetchFn: typeof fetch;
  private readonly globalDay = new RateWindow(DAY);
  private readonly tokenDay = new RateWindow(DAY);
  private readonly failures = new FailureWindow();
  private readonly retentionDays: number;
  private client: RelayGitHub | null = null;
  private clientConfig: GithubConfig | undefined;
  /** Feedback intake and the team inbox; null without a data folder. */
  readonly feedback: FeedbackIntake | null;
  private readonly feedbackStore: FeedbackStore | null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ReportRelayOptions = {}) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? (() => {});
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.limits = {
      globalDay: positive(options.limits?.globalDay, 200),
      passwordFailures: positive(options.limits?.passwordFailures, 10),
      tokenDay: positive(options.limits?.tokenDay, DEFAULT_DAY_CAP),
      feedbackDay: positive(options.limits?.feedbackDay, 2_000),
    };
    this.retentionDays = positive(options.retentionDays, RETENTION_DAYS);
    this.password = passwordFromDir(options.keysDir ?? "/keys");
    this.tokens = options.tokens ? () => options.tokens! : tokenSetFromDir(options.keysDir ?? "/keys");
    this.githubConfig = githubFromDir(options.keysDir ?? "/keys");
    this.createGithub = options.createGithub ?? ((config) => new GitHubClient({
      ...config,
      fetchFn: this.fetchFn,
      ...(options.apiBase ? { apiBase: options.apiBase } : {}),
      logger: this.logger,
    }));
    this.state = options.dataDir ? new ReportState(join(options.dataDir, "state.json"), this.now) : null;
    this.stats = options.dataDir ? new ReportStats(join(options.dataDir, "stats.json"), this.now) : null;
    this.feedbackStore = options.dataDir ? new FeedbackStore(join(options.dataDir, "feedback.db")) : null;
    this.feedback = this.feedbackStore
      ? new FeedbackIntake({
        store: this.feedbackStore,
        now: this.now,
        limits: { globalDay: this.limits.feedbackDay, tokenFailures: this.limits.passwordFailures },
        retentionDays: positive(options.feedbackRetentionDays, FEEDBACK_RETENTION_DAYS),
        inboxRecord: passwordFromDir(options.keysDir ?? "/keys", "inbox.scrypt"),
        github: () => this.githubTarget(),
      })
      : null;
    this.releases = new ReleaseCache({
      repo: options.releasesRepo ?? "Polyth/Polyth",
      fetchFn: this.fetchFn,
      ...(options.apiBase ? { apiBase: options.apiBase } : {}),
      token: () => this.githubConfig()?.token,
      logger: this.logger,
      now: this.now,
    });
    if (options.pruneAtStart !== false) void this.prune();
    const interval = positive(options.pruneIntervalMs, DEFAULT_PRUNE_INTERVAL);
    if (options.pruneAtStart !== false) {
      this.pruneTimer = setInterval(() => { void this.prune(); }, interval);
      this.pruneTimer.unref?.();
    }
  }

  close(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    try { this.feedbackStore?.close(); } catch { /* already closed */ }
  }

  /** The kill switch: every report and feedback answers `unavailable`. */
  get off(): boolean {
    return this.options.off === true;
  }

  health(): { ok: true; github: boolean } {
    return { ok: true, github: this.githubTarget() !== null };
  }

  logRequest(route: "report" | "health" | "not-found" | "feedback" | "inbox", result: string, status: number, latencyMs: number): void {
    this.logger({ route, result, status, latencyMs: Math.min(Math.max(0, latencyMs), 60_000) } as RelayLogEvent);
  }

  /** Retention: prune attachments and close stale issues. Never throws; the
   *  timer calls it and a failed pass simply waits for the next one. */
  async prune(): Promise<{ closed: number }> {
    const target = this.githubTarget();
    let closed = 0;
    if (target) {
      try {
        closed = (await target.client.prune({ keepDays: this.retentionDays, now: this.now() })).closed;
      } catch { /* the client logged the operation and status */ }
    }
    try { this.state?.prune(this.now()); } catch { /* best effort */ }
    await this.publishStats(target);
    try { this.feedback?.prune(); } catch { /* best effort */ }
    return { closed };
  }

  /** Publishes today's `stats/YYYY-MM-DD.md` when its content changed. Counters
   *  only: group slugs, counts and issue numbers, never a person or an install.
   *  A failed upload is simply retried by the next pass. */
  private async publishStats(target: { client: RelayGitHub; repo: string; branch: string } | null): Promise<void> {
    if (!target || !this.stats || this.options.statsUpload === false) return;
    let rendered: RenderedStats;
    try { rendered = this.stats.render(this.now(), this.options.statsWindowDays ?? 7); } catch { return; }
    if (rendered.empty || !this.stats.needsUpload(rendered)) return;
    try {
      await target.client.uploadFile({
        path: `stats/${rendered.date}.md`,
        content: Buffer.from(rendered.markdown, "utf8").toString("base64"),
        message: `Report activity ${rendered.date}`,
      });
      this.stats.markUploaded(rendered);
    } catch { /* the client logged the operation and status */ }
  }

  /** One `POST /v1/report`: `raw` is the exact request body, `authorization`
   *  the header (a secret that is never logged). */
  async report(raw: string, sourceIp: string, authorization?: string): Promise<BugReportResult> {
    const now = this.now();
    if (this.options.off) return { result: "unavailable" };
    if (this.failures.count(sourceIp, now) > this.limits.passwordFailures) return { result: "rate" };
    const tokens = this.tokens();
    const legacy = this.password();
    if (tokens.size === 0 && !legacy) return { result: "unavailable" };
    const identity = this.authenticate(authorization, tokens, legacy);
    if (!identity) {
      this.failures.record(sourceIp, now);
      return { result: "password" };
    }

    let payload: BugReportPayload | null = null;
    try { payload = parseBugReport(JSON.parse(raw) as unknown, now); } catch { payload = null; }
    if (!payload) return { result: "invalid" };

    if (this.options.allowVersion) {
      if (!this.options.allowVersion(payload.app.version)) return { result: "version" };
    } else {
      const versions = await this.releases.current();
      if (!versions) return { result: "unavailable" };
      if (!acceptedVersion(payload.app.version, versions)) return { result: "version" };
    }

    const prior = this.state?.report(payload.reportId);
    if (prior) return { result: prior.result, issue: prior.issue };

    const target = this.githubTarget();
    if (!target) return { result: "unavailable" };
    // The group's own cap first: a cohort that exhausted its day must not eat
    // the service-wide budget as well.
    if (!this.tokenDay.take(`token:${identity.keyId}`, identity.dayCap, now)) return { result: "rate" };
    if (!this.globalDay.take("global", this.limits.globalDay, now)) return { result: "rate" };

    const fingerprint = fingerprintOf(payload);
    try {
      const filed = await this.file(target, payload, fingerprint, identity);
      this.state?.rememberReport(payload.reportId, { issue: filed.issue, result: filed.result, at: now });
      this.state?.rememberFingerprint(fingerprint, filed.issue, now);
      this.stats?.record({
        at: now,
        group: identity.group,
        install: payload.install,
        fingerprint,
        issue: filed.issue,
        result: filed.result,
        screenshot: payload.screenshot !== null,
        lowSignal: !payload.text.trim() && payload.errors.length === 0,
        platform: payload.app.platform,
        version: payload.app.version,
      });
      return { result: filed.result, issue: filed.issue };
    } catch {
      // The client logged the failing GitHub operation; the client gets no
      // GitHub error text and no partial success.
      return { result: "unavailable" };
    }
  }

  /** The group the bearer proves. `<keyId>.<secret>` is a group token; a value
   *  without a dot is the legacy single tester password, which becomes the
   *  `default` group. A legacy password that contains a dot therefore stops
   *  working once `tokens.json` exists: it would cost one scrypt per token
   *  guess otherwise. */
  private authenticate(
    authorization: string | undefined,
    tokens: ReadonlyMap<string, TokenRecord>,
    legacy: ScryptRecord | null,
  ): ReportIdentity | null {
    const presented = bearer(authorization);
    if (!presented) return null;
    if (presented.includes(".")) return authenticateToken(tokens, presented);
    if (!legacy || !verifyPassword(legacy, presented)) return null;
    return { keyId: DEFAULT_GROUP, group: DEFAULT_GROUP, label: "Default", dayCap: this.limits.tokenDay };
  }

  /** The client plus the repository and branch its attachments live on. A
   *  configured real client reads both from `github.json`; an injected test
   *  client keeps them for the links written into an issue. */
  private githubTarget(): { client: RelayGitHub; repo: string; branch: string } | null {
    const config = this.githubConfig();
    let client: RelayGitHub | null;
    if (this.options.github !== undefined) client = this.options.github;
    else if (config) {
      if (this.clientConfig !== config) {
        this.clientConfig = config;
        this.client = this.createGithub(config);
      }
      client = this.client;
    } else client = null;
    if (!client) return null;
    return { client, repo: config?.repo ?? "Polyth/Polyth", branch: config?.branch ?? "attachments" };
  }

  private async file(
    target: { client: RelayGitHub; repo: string; branch: string },
    report: BugReportPayload,
    fingerprint: string,
    identity: ReportIdentity,
  ): Promise<{ result: "created" | "added"; issue: number }> {
    const github = target.client;
    const date = report.createdAt.slice(0, 10);
    const basePath = `reports/${date}/${report.reportId}`;
    const reportJsonPath = `${basePath}/report.json`;
    const screenshotPath = report.screenshot ? `${basePath}/screenshot.jpg` : undefined;

    const known = this.state?.fingerprint(fingerprint);
    let open = false;
    if (known) open = (await github.issueState(known.issue)) === "open";

    const group: ReportGroup = { id: identity.group, label: identity.label, keyId: identity.keyId };
    const seen = new Set<string>(this.stats?.groupsFor(fingerprint) ?? []);
    seen.add(group.id);

    const context: FormatContext = {
      repo: target.repo,
      branch: target.branch,
      fingerprint,
      reportJsonPath,
      ...(screenshotPath ? { screenshotPath } : {}),
      ...(known ? { previousIssue: known.issue } : {}),
      group,
      seenInGroups: [...seen].sort(),
    };

    const withoutData = {
      ...report,
      screenshot: report.screenshot ? { type: report.screenshot.type, width: report.screenshot.width, height: report.screenshot.height } : null,
    };
    await github.uploadFile({
      path: reportJsonPath,
      content: Buffer.from(`${JSON.stringify(withoutData, null, 2)}\n`, "utf8").toString("base64"),
      message: `Report ${report.reportId}`,
    });
    if (report.screenshot && screenshotPath) {
      await github.uploadFile({ path: screenshotPath, content: report.screenshot.data, message: `Screenshot ${report.reportId}` });
    }

    if (open && known) {
      await github.comment({ issue: known.issue, body: commentBody(report, context) });
      return { result: "added", issue: known.issue };
    }
    const issue = await github.createIssue({ title: issueTitle(report), body: issueBody(report, context), labels: issueLabels(report, group) });
    return { result: "created", issue: issue.number };
  }
}

export const createReportRelay = (options: ReportRelayOptions = {}): ReportRelay => new ReportRelay(options);
