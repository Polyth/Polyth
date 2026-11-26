import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEventPublication, AgentEventSources, AgentEventSubscription } from "@polyth/plugins";
import {
  createGithubRepoWatch,
  GITHUB_EVENT_SOURCE,
  parseGhInclude,
  reposOf,
  type GhApiAnswer,
  type RepoWatchAccess,
  type WatchCursor,
} from "../src/repoWatch.ts";

const sha = (n: number) => String(n % 10).repeat(40);

/** A fake GitHub: endpoint → answer; records every call and its account. */
function fakeGithub() {
  const answers = new Map<string, () => GhApiAnswer>();
  const calls: Array<{ account: string; args: string[] }> = [];
  const api = (account: string) => async (args: string[]): Promise<GhApiAnswer> => {
    calls.push({ account, args });
    const endpoint = args.includes("graphql") ? `graphql:${args.find((arg) => arg.startsWith("query="))?.includes("UPDATED_AT") ? "comments" : "discussions"}` : args.at(-1)!;
    const answer = answers.get(endpoint.split("?")[0]!);
    if (!answer) return { status: 404, body: { message: "Not Found" } };
    const value = answer();
    const sent = args.find((arg) => arg.startsWith("If-None-Match: "))?.slice("If-None-Match: ".length);
    if (sent && value.etag === sent) return { status: 304, body: null };
    return value;
  };
  return { answers, calls, api };
}

function harness(subs: AgentEventSubscription[], opts: { refuse?: string } = {}) {
  const github = fakeGithub();
  const published: AgentEventPublication[] = [];
  const sources: AgentEventSources = {
    register: () => ({ dispose() {} }),
    publish: (event) => { published.push(event); },
    subscribed: () => [],
    subscriptions: (source) => source === "github" ? subs : [],
  };
  const stored = new Map<string, Record<string, WatchCursor>>();
  let clock = 1_000_000;
  const watch = createGithubRepoWatch({
    sources: () => sources,
    projectRepo: async (projectId) => projectId === "prj" ? { repo: "Owner/Own", host: "github.com" } : undefined,
    access: async (sub): Promise<RepoWatchAccess> => opts.refuse
      ? { refused: opts.refuse }
      : { key: `${sub.ownerUserId}:account`, api: github.api(sub.ownerUserId ?? "nobody") },
    load: (spaceId) => structuredClone(stored.get(spaceId) ?? {}),
    save: (spaceId, cursors) => { stored.set(spaceId, structuredClone(cursors)); },
    now: () => clock,
    graphqlEveryMs: 5 * 60_000,
    warn: () => {},
  });
  return { watch, github, published, stored, advance: (ms: number) => { clock += ms; } };
}

const sub = (over: Partial<AgentEventSubscription> = {}): AgentEventSubscription => ({
  spaceId: "spc", projectId: "prj", agentId: "agent-1", triggerId: "t", ownerUserId: "u",
  types: ["issue-opened"], filters: [{ field: "repo", op: "equals", value: "Polyth/Reports" }], ...over,
});

test("the source names its types and filter fields", () => {
  assert.equal(GITHUB_EVENT_SOURCE.id, "github");
  assert.ok(GITHUB_EVENT_SOURCE.types.some((type) => type.id === "discussion-opened"));
  assert.ok(GITHUB_EVENT_SOURCE.fields?.some((field) => field.id === "repo"));
});

test("a wake names its repositories with repo-equals filters; anything else is ignored", () => {
  assert.deepEqual(reposOf(sub({ filters: [
    { field: "repo", op: "equals", value: " Polyth/Reports " },
    { field: "repo", op: "equals", value: "https://github.com/a/b.git" },
    { field: "repo", op: "contains", value: "x/y" },
    { field: "repo", op: "equals", value: "../../etc" },
    { field: "repo", op: "equals", value: "--paginate/x y" },
  ] })), ["polyth/reports", "a/b"]);
});

test("gh api -i output parses into status, ETag and body", () => {
  assert.deepEqual(parseGhInclude('HTTP/2.0 200 OK\r\nEtag: "abc"\r\nX: y\r\n\r\n[{"a":1}]'), { status: 200, etag: '"abc"', body: [{ a: 1 }] });
  assert.deepEqual(parseGhInclude("HTTP/2.0 304 Not Modified\nEtag: W/\"q\"\n\n"), { status: 304, etag: 'W/"q"', body: null });
  assert.equal(parseGhInclude("gh: not logged in"), undefined);
});

test("the first read is a baseline; later new issues and pull requests wake the wake, once, with their facts", async () => {
  const { watch, github, published } = harness([sub({ types: ["issue-opened", "pull-request-opened"] })]);
  let issues = [{ number: 2, title: "old", html_url: "u2", user: { login: "a" }, labels: [] }];
  github.answers.set("repos/polyth/reports/issues", () => ({ status: 200, etag: `"${issues.length}"`, body: issues }));
  assert.equal(await watch.tick(), 0, "what already exists is not news");
  issues = [
    { number: 4, title: "Crash on open", html_url: "https://github.com/polyth/reports/pull/4", user: { login: "b" }, labels: [], pull_request: {} } as never,
    { number: 3, title: "[1.2.0] Button dead", html_url: "https://github.com/polyth/reports/issues/3", user: { login: "c" }, labels: [{ name: "nightly-report" }], body: "Steps…" } as never,
    ...issues,
  ];
  assert.equal(await watch.tick(), 2);
  assert.deepEqual(published.map((event) => [event.type, event.title, event.fields?.repo, event.fields?.labels, event.target]), [
    ["issue-opened", "#3 [1.2.0] Button dead", "polyth/reports", "nightly-report", { agentId: "agent-1", triggerId: "t" }],
    ["pull-request-opened", "#4 Crash on open", "polyth/reports", "", { agentId: "agent-1", triggerId: "t" }],
  ]);
  assert.equal(published[0]!.spaceId, "spc");
  assert.equal(published[0]!.projectId, "prj");
  assert.equal(await watch.tick(), 0, "an unchanged repository answers 304 and publishes nothing");
  const last = github.calls.at(-1)!.args;
  assert.ok(last.includes(`If-None-Match: "3"`), "the poll is conditional");
});

test("only the feeds a wake listens to are read, and each event reaches only wakes of its type", async () => {
  const { watch, github, published } = harness([
    sub({ agentId: "issues", types: ["issue-opened"] }),
    sub({ agentId: "comments", types: ["comment"] }),
  ]);
  github.answers.set("repos/polyth/reports/issues", () => ({ status: 200, body: [] }));
  github.answers.set("repos/polyth/reports/issues/comments", () => ({ status: 200, body: [] }));
  await watch.tick();
  const endpoints = github.calls.map((call) => call.args.at(-1)!.split("?")[0]);
  assert.deepEqual(endpoints.sort(), ["repos/polyth/reports/issues", "repos/polyth/reports/issues/comments"]);
  github.answers.set("repos/polyth/reports/issues/comments", () => ({ status: 200, body: [
    { id: 10, issue_url: "https://api.github.com/repos/polyth/reports/issues/3", html_url: "c10", user: { login: "x" }, body: "same here" },
  ] }));
  await watch.tick();
  assert.deepEqual(published.map((event) => [event.type, event.target?.agentId, event.fields?.number]), [["comment", "comments", "3"]]);
});

test("new commits are reported per branch with their messages and changed files", async () => {
  const { watch, github, published } = harness([sub({ types: ["push"], filters: [{ field: "repo", op: "equals", value: "polyth/reports" }] })]);
  let heads = [{ name: "attachments", commit: { sha: sha(1) } }];
  github.answers.set("repos/polyth/reports/branches", () => ({ status: 200, etag: `"${heads[0]!.commit.sha}"`, body: heads }));
  github.answers.set(`repos/polyth/reports/compare/${sha(1)}...${sha(2)}`, () => ({ status: 200, body: {
    total_commits: 1, html_url: "https://github.com/polyth/reports/compare/x",
    commits: [{ sha: sha(2), author: { login: "bot" }, commit: { message: "report 543dfee5\n\nbody" } }],
    files: [{ filename: "reports/2026-11-23/543dfee5/report.json" }, { filename: "reports/2026-11-23/543dfee5/screenshot.jpg" }],
  } }));
  await watch.tick();
  heads = [{ name: "attachments", commit: { sha: sha(2) } }];
  await watch.tick();
  assert.equal(published.length, 1);
  const [event] = published;
  assert.equal(event!.type, "push");
  assert.equal(event!.title, "1 new commit on attachments: report 543dfee5");
  assert.equal(event!.fields?.branch, "attachments");
  assert.match(event!.fields?.paths ?? "", /^reports\/2026-11-23\/543dfee5\/report\.json\n/);
  assert.match(event!.fields?.text ?? "", /2222222 report 543dfee5 \(bot\)/);
});

test("without a repo filter a wake watches its project's own GitHub remote", async () => {
  const { watch, github } = harness([sub({ filters: [] })]);
  github.answers.set("repos/owner/own/issues", () => ({ status: 200, body: [] }));
  await watch.tick();
  assert.equal(github.calls[0]!.args.at(-1)!.split("?")[0], "repos/owner/own/issues");
});

test("each owner's wakes poll with that owner's account, never another's", async () => {
  const { watch, github, published } = harness([
    sub({ agentId: "a", ownerUserId: "alice" }),
    sub({ agentId: "b", ownerUserId: "bob" }),
  ]);
  let issues: unknown[] = [];
  github.answers.set("repos/polyth/reports/issues", () => ({ status: 200, body: issues }));
  await watch.tick();
  assert.deepEqual(github.calls.map((call) => call.account).sort(), ["alice", "bob"], "one poll per account");
  issues = [{ number: 1, title: "x", html_url: "", user: { login: "z" }, labels: [] }];
  await watch.tick();
  // Each account's read reaches only its own owner's agent.
  assert.deepEqual(published.map((event) => event.target?.agentId).sort(), ["a", "b"]);
});

test("a refused owner polls nothing and publishes nothing", async () => {
  const { watch, github, published } = harness([sub()], { refuse: "Connect your GitHub account." });
  assert.equal(await watch.tick(), 0);
  assert.equal(github.calls.length, 0);
  assert.equal(published.length, 0);
});

test("cursors persist: events while the server was down arrive after a restart, and discussions are read less often", async () => {
  const first = harness([sub({ types: ["discussion-opened"] })]);
  let nodes: unknown[] = [{ number: 5, title: "old", url: "d5", author: { login: "a" }, category: { name: "Ideas" } }];
  first.github.answers.set("graphql:discussions", () => ({ status: 200, body: { data: { repository: { discussions: { nodes } } } } }));
  await first.watch.tick();
  nodes = [{ number: 6, title: "Bug in voice mode?", url: "d6", author: { login: "b" }, category: { name: "Q&A" }, body: "…" }, ...nodes];
  first.advance(60_000);
  await first.watch.tick();
  assert.equal(first.published.length, 0, "the GraphQL feed waits out its interval");
  first.advance(5 * 60_000);
  await first.watch.tick();
  assert.deepEqual(first.published.map((event) => [event.type, event.title, event.fields?.category]), [["discussion-opened", "Discussion #6 Bug in voice mode?", "Q&A"]]);
  const saved = [...first.stored.values()][0]!;
  assert.equal(Object.values(saved)[0]!.discussion, 6);
  assert.doesNotMatch(JSON.stringify(saved), /token|alice|etag/i, "only cursors are stored");
});
