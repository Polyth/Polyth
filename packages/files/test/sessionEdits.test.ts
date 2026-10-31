import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, RouteRequest, SessionEvent, SessionProjection, SpaceContext } from "@polyth/contracts";
import {
  parseCursors,
  scanSessionEdits,
  sessionEditsRoute,
  type SessionEditsDeps,
  type SessionEditsResponse,
} from "../src/sessionEdits.ts";

const NOW = 1_700_000_000_000;

function eventLog(rows: Array<[type: string, data: JsonObject, time?: number]>): SessionEvent[] {
  return rows.map(([type, data, time], index) => ({
    id: `e${index + 1}`, sessionId: "s", seq: index + 1, time: time ?? NOW - 1_000, type, data, v: 1,
  }));
}

function fakeStore(logs: Record<string, SessionEvent[]>): SessionEditsDeps["store"] & { reads: number } {
  const store = {
    reads: 0,
    latestSeq: async (sessionId: string) => logs[sessionId]?.at(-1)?.seq ?? 0,
    events: async () => [],
    eventsOfTypes: async (sessionId: string, types: readonly string[], after: number, through: number, limit = 500) => {
      store.reads++;
      return (logs[sessionId] ?? [])
        .filter((event) => types.includes(event.type) && event.seq > after && event.seq <= through)
        .slice(0, limit);
    },
  };
  return store;
}

const edit = (callId: string, file: string, after = "next", before = "prev"): Array<[string, JsonObject]> => [
  ["tool/call", { callId, tool: "Edit", input: { file_path: file, old_string: before, new_string: after } }],
  ["tool/result", { callId, output: "ok" }],
];

test("scan folds completed edit calls and skips reads, errors and unfinished calls", async () => {
  const log = eventLog([
    ...edit("a", "/repo/src/a.ts"),
    ["tool/call", { callId: "r", tool: "Read", input: { file_path: "/repo/src/a.ts" } }],
    ["tool/result", { callId: "r", output: "contents" }],
    ["tool/call", { callId: "x", tool: "Edit", input: { file_path: "/repo/x.ts", old_string: "a", new_string: "b" } }],
    ["tool/error", { callId: "x", error: "no match" }],
    ["tool/call", { callId: "w", tool: "Write", input: { file_path: "/repo/w.ts", content: "body" } }],
  ]);
  const scan = await scanSessionEdits(fakeStore({ s: log }), "s", 0, { rows: 3_000 }, NOW);
  assert.deepEqual(scan.calls.map((call) => [call.callId, call.changedFiles]), [["a", ["/repo/src/a.ts"]]]);
  assert.equal(scan.calls[0]!.input.new_string, "next");
  // The running Write holds the cursor so its result is read with its input.
  assert.equal(scan.cursor, 6);
  assert.equal(scan.more, false);
});

test("a stale unfinished call never pins the cursor", async () => {
  const log = eventLog([
    ["tool/call", { callId: "w", tool: "Write", input: { file_path: "/repo/w.ts", content: "body" } }, NOW - 60 * 60_000],
    ...edit("a", "/repo/a.ts"),
  ]);
  const scan = await scanSessionEdits(fakeStore({ s: log }), "s", 0, { rows: 3_000 }, NOW);
  assert.equal(scan.cursor, 3);
});

test("a cursor reads only newer calls; a cursor past the log starts over", async () => {
  const log = eventLog([...edit("a", "/repo/a.ts"), ...edit("b", "/repo/b.ts")]);
  const store = fakeStore({ s: log });
  const next = await scanSessionEdits(store, "s", 2, { rows: 3_000 }, NOW);
  assert.deepEqual(next.calls.map((call) => call.callId), ["b"]);
  assert.equal(next.cursor, 4);
  const reset = await scanSessionEdits(store, "s", 99, { rows: 3_000 }, NOW);
  assert.deepEqual(reset.calls.map((call) => call.callId), ["a", "b"]);
});

test("the row budget bounds one request and reports more", async () => {
  const rows = Array.from({ length: 30 }, (_, index) => edit(`c${index}`, `/repo/f${index}.ts`)).flat();
  const store = fakeStore({ s: eventLog(rows) });
  const first = await scanSessionEdits(store, "s", 0, { rows: 10 }, NOW);
  assert.equal(first.more, true);
  assert.equal(first.calls.length, 5);
  const rest = await scanSessionEdits(store, "s", first.cursor, { rows: 3_000 }, NOW);
  assert.equal(rest.more, false);
  assert.equal(first.calls.length + rest.calls.length, 30);
});

test("oversized strings are dropped and the call is flagged, paths still come from the full payload", async () => {
  const huge = "x".repeat(70 * 1024);
  const log = eventLog([
    ["tool/call", { callId: "w", tool: "Write", input: { file_path: "/repo/big.ts", content: huge } }],
    ["tool/result", { callId: "w", output: "ok" }],
  ]);
  const scan = await scanSessionEdits(fakeStore({ s: log }), "s", 0, { rows: 3_000 }, NOW);
  assert.deepEqual(scan.calls[0]!.changedFiles, ["/repo/big.ts"]);
  assert.equal(scan.calls[0]!.input.content, undefined);
  assert.equal(scan.calls[0]!.truncated, true);
});

test("late result input (Codex file changes) counts like the web reducer", async () => {
  const log = eventLog([
    ["tool/result", { callId: "c", tool: "edit", output: "File changes applied", input: { changes: [{ path: "/repo/c.ts", diff: "@@ -1 +1 @@\n-a\n+b" }] } }],
  ]);
  const scan = await scanSessionEdits(fakeStore({ s: log }), "s", 0, { rows: 3_000 }, NOW);
  assert.deepEqual(scan.calls[0]!.changedFiles, ["/repo/c.ts"]);
});

test("parseCursors keeps only well-formed ids and sequences", () => {
  assert.deepEqual([...parseCursors("a:1,b:-2,../x:3,c:4.5,d:7")], [["a", 1], ["d", 7]]);
  assert.equal(parseCursors(null).size, 0);
});

// ---- route --------------------------------------------------------------------

const space = { spaceId: "owner", userId: "owner", storageDir: "/tmp" } as SpaceContext;
const project = { id: "p", name: "P", spaceId: "owner", path: "/repo" };
const session = (id: string, extra: Partial<SessionProjection> = {}): SessionProjection => ({
  id, projectId: "p", spaceId: "owner", title: `Chat ${id}`, status: "idle", createdAt: NOW - 10_000, updatedAt: NOW - 1_000, ...extra,
} as SessionProjection);

function routeFixture(sessions: SessionProjection[], logs: Record<string, SessionEvent[]>, hidden: string[] = []) {
  const deps: SessionEditsDeps = {
    now: () => NOW,
    store: fakeStore(logs),
    forSpace: () => ({
      projects: { get: async (id: string) => id === "p" ? project : undefined } as never,
      sessions: {
        snapshot: async (id: string) => {
          const found = sessions.find((candidate) => candidate.id === id);
          if (!found || hidden.includes(id)) throw Object.assign(new Error("not found"), { code: "not-found" });
          return found;
        },
        summaries: async () => ({ sessions: sessions.filter((candidate) => !hidden.includes(candidate.id)), complete: true, revision: 1 }),
        list: async () => sessions,
      } as never,
    }),
  };
  const route = sessionEditsRoute(deps);
  return async (query: string): Promise<{ status: number; body: SessionEditsResponse | null; handled: boolean }> => {
    let status = 0;
    let body: SessionEditsResponse | null = null;
    const request = {
      path: "/api/files/session-edits",
      method: "GET",
      url: new URL(`http://localhost/api/files/session-edits?${query}`),
      space,
      json: (code: number, value: unknown) => { status = code; body = value as SessionEditsResponse; },
    } as unknown as RouteRequest;
    const handled = await route(request);
    return { status, body, handled };
  };
}

test("route reports the viewer and the chats sharing its checkout, never isolated or hidden ones", async () => {
  const sessions = [
    session("viewer"),
    session("child", { parentId: "viewer" }),
    session("isolated", { worktreePath: "/worktrees/isolated" }),
    session("private"),
    session("old", { updatedAt: NOW - 30 * 24 * 60 * 60_000 }),
    session("archived", { status: "archived" }),
  ];
  const logs = Object.fromEntries(sessions.map((candidate) => [candidate.id, eventLog(edit(`${candidate.id}-1`, `/repo/${candidate.id}.ts`))]));
  const get = routeFixture(sessions, logs, ["private"]);
  const { status, body } = await get("projectId=p&sessionId=viewer");
  assert.equal(status, 200);
  assert.deepEqual(body!.sources.map((source) => [source.sessionId, source.viewer]), [["viewer", true], ["child", false]]);
  assert.equal(body!.sources[1]!.parentId, "viewer");
  assert.deepEqual(body!.sources[1]!.calls[0]!.changedFiles, ["/repo/child.ts"]);
});

test("route honours cursors and keeps a tracked older chat", async () => {
  const sessions = [session("viewer"), session("old", { updatedAt: NOW - 30 * 24 * 60 * 60_000 })];
  const logs = {
    viewer: eventLog([...edit("v1", "/repo/a.ts"), ...edit("v2", "/repo/b.ts")]),
    old: eventLog(edit("o1", "/repo/o.ts")),
  };
  const get = routeFixture(sessions, logs);
  const { body } = await get("projectId=p&sessionId=viewer&cursors=viewer:2,old:0");
  assert.deepEqual(body!.sources.map((source) => [source.sessionId, source.calls.map((call) => call.callId)]), [
    ["viewer", ["v2"]],
    ["old", ["o1"]],
  ]);
});

test("route rejects a missing project, a foreign session and an unknown repository", async () => {
  const get = routeFixture([session("viewer"), session("foreign", { projectId: "other" })], {});
  await assert.rejects(get("projectId=nope"), (error: { code?: string }) => error.code === "not-found");
  await assert.rejects(get("projectId=p&sessionId=foreign"), (error: { code?: string }) => error.code === "not-found");
  await assert.rejects(get("projectId=p&sessionId=missing"), (error: { code?: string }) => error.code === "not-found");
  await assert.rejects(get("projectId=p&repositoryId=ghost"), (error: { code?: string }) => error.code === "not-found");
  await assert.rejects(get(""), (error: { code?: string }) => error.code === "invalid-input");
  const other = await routeFixture([], {})("projectId=p").catch(() => null);
  assert.ok(other?.handled);
});
