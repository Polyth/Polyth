import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BugReportPayload, BugReportScreenshot } from "@polyth/contracts/bug-report";

import { createReportRelay, type ReportRelayOptions } from "../src/index.ts";
import { startReportRelayHttpServer } from "../src/http.ts";
import { hashPassword } from "../src/password.ts";
import type { RelayGitHub, RelayLogEvent } from "../src/types.ts";

/** Test fixtures. Every directory this file creates is removed by `cleanup`,
 *  which also satisfies scripts/test/tempHygiene.test.ts. */
export const PASSWORD = "tester-password-123";
export const REPO = "Polyth/private-nightly-reports";

export interface Fixture {
  dir: string;
  keys: string;
  data: string;
  cleanup: () => void;
}

export function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "polyth-report-relay-"));
  const keys = join(dir, "keys");
  const data = join(dir, "data");
  mkdirSync(keys);
  mkdirSync(data);
  writeFileSync(join(keys, "password.scrypt"), `${hashPassword(PASSWORD)}\n`);
  writeFileSync(join(keys, "github.json"), JSON.stringify({ repo: REPO, branch: "attachments" }));
  writeFileSync(join(keys, "github-token"), "github_pat_test_token_1234567890");
  return { dir, keys, data, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function report(overrides: Partial<BugReportPayload> = {}): BugReportPayload {
  return {
    version: 1,
    reportId: "aaaabbbb-1111-4222-8333-444444444444",
    install: "a".repeat(32),
    createdAt: new Date().toISOString(),
    app: {
      version: "1.2.3-nightly",
      channel: "nightly",
      edition: "standard",
      platform: "darwin",
      arch: "arm64",
      osVersion: "24.6.0",
      electron: "38.2.0",
      chromium: "140.0.0.0",
      packaged: true,
      locale: "en-US",
    },
    web: { build: "build-1", serverVersion: "", view: "chat", viewport: { width: 1440, height: 900, scale: 2 } },
    settings: { "appearance.theme": "dark" },
    packages: [{ id: "git", version: "1.0.0" }],
    errors: [],
    text: "It froze when I opened a session",
    contact: "",
    screenshot: null,
    ...overrides,
  };
}

/** A tiny byte string that starts like a JPEG (`FF D8 FF`) and is valid base64. */
export function screenshot(): BugReportScreenshot {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  return { type: "image/jpeg", width: 320, height: 200, data: bytes.toString("base64") };
}

export const uuid = (n: number): string => `${String(n).padStart(4, "0")}aaaa-1111-4222-8333-444444444444`;

interface FakeIssue { number: number; title: string; body: string; labels: string[]; state: "open" | "closed" }

/** A fully offline GitHub: it records what the relay would have filed. */
export class FakeGitHub implements RelayGitHub {
  readonly issues: FakeIssue[] = [];
  readonly comments: Array<{ issue: number; body: string }> = [];
  readonly uploads: Array<{ path: string; content: string; message: string }> = [];
  readonly states = new Map<number, "open" | "closed">();
  readonly pruned: Array<{ keepDays: number; now: number }> = [];
  failures: number = 0;
  private nextNumber = 100;

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<{ number: number }> {
    if (this.failures > 0) { this.failures--; throw new Error("github unavailable"); }
    const number = this.nextNumber++;
    this.issues.push({ number, title: input.title, body: input.body, labels: [...input.labels], state: "open" });
    this.states.set(number, "open");
    return { number };
  }

  async comment(input: { issue: number; body: string }): Promise<void> {
    if (this.failures > 0) { this.failures--; throw new Error("github unavailable"); }
    this.comments.push({ issue: input.issue, body: input.body });
  }

  async issueState(issue: number): Promise<"open" | "closed" | null> {
    if (this.failures > 0) { this.failures--; throw new Error("github unavailable"); }
    return this.states.get(issue) ?? null;
  }

  async uploadFile(input: { path: string; content: string; message: string }): Promise<void> {
    if (this.failures > 0) { this.failures--; throw new Error("github unavailable"); }
    this.uploads.push({ ...input });
  }

  async prune(input: { keepDays: number; now: number }): Promise<{ closed: number }> {
    this.pruned.push(input);
    return { closed: 0 };
  }

  /** Every call that reached GitHub, so a test can prove an idempotent repeat made none. */
  get calls(): number {
    return this.issues.length + this.comments.length + this.uploads.length + this.pruned.length;
  }

  issue(number: number): FakeIssue | undefined {
    return this.issues.find((entry) => entry.number === number);
  }

  content(path: string): string | undefined {
    return this.uploads.find((upload) => upload.path === path)?.content;
  }
}

export interface Served {
  fixture: Fixture;
  github: FakeGitHub;
  logs: RelayLogEvent[];
  url: string;
  post: (body: unknown, headers?: Record<string, string>) => Promise<Response>;
  get: (path: string) => Promise<Response>;
  close: () => Promise<void>;
}

export async function serve(options: ReportRelayOptions = {}): Promise<Served> {
  const base = fixture();
  const github = new FakeGitHub();
  const logs: RelayLogEvent[] = [];
  const relay = createReportRelay({
    keysDir: base.keys,
    dataDir: base.data,
    logger: (event) => logs.push(event),
    allowVersion: () => true,
    pruneAtStart: false,
    ...options,
    github: options.github === undefined ? github : options.github,
  });
  const server = await startReportRelayHttpServer(relay, { host: "127.0.0.1", port: 0, testMode: true });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const url = `http://127.0.0.1:${address.port}`;
  let closed = false;
  return {
    fixture: base,
    github,
    logs,
    url,
    post: (body, headers = {}) => fetch(`${url}/v1/report`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${PASSWORD}`, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    get: (path) => fetch(`${url}${path}`),
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        server.close(() => { relay.close(); base.cleanup(); resolve(); });
        server.closeAllConnections();
      });
    },
  };
}
