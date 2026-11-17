// A chat referenced from a message with `[@Title](polyth://session/<id>)`: the
// server re-checks every token on the admitted message, drops what the author
// or any reader cannot open without saying so, and records one
// `<polyth-mentioned-chats>` block with the turn context before delivery.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRuntime, CanonicalTurnRequest, ProjectService, RuntimeCapabilities } from "@polyth/contracts";
import { MAX_SESSION_MENTIONS, sessionMentionIds, sessionMentionToken } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createCanonicalSecurity } from "../src/canonicalSecurity.ts";
import { bindCanonicalSecurity } from "../src/runtimeSecurity.ts";
import { createSessionService } from "../src/sessions.ts";
import { chatMentionCandidates } from "../src/sessionSharing.ts";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "polyth-chat-mention-"));
  const security = createCanonicalSecurity({ dataDir: root, origin: "http://127.0.0.1:4400", localOnly: true });
  security.control.transaction(() => {
    security.control.run("INSERT INTO organizations(id,name,slug) VALUES('org_home','Home','home')");
    for (const space of ["spc_home", "spc_x"]) {
      security.control.run("INSERT INTO spaces(id,org_id,name,storage_identity,kind,created_at_ms,updated_at_ms) VALUES(?,'org_home',?,?,'shared',1,1)", space, space, space);
    }
    for (const [id, name, role] of [["usr_olia", "Olia", "owner"], ["usr_taras", "Taras", "member"]] as const) {
      security.control.run("INSERT INTO principals(id,kind,status) VALUES(?,'user','active')", id);
      security.control.run("INSERT INTO users(id,display_name,created_at_ms,updated_at_ms) VALUES(?,?,1,1)", id, name);
      security.control.run("INSERT INTO space_memberships(space_id,principal_id,role,created_at_ms) VALUES('spc_home',?,?,1)", id, role);
    }
    security.control.run(`INSERT INTO resources(id,kind,org_id,space_id,owner_principal_id,created_by,visibility,lifecycle,created_at_ms,updated_at_ms)
      VALUES('p','project','org_home','spc_home','usr_olia','usr_olia','space','active',1,1)`);
  });
  const binding = bindCanonicalSecurity(security);
  t.after(() => { binding.dispose(); security.close(); rmSync(root, { recursive: true, force: true }); });
  const store = createStore(":memory:");
  const requests: CanonicalTurnRequest[] = [];
  const failNext = { value: false };
  const runtime = {
    harnessId: "fake",
    capabilities: async () => ({ steering: false, streaming: true, permissions: false, questions: false, compaction: false, subagents: false }) as RuntimeCapabilities,
    commands: async () => [], models: async () => [], agents: async () => [],
    ensureSession: async ({ sessionId }: { sessionId: string }) => `native-${sessionId}`,
    sessions: async () => [], history: async () => [],
    async startTurn(request: CanonicalTurnRequest) {
      if (failNext.value) { failNext.value = false; throw new Error("delivery failed"); }
      requests.push(request);
    },
    abort: async () => {}, replyPermission: async () => {}, replyQuestion: async () => {},
    onEvent: () => ({ dispose: () => {} }), dispose: async () => {},
  } as unknown as AgentRuntime;
  const projects = {
    get: async (id: string) => id === "p" ? { id: "p", name: "p", path: "/tmp", spaceId: "spc_home", createdAt: 0 } : undefined,
    list: async () => [],
  } as unknown as ProjectService;
  const sessions = createSessionService({
    store, projects,
    runtimes: { forProject: async () => runtime },
    permissions: { evaluate: () => "allow" } as unknown as PermissionService,
    broadcast: { event() {}, projection() {} },
    queue: store,
    harnesses: { staticFeatures: () => ({ streaming: true, permissions: false, questions: false, compaction: false, subagents: false }) },
  } as never);
  const chat = async (title: string, visibility: "inherit" | "private", owner = "usr_olia") => {
    const { id } = await sessions.create({ projectId: "p", title });
    security.control.transaction(() => security.control.run(`INSERT INTO resources(id,kind,org_id,space_id,parent_id,owner_principal_id,created_by,visibility,lifecycle,created_at_ms,updated_at_ms)
      VALUES(?,'session','org_home','spc_home','p',?,?,?,'active',1,1)`, id, owner, owner, visibility));
    return id;
  };
  const prepared = async (id: string) => (await store.events(id)).filter((event) => event.type === "context/turn-prepared");
  return { sessions, store, requests, chat, prepared, failNext };
}

const OLIA = { userId: "usr_olia", name: "Olia" };
const BLOCK = "<polyth-mentioned-chats>";

test("a shared chat records a block with the live title, and only the live title", async (t) => {
  const f = await fixture(t);
  const from = await f.chat("Here", "inherit");
  const target = await f.chat("Renamed since", "inherit");
  await f.sessions.send(from, { text: `see ${sessionMentionToken(target, "Old label")} please`, clientOperationId: "op-1" }, { author: OLIA });
  const [record] = await f.prepared(from);
  const block = (record!.data as { modelVisibleText: string }).modelVisibleText;
  assert.match(block, new RegExp(`^<polyth-mentioned-chats>\\n"Renamed since" \\u2014 session ${target} \\u2014 last active (just now|\\d+ \\w+ ago)\\n`));
  assert.match(block, /Read one with the polyth tool \(session\.messages\) if you need its content\.\n<\/polyth-mentioned-chats>$/);
  assert.doesNotMatch(block, /Old label/);
  assert.ok(f.requests[0]!.text.includes(block), "delivered exactly as recorded");
});

test("a private chat is never offered or recorded in a chat other people read", async (t) => {
  const f = await fixture(t);
  const shared = await f.chat("Shared", "inherit");
  const secret = await f.chat("Secret plans", "private");
  const open = await f.chat("Open", "inherit");
  await f.sessions.send(shared, { text: `[@x](polyth://session/${secret}) and ${sessionMentionToken(open, "o")}`, clientOperationId: "op-1" }, { author: OLIA });
  const block = (await f.prepared(shared)).map((e) => (e.data as { modelVisibleText: string }).modelVisibleText).join("");
  assert.ok(block.includes(open));
  assert.ok(!block.includes(secret) && !block.includes("Secret plans"), "no trace of the private chat");

  const rows = (await f.store.projections("p")).filter((row): row is NonNullable<typeof row> => Boolean(row));
  const current = (await f.store.projection(shared))!;
  assert.deepEqual(chatMentionCandidates("spc_home", current, rows, "usr_olia").map((c) => c.sessionId), [open]);
  // In a private chat the author may reference any chat they can read.
  const own = (await f.store.projection(secret))!;
  assert.deepEqual(new Set(chatMentionCandidates("spc_home", own, rows, "usr_olia").map((c) => c.sessionId)), new Set([shared, open]));
});

test("picker list: newest first, never the current chat, archived, another project or Space", async (t) => {
  const f = await fixture(t);
  const current = await f.chat("Now", "inherit");
  const older = await f.chat("Older", "inherit");
  const newer = await f.chat("Newer", "inherit");
  const archived = await f.chat("Gone", "inherit");
  await f.store.upsertProjection({ ...(await f.store.projection(older))!, updatedAt: 10 });
  await f.store.upsertProjection({ ...(await f.store.projection(newer))!, updatedAt: 20 });
  await f.store.upsertProjection({ ...(await f.store.projection(archived))!, status: "archived" });
  const rows = [
    ...(await f.store.projections("p")).filter((row): row is NonNullable<typeof row> => Boolean(row)),
    { ...(await f.store.projection(older))!, id: "elsewhere", projectId: "other" },
    { ...(await f.store.projection(older))!, id: "foreign", spaceId: "spc_x" },
  ];
  const ids = chatMentionCandidates("spc_home", (await f.store.projection(current))!, rows, "usr_olia").map((c) => c.sessionId);
  assert.deepEqual(ids, [newer, older]);
});

test("forged, foreign, unreadable, archived, self and malformed tokens are dropped silently", async (t) => {
  const f = await fixture(t);
  const from = await f.chat("Here", "inherit");
  const theirs = await f.chat("Taras private", "private", "usr_taras");
  const archived = await f.chat("Gone", "inherit");
  await f.store.upsertProjection({ ...(await f.store.projection(archived))!, status: "archived" });
  await f.store.upsertProjection({
    ...(await f.store.projection(archived))!, id: "sess_foreign", spaceId: "spc_x", status: "idle", title: "Foreign Space",
  });
  const text = [theirs, archived, from, "sess_foreign", "missing-id"].map((id) => `[@t](polyth://session/${id})`).join(" ")
    + " [@x](polyth://session/) [@y](polyth://session/a b) [@z](polyth:/session/q) [@ no end(polyth://session/q";
  await f.sessions.send(from, { text, clientOperationId: "op-1" }, { author: OLIA });
  assert.equal((await f.prepared(from)).length, 0, "nothing valid, nothing recorded");
  assert.ok(!f.requests[0]!.text.includes(BLOCK));
  assert.ok(!f.requests[0]!.text.includes("Taras private"));
});

test("at most five distinct chats are listed", async (t) => {
  const f = await fixture(t);
  const from = await f.chat("Here", "inherit");
  const ids: string[] = [];
  for (let n = 0; n < 7; n += 1) ids.push(await f.chat(`Chat ${n}`, "inherit"));
  const text = [...ids, ids[0]!].map((id) => sessionMentionToken(id, "c")).join(" ");
  assert.equal(sessionMentionIds(text).length, MAX_SESSION_MENTIONS);
  await f.sessions.send(from, { text, clientOperationId: "op-1" }, { author: OLIA });
  const block = (await f.prepared(from)).map((e) => (e.data as { modelVisibleText: string }).modelVisibleText).join("");
  assert.equal(block.split("\n").filter((line) => line.includes(" — session ")).length, MAX_SESSION_MENTIONS);
});

test("a prompt that is not an admitted conversation turn gets no block", async (t) => {
  const f = await fixture(t);
  const from = await f.chat("Here", "inherit");
  const target = await f.chat("Target", "inherit");
  await f.sessions.send(from, { text: `keep warm ${sessionMentionToken(target, "t")}`, keepAlive: true, clientOperationId: "op-1" }, { author: OLIA });
  assert.equal((await f.prepared(from)).length, 0);
});

test("the token is parsed from text only: unknown shapes pass through untouched", () => {
  assert.deepEqual(sessionMentionIds("[@a](polyth://session/abc) [@a](polyth://session/abc) [@b](polyth://session/d_e-1)"), ["abc", "d_e-1"]);
  assert.deepEqual(sessionMentionIds("[@a](polyth://file/abc) [@](polyth://session/ )"), []);
  assert.equal(sessionMentionToken("s1", "A](x) <b> [y]"), "[@A x b y](polyth://session/s1)");
});

test("parsing is linear on unterminated openers (CodeQL js/polynomial-redos #154)", () => {
  const started = performance.now();
  assert.deepEqual(sessionMentionIds("[@".repeat(50_000)), []);
  assert.deepEqual(sessionMentionIds("[@](polyth://session/".repeat(10_000)), []);
  assert.ok(performance.now() - started < 1_000);
  const longest = sessionMentionToken("s1", "x".repeat(200));
  assert.deepEqual(sessionMentionIds(longest), ["s1"], "the longest label a token can carry still parses");
});

test("a retried operation keeps the recorded block even after the chat is renamed", async (t) => {
  const f = await fixture(t);
  const from = await f.chat("Here", "inherit");
  const target = await f.chat("First name", "inherit");
  const input = { text: `see ${sessionMentionToken(target, "t")}`, clientOperationId: "op-1" };
  await f.sessions.send(from, input, { author: OLIA });
  await f.store.upsertProjection({ ...(await f.store.projection(target))!, title: "Second name" });
  await f.sessions.send(from, input, { author: OLIA }).catch(() => undefined);
  const records = await f.prepared(from);
  assert.equal(records.length, 1, "one record per operation");
  assert.match((records[0]!.data as { modelVisibleText: string }).modelVisibleText, /First name/);
  assert.ok(f.requests.every((request) => !request.text.includes("Second name")));
});

test("a chat reference with nobody to vouch for it is never mentionable", async () => {
  const { isMentionableChat } = await import("../src/sessionSharing.ts");
  const current = { id: "s-current", projectId: "p1" };
  const target = { id: "s-other", projectId: "p1", spaceId: "space-1", status: "idle" } as const;
  assert.equal(isMentionableChat("space-1", current, target as never, []), false);
});

test("a replayed operation finds its recorded people block instead of assembling it again", async (t) => {
  const f = await fixture(t);
  const from = await f.chat("Here", "inherit");
  const input = { text: "hello there", clientOperationId: "op-people" };
  f.failNext.value = true;
  await f.sessions.send(from, input, { author: OLIA }).catch(() => undefined);
  const people = async () => (await f.store.events(from)).filter((event) => event.type === "context/people-prepared");
  assert.equal((await people()).length, 1, "the first send records the block");
  await f.sessions.send(from, input, { author: OLIA }).catch(() => undefined);
  assert.equal((await people()).length, 1, "a replay of the same operation records no second block");
});
