import { GitHubFailure, type RelayGitHub, type RelayLogger } from "./types.ts";

/** The private reports repository's API client. Every call carries the
 *  short-lived fine-grained token, times out after 10 s and maps failures to a
 *  `GitHubFailure` whose message is only `<operation>:<status>`: GitHub's own
 *  error text never reaches a client or the log. */
export interface GitHubClientOptions {
  repo: string;
  branch: string;
  token: string;
  fetchFn?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
  logger?: RelayLogger;
}

const DEFAULT_API = "https://api.github.com";
const DEFAULT_TIMEOUT = 10_000;

/** Linear, unlike `/\/+$/`, which backtracks on a long run of `/`. */
function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end -= 1;
  return url.slice(0, end);
}
const DAY = 86_400_000;
const BRANCH_README = [
  "# Polyth nightly report attachments",
  "",
  "Files the Polyth report relay attaches to private nightly bug reports.",
  "Each report lives under `reports/YYYY-MM-DD/<reportId>/`: `report.json` is",
  "the parsed report without screenshot data and `screenshot.jpg` is the",
  "screenshot, when the person attached one.",
  "",
  "`stats/YYYY-MM-DD.md` is the relay's activity snapshot per tester group:",
  "reports, new issues, comments, install-days and the fingerprints that more",
  "than one group has reported. It carries counts and group slugs only, never a",
  "person, a device, an install id or a report's text.",
  "",
  "Report data and screenshots are kept for 30 days: the relay rewrites this",
  "branch daily and drops whole `reports/` date folders older than that, and it",
  "closes the matching open issues. Issues labelled `keep` or `triaged` stay",
  "open. `stats/` is the long-term record and is never pruned.",
  "",
].join("\n");

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const shaOf = (value: unknown): string => {
  const record = asRecord(value);
  return typeof record?.sha === "string" ? record.sha : "";
};

const dateOfPath = (path: string): number | null => {
  const match = /^reports\/(\d{4}-\d{2}-\d{2})\//.exec(path);
  if (!match) return null;
  const time = Date.parse(`${match[1]}T00:00:00Z`);
  return Number.isFinite(time) ? time : null;
};

export class GitHubClient implements RelayGitHub {
  private readonly repo: string;
  private readonly branch: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly logger: RelayLogger | undefined;
  private branchReady = false;

  constructor(options: GitHubClientOptions) {
    this.repo = options.repo;
    this.branch = options.branch;
    this.token = options.token;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.apiBase = trimTrailingSlashes(options.apiBase ?? DEFAULT_API);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    this.logger = options.logger;
  }

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<{ number: number }> {
    const issue = { title: input.title, body: input.body };
    let result = await this.request("issue.create", "POST", `/repos/${this.repo}/issues`, { ...issue, labels: input.labels });
    if (result.status === 422 && input.labels.length > 0) {
      // A fine-grained token cannot create missing labels; file it unlabelled
      // rather than lose the report.
      result = await this.request("issue.create", "POST", `/repos/${this.repo}/issues`, issue);
    }
    if (result.status < 200 || result.status >= 300) throw this.fail("issue.create", result.status);
    const number = asRecord(result.data)?.number;
    if (!Number.isInteger(number)) throw this.fail("issue.create", result.status);
    return { number: number as number };
  }

  async comment(input: { issue: number; body: string }): Promise<void> {
    const result = await this.request("issue.comment", "POST", `/repos/${this.repo}/issues/${input.issue}/comments`, { body: input.body });
    if (result.status < 200 || result.status >= 300) throw this.fail("issue.comment", result.status);
  }

  async issueState(issue: number): Promise<"open" | "closed" | null> {
    const result = await this.request("issue.state", "GET", `/repos/${this.repo}/issues/${issue}`);
    if (result.status === 404) return null;
    if (result.status < 200 || result.status >= 300) throw this.fail("issue.state", result.status);
    const state = asRecord(result.data)?.state;
    return state === "open" || state === "closed" ? state : null;
  }

  async uploadFile(input: { path: string; content: string; message: string }): Promise<void> {
    const put = () => this.request("file.put", "PUT", `/repos/${this.repo}/contents/${encodePath(input.path)}`, {
      message: input.message,
      content: input.content,
      branch: this.branch,
    });
    let result = await put();
    if (result.status === 404 || (result.status === 422 && /branch/i.test(result.text))) {
      await this.ensureBranch();
      result = await put();
    }
    if (result.status < 200 || result.status >= 300) throw this.fail("file.put", result.status);
  }

  async prune(input: { keepDays: number; now: number }): Promise<{ closed: number }> {
    const cutoff = input.now - input.keepDays * DAY;
    const cutoffDay = Math.floor(cutoff / DAY) * DAY;
    await this.rewriteBranch(cutoffDay);
    const closed = await this.closeStaleIssues(cutoff);
    return { closed };
  }

  /** Creates the branch once as an orphan: a README blob, a tree, a commit with
   *  no parents and the ref. A concurrent writer may already have made it,
   *  which is the same outcome. */
  private async ensureBranch(): Promise<void> {
    if (this.branchReady) return;
    const blob = await this.request("branch.create", "POST", `/repos/${this.repo}/git/blobs`, { content: BRANCH_README, encoding: "utf-8" });
    if (blob.status < 200 || blob.status >= 300) throw this.fail("branch.create", blob.status);
    const tree = await this.request("branch.create", "POST", `/repos/${this.repo}/git/trees`, {
      tree: [{ path: "README.md", mode: "100644", type: "blob", sha: shaOf(blob.data) }],
    });
    if (tree.status < 200 || tree.status >= 300) throw this.fail("branch.create", tree.status);
    const commit = await this.request("branch.create", "POST", `/repos/${this.repo}/git/commits`, {
      message: "Initialize report attachments",
      tree: shaOf(tree.data),
      parents: [],
    });
    if (commit.status < 200 || commit.status >= 300) throw this.fail("branch.create", commit.status);
    const ref = await this.request("branch.create", "POST", `/repos/${this.repo}/git/refs`, {
      ref: `refs/heads/${this.branch}`,
      sha: shaOf(commit.data),
    });
    if (ref.status === 422 && /already exists/i.test(ref.text)) {
      this.branchReady = true;
      return;
    }
    if (ref.status < 200 || ref.status >= 300) throw this.fail("branch.create", ref.status);
    this.branchReady = true;
  }

  private async rewriteBranch(cutoffDay: number): Promise<void> {
    const ref = await this.request("prune.ref", "GET", `/repos/${this.repo}/git/ref/heads/${encodePath(this.branch)}`);
    if (ref.status === 404) return;
    if (ref.status < 200 || ref.status >= 300) throw this.fail("prune.ref", ref.status);
    const head = shaOf(asRecord(ref.data)?.object);
    if (!head) throw this.fail("prune.ref", ref.status);
    const listing = await this.request("prune.tree", "GET", `/repos/${this.repo}/git/trees/${head}?recursive=1`);
    if (listing.status < 200 || listing.status >= 300) throw this.fail("prune.tree", listing.status);
    // A truncated listing does not name every file: rewriting from it would
    // drop reports that are still within retention. Wait for a person.
    if (asRecord(listing.data)?.truncated === true) throw this.fail("prune.tree.truncated", listing.status);
    const entries = asArray(asRecord(listing.data)?.tree);
    const kept: Array<Record<string, unknown>> = [];
    let dropped = 0;
    for (const entry of entries) {
      const record = asRecord(entry);
      if (!record || typeof record.path !== "string") continue;
      // Only files: a recursive listing also names every folder, and keeping
      // a folder entry would carry its old contents into the new tree.
      if (record.type !== "blob") continue;
      const date = dateOfPath(record.path);
      if (date !== null && date < cutoffDay) { dropped++; continue; }
      kept.push({ path: record.path, mode: record.mode, type: record.type, sha: record.sha });
    }
    if (dropped === 0) return;
    const tree = await this.request("prune.tree.create", "POST", `/repos/${this.repo}/git/trees`, { tree: kept });
    if (tree.status < 200 || tree.status >= 300) throw this.fail("prune.tree.create", tree.status);
    const commit = await this.request("prune.commit", "POST", `/repos/${this.repo}/git/commits`, {
      message: "Prune report attachments",
      tree: shaOf(tree.data),
      parents: [],
    });
    if (commit.status < 200 || commit.status >= 300) throw this.fail("prune.commit", commit.status);
    const update = await this.request("prune.ref.update", "PATCH", `/repos/${this.repo}/git/refs/heads/${encodePath(this.branch)}`, {
      sha: shaOf(commit.data),
      force: true,
    });
    if (update.status < 200 || update.status >= 300) throw this.fail("prune.ref.update", update.status);
  }

  private async closeStaleIssues(cutoff: number): Promise<number> {
    let closed = 0;
    for (let page = 1; page <= 10; page++) {
      const listing = await this.request(
        "prune.issues",
        "GET",
        `/repos/${this.repo}/issues?labels=nightly-report&state=open&sort=updated&direction=asc&per_page=100&page=${page}`,
      );
      if (listing.status < 200 || listing.status >= 300) throw this.fail("prune.issues", listing.status);
      const issues = asArray(listing.data);
      if (issues.length === 0) break;
      let stop = false;
      for (const entry of issues) {
        const issue = asRecord(entry);
        if (!issue || !Number.isInteger(issue.number)) continue;
        const updated = typeof issue.updated_at === "string" ? Date.parse(issue.updated_at) : Number.NaN;
        if (!Number.isFinite(updated) || updated >= cutoff) { stop = true; break; }
        const labels = asArray(issue.labels)
          .map((label) => (typeof label === "string" ? label : asRecord(label)?.name))
          .filter((name): name is string => typeof name === "string");
        if (labels.includes("keep") || labels.includes("triaged")) continue;
        const update = await this.request("prune.issue", "PATCH", `/repos/${this.repo}/issues/${issue.number as number}`, {
          state: "closed",
          state_reason: "not_planned",
        });
        if (update.status < 200 || update.status >= 300) throw this.fail("prune.issue", update.status);
        closed++;
      }
      if (stop || issues.length < 100) break;
    }
    return closed;
  }

  private fail(operation: string, status: number): GitHubFailure {
    if (status !== 0) this.logger?.({ github: operation, status });
    return new GitHubFailure(operation, status);
  }

  private async request(operation: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown; text: string }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "polyth-report-relay",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      const response = await this.fetchFn(`${this.apiBase}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await response.text().catch(() => "");
      let data: unknown = null;
      if (text) { try { data = JSON.parse(text) as unknown; } catch { data = null; } }
      return { status: response.status, data, text };
    } catch {
      // Network failure or timeout: a GitHub line with status 0, nothing else.
      this.logger?.({ github: operation, status: 0 });
      return { status: 0, data: null, text: "" };
    }
  }
}
