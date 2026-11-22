import type { BugReportResult } from "@polyth/contracts/bug-report";

/** What the relay writes to its log: one line per HTTP request, plus one line
 *  per failed GitHub call. Never a password, report text, contact, settings,
 *  screenshot, install id or source address. */
export type RelayLogEvent =
  | { route: "report" | "health" | "not-found"; result: BugReportResult["result"] | "ok" | "not-found"; status: number; latencyMs: number }
  | { github: string; status: number };

export type RelayLogger = (event: RelayLogEvent) => void;

/** The narrow GitHub surface the relay needs. `GitHubClient` is the real
 *  implementation; tests inject a fake, so no test ever reaches github.com. */
export interface RelayGitHub {
  createIssue(input: { title: string; body: string; labels: string[] }): Promise<{ number: number }>;
  comment(input: { issue: number; body: string }): Promise<void>;
  /** `null` when the issue is not visible (deleted or transferred). */
  issueState(issue: number): Promise<"open" | "closed" | null>;
  /** `content` is standard base64; the client PUTs it to the contents API. */
  uploadFile(input: { path: string; content: string; message: string }): Promise<void>;
  /** Rewrites the attachments branch (last `keepDays`) and closes stale
   *  `nightly-report` issues. Returns how many issues it closed. */
  prune(input: { keepDays: number; now: number }): Promise<{ closed: number }>;
}

/** A GitHub call failed: `operation` names it for the log, `status` is the
 *  HTTP status (0 for a network failure/timeout). The message never carries
 *  GitHub's error text. */
export class GitHubFailure extends Error {
  readonly operation: string;
  readonly status: number;

  constructor(operation: string, status: number) {
    super(`${operation}:${status}`);
    this.operation = operation;
    this.status = status;
  }
}
