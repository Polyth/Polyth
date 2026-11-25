import { isTesterPassword } from "@polyth/contracts/bug-report";
import {
  FEEDBACK_KINDS, FEEDBACK_ROLES, parseFeedback, type FeedbackKind, type FeedbackPayload, type FeedbackResult,
} from "@polyth/contracts/feedback";

import { cell, fenced, fileUrl, neutralize, quoted, RELEASE_REPO } from "./format.ts";
import { verifyPassword, type ScryptRecord } from "./password.ts";
import {
  FEEDBACK_STATUSES, FeedbackStore, NOTE_CHARS, type FeedbackStatus, type InboxDetail, type InboxItem, type InboxQuery, type InboxSummary,
} from "./feedbackStore.ts";
import type { RelayGitHub } from "./types.ts";

const DAY = 86_400_000;
const MINUTE = 60_000;
const TOKEN_WINDOW = 10 * MINUTE;
const MAX_TOKEN_HEADER = 512;
const MAX_FAILURE_KEYS = 20_000;
const TITLE_LINE = 80;
const MAX_PAGE = 100;

export interface FeedbackLimits {
  /** Stored feedback per rolling day, the whole service. The only cap in stage 1. */
  globalDay: number;
  /** Failed inbox-token attempts per source address per 10 minutes. */
  tokenFailures: number;
}

export interface FeedbackIntakeOptions {
  store: FeedbackStore;
  now: () => number;
  limits: FeedbackLimits;
  retentionDays: number;
  /** The inbox token's scrypt record, or null when none is configured. */
  inboxRecord: () => ScryptRecord | null;
  /** The private GitHub target for "file as an issue", or null. */
  github: () => { client: RelayGitHub; repo: string; branch: string } | null;
}

export type InboxAuth = "ok" | "denied" | "rate" | "unavailable";

export type InboxUpdateResult = { ok: true; item: InboxDetail } | { ok: false; reason: "not-found" | "invalid" };

export type InboxGithubResult =
  | { ok: true; issue: number }
  | { ok: false; reason: "not-found" | "unavailable" };

const bearer = (authorization: string | undefined): string | undefined => {
  if (typeof authorization !== "string" || authorization.length > MAX_TOKEN_HEADER) return undefined;
  const match = /^Bearer (\S+)$/i.exec(authorization);
  return isTesterPassword(match?.[1]) ? match[1] : undefined;
};

/** Collects feedback from anyone (no password, no account) and lets the team
 *  read it with the inbox token. Stage 1 keeps one service-wide daily budget;
 *  stage 2 limits belong in `receive`, before `store.insert`. */
export class FeedbackIntake {
  private readonly options: FeedbackIntakeOptions;
  private readonly failures = new Map<string, { startedAt: number; count: number }>();

  constructor(options: FeedbackIntakeOptions) {
    this.options = options;
  }

  /** One `POST /v1/feedback`: `raw` is the exact request body. */
  receive(raw: string): FeedbackResult {
    const now = this.options.now();
    let payload: FeedbackPayload | null = null;
    try { payload = parseFeedback(JSON.parse(raw) as unknown, now); } catch { payload = null; }
    if (!payload) return { result: "invalid" };
    try {
      if (this.options.store.countSince(now - DAY) >= this.options.limits.globalDay) return { result: "rate" };
      const stored = this.options.store.insert(payload, now);
      return { result: "received", ref: stored.ref };
    } catch {
      return { result: "unavailable" };
    }
  }

  /** A person's own erasure: everything sent under their install pseudonym. */
  forget(raw: string): { result: "forgotten"; count: number } | { result: "invalid" } | { result: "unavailable" } {
    let install: unknown;
    try {
      const body = JSON.parse(raw) as { version?: unknown; install?: unknown };
      if (Object.keys(body).length !== 2 || body.version !== 1) return { result: "invalid" };
      install = body.install;
    } catch { return { result: "invalid" }; }
    if (typeof install !== "string" || !/^[0-9a-f]{32}$/.test(install)) return { result: "invalid" };
    try { return { result: "forgotten", count: this.options.store.deleteInstall(install) }; } catch { return { result: "unavailable" }; }
  }

  /** Checks the inbox token. A wrong one counts against the source; past the
   *  limit the source is refused until the window ends. */
  authorize(authorization: string | undefined, source: string): InboxAuth {
    const now = this.options.now();
    const prior = this.failures.get(source);
    if (prior && now - prior.startedAt >= TOKEN_WINDOW) this.failures.delete(source);
    const current = this.failures.get(source);
    if (current && current.count > this.options.limits.tokenFailures) return "rate";
    const record = this.options.inboxRecord();
    if (!record) return "unavailable";
    const presented = bearer(authorization);
    if (presented && verifyPassword(record, presented)) return "ok";
    if (this.failures.size >= MAX_FAILURE_KEYS) this.failures.clear();
    this.failures.set(source, { startedAt: current?.startedAt ?? now, count: (current?.count ?? 0) + 1 });
    return "denied";
  }

  list(query: URLSearchParams): { items: InboxItem[]; total: number } | null {
    const parsed = parseQuery(query, this.options.now());
    return parsed ? this.options.store.list(parsed) : null;
  }

  summary(query: URLSearchParams): InboxSummary | null {
    const since = sinceOf(query.get("days"), this.options.now());
    return since === null ? null : this.options.store.summary(since);
  }

  get(ref: number): InboxDetail | null {
    return this.options.store.get(ref);
  }

  screenshot(ref: number): Buffer | null {
    return this.options.store.screenshot(ref);
  }

  update(ref: number, raw: string): InboxUpdateResult {
    let body: { status?: unknown; note?: unknown };
    try { body = JSON.parse(raw) as typeof body; } catch { return { ok: false, reason: "invalid" }; }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, reason: "invalid" };
    const keys = Object.keys(body);
    if (keys.length === 0 || keys.some((key) => key !== "status" && key !== "note")) return { ok: false, reason: "invalid" };
    const change: { status?: FeedbackStatus; note?: string } = {};
    if (body.status !== undefined) {
      if (!(FEEDBACK_STATUSES as readonly unknown[]).includes(body.status)) return { ok: false, reason: "invalid" };
      change.status = body.status as FeedbackStatus;
    }
    if (body.note !== undefined) {
      if (typeof body.note !== "string" || body.note.length > NOTE_CHARS) return { ok: false, reason: "invalid" };
      change.note = body.note;
    }
    if (!this.options.store.update(ref, change)) return { ok: false, reason: "not-found" };
    const item = this.options.store.get(ref);
    return item ? { ok: true, item } : { ok: false, reason: "not-found" };
  }

  /** Files a feedback as an issue in the private repository. Only what the
   *  team needs to act on goes: the words, the build facts and the screenshot.
   *  Never the contact, the profile or the install pseudonym. A second call
   *  answers the issue already filed. */
  async fileToGithub(ref: number): Promise<InboxGithubResult> {
    const item = this.options.store.get(ref);
    if (!item) return { ok: false, reason: "not-found" };
    if (item.githubIssue !== null) return { ok: true, issue: item.githubIssue };
    const target = this.options.github();
    if (!target) return { ok: false, reason: "unavailable" };
    try {
      const screenshot = item.hasScreenshot ? this.options.store.screenshot(ref) : null;
      const date = item.createdAt.slice(0, 10);
      const path = `reports/${date}/fb-${ref}/screenshot.jpg`;
      if (screenshot) {
        await target.client.uploadFile({ path, content: screenshot.toString("base64"), message: `Feedback ${ref} screenshot` });
      }
      const issue = await target.client.createIssue({
        title: feedbackTitle(item),
        body: feedbackIssueBody(item, { repo: target.repo, branch: target.branch, ...(screenshot ? { screenshotPath: path } : {}) }),
        labels: feedbackLabels(item),
      });
      this.options.store.setIssue(ref, issue.number);
      if (item.status === "new" || item.status === "seen") this.options.store.update(ref, { status: "planned" });
      return { ok: true, issue: issue.number };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  prune(): number {
    return this.options.store.prune(this.options.now() - this.options.retentionDays * DAY);
  }
}

function sinceOf(days: string | null, now: number): number | undefined | null {
  if (days === null) return undefined;
  if (!/^\d{1,4}$/.test(days) || Number(days) < 1) return null;
  return now - Number(days) * DAY;
}

function parseQuery(query: URLSearchParams, now: number): InboxQuery | null {
  const out: InboxQuery = { limit: 50, offset: 0 };
  const kind = query.get("kind");
  if (kind !== null) {
    if (!(FEEDBACK_KINDS as readonly string[]).includes(kind)) return null;
    out.kind = kind as FeedbackKind;
  }
  const status = query.get("status");
  if (status !== null) {
    if (!(FEEDBACK_STATUSES as readonly string[]).includes(status)) return null;
    out.status = status as FeedbackStatus;
  }
  const role = query.get("role");
  if (role !== null) {
    if (!(FEEDBACK_ROLES as readonly string[]).includes(role)) return null;
    out.role = role;
  }
  const since = sinceOf(query.get("days"), now);
  if (since === null) return null;
  if (since !== undefined) out.since = since;
  for (const [name, field, max] of [["limit", "limit", MAX_PAGE], ["offset", "offset", 1_000_000]] as const) {
    const value = query.get(name);
    if (value === null) continue;
    if (!/^\d{1,7}$/.test(value)) return null;
    const number = Number(value);
    if (number > max || (field === "limit" && number < 1)) return null;
    out[field] = number;
  }
  return out;
}

const KIND_LABEL: Record<FeedbackKind, string> = { bug: "Bug", idea: "Idea", pain: "Pain point", praise: "Praise" };

export function feedbackTitle(item: Pick<InboxDetail, "kind" | "text" | "basics" | "ref">): string {
  const first = item.text.split("\n")[0]?.trim() ?? "";
  const description = first ? neutralize(first).slice(0, TITLE_LINE) : "No description";
  return `[${item.basics.version}] ${KIND_LABEL[item.kind]}: ${description}`;
}

export function feedbackLabels(item: Pick<InboxDetail, "kind" | "basics" | "hasScreenshot" | "technical">): string[] {
  const labels = ["feedback", `kind:${item.kind}`, `v${item.basics.version}`];
  if (item.technical) labels.push(`platform:${item.technical.app.platform}`);
  if (item.hasScreenshot) labels.push("has-screenshot");
  return labels;
}

export function feedbackIssueBody(
  item: InboxDetail,
  context: { repo: string; branch: string; screenshotPath?: string },
): string {
  const parts: string[] = [quoted(item.text.trim())];
  if (context.screenshotPath) parts.push(`![screenshot](${fileUrl(context, context.screenshotPath)})`);
  const rows: Array<[string, string]> = [
    ["Kind", item.kind],
    ["Version", item.basics.version],
    ["Channel", item.basics.channel],
    ["Edition", item.basics.edition],
    ["Locale", item.basics.locale],
  ];
  if (item.technical) {
    const { app, web } = item.technical;
    rows.push(["Platform", app.platform], ["View", web.view || "—"], ["Viewport", `${web.viewport.width}×${web.viewport.height} @${web.viewport.scale}`]);
  }
  parts.push(`| Field | Value |\n| --- | --- |\n${rows.map(([field, value]) => `| ${field} | ${cell(value)} |`).join("\n")}`);
  if (item.technical) {
    const bag = JSON.stringify({ settings: item.technical.settings, packages: item.technical.packages, errors: item.technical.errors }, null, 2);
    parts.push(`<details><summary>Settings and packages</summary>\n\n\`\`\`\`json\n${fenced(bag)}\n\`\`\`\`\n\n</details>`);
  }
  parts.push(`Release: https://github.com/${RELEASE_REPO}/releases/tag/v${item.basics.version}`);
  parts.push(`<!-- polyth-feedback ref=${item.ref} -->`);
  return parts.join("\n\n");
}
