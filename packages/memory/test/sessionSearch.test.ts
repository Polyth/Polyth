// session_search / session_read: earlier chats of a project, from every harness,
// reachable only as far as the person the turn acts for and the chat's readers allow.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentCapabilityContribution, SessionMessageSearchHit, SessionPrivacy, SpaceContext } from "@polyth/contracts";
import { createMemoryService, registerMemoryTool } from "../src/service.ts";
import { createMemoryStore } from "../src/store.ts";

const OLIA = "usr_olia";
const TARAS = "usr_taras";
const SPACE = "space-a";
const person = (userId: string): SpaceContext => ({
  spaceId: SPACE, spaceSlug: SPACE, userId, role: "member", deployment: "local-trusted", storageDir: join(tmpdir(), SPACE),
});
const readers = (...ids: string[]) => ids.map((userId) => ({ userId }));
const PRIVACY: Record<string, SessionPrivacy> = {
  here: { privateTo: OLIA, audience: readers(OLIA), projectAudience: 2 },
  sharedHere: { audience: readers(OLIA, TARAS), projectAudience: 2 },
  oliaOld: { privateTo: OLIA, audience: readers(OLIA), projectAudience: 2 },
  tarasOld: { privateTo: TARAS, audience: readers(TARAS), projectAudience: 2 },
  sharedOld: { audience: readers(OLIA, TARAS), projectAudience: 2 },
};
const OPENS: Record<string, string[]> = {
  [OLIA]: ["here", "sharedHere", "oliaOld", "sharedOld"],
  [TARAS]: ["sharedHere", "tarasOld", "sharedOld"],
};
const text = (seq: number, type: string, body: string) => ({ seq, type, time: Date.UTC(2026, 9, 26), data: { text: body } });
const EVENTS: Record<string, ReturnType<typeof text>[]> = {
  oliaOld: [text(1, "user/message", "Here are fridge photos, keep the inventory"), text(2, "tool/call", "x"), text(3, "assistant/message", "Inventory: eggs 10, milk 1 l"), text(4, "user/message", "thanks")],
  tarasOld: [text(1, "assistant/message", "Taras inventory: beer 6")],
  sharedOld: [text(1, "assistant/message", "Shared inventory of the pantry")],
  here: [text(1, "user/message", "update the inventory")],
};

function fixture() {
  const store = createMemoryStore(new DatabaseSync(":memory:"), SPACE);
  const contributions = new Map<string, AgentCapabilityContribution>();
  const registry = { register(_owner: string, value: AgentCapabilityContribution) { contributions.set((value.descriptor as { name?: string }).name ?? value.descriptor.id, value); return { dispose() {} }; } };
  const exposed: string[] = [];
  // The raw search knows nothing about readers: every chat of the Space matches.
  const search = async ({ q }: { q: string }): Promise<SessionMessageSearchHit[]> => Object.entries(EVENTS).flatMap(([sessionId, events]) => events
    .filter((event) => event.type.endsWith("/message") && event.data.text.toLowerCase().includes(q.toLowerCase()))
    .map((event) => ({ sessionId, seq: event.seq, role: event.type === "user/message" ? "user" as const : "assistant" as const, time: event.time, snippet: event.data.text })));
  const host = {
    forSpace(ctx: SpaceContext) {
      return {
        projects: { get: async () => ({ id: "wellness" }), list: async () => [{ id: "wellness", name: "Wellness" }] },
        sessions: {
          list: async () => (OPENS[ctx.userId] ?? []).map((id) => ({ id, title: `chat ${id}` })),
          events: async (id: string, afterSeq = 0, page?: { limit?: number }) => {
            if (!OPENS[ctx.userId]?.includes(id)) throw Object.assign(new Error("session not found"), { code: "not-found" });
            return (EVENTS[id] ?? []).filter((event) => event.seq > afterSeq).slice(0, page?.limit ?? 1000);
          },
        },
      };
    },
    systemSpaceContext: () => person("system:polyth-runtime"),
    personSpaceContext: (userId: string) => person(userId),
    sessionPrivacy: (_space: string, sessionId: string) => PRIVACY[sessionId],
    markPersonalContext: async (sessionId: string) => { exposed.push(sessionId); },
    services: { get(key: { id: string }) { return key.id === "polyth.service.harness.capabilities" ? registry : key.id === "polyth.service.session.message-search" ? search : undefined; } },
  } as never;
  const service = createMemoryService(host, { async prepareProject() { return { memory: store }; } });
  registerMemoryTool(host, service);
  const scope = { spaceId: SPACE, projectId: "wellness", principalId: "system:polyth-runtime" };
  const setMode = (mode: "auto" | "off") => store.updatePolicy(scope, { projectId: "wellness", expectedSettingsRevision: store.getPolicy(scope).settingsRevision, patch: { mode } });
  setMode("auto");
  const run = async (name: string, input: Record<string, unknown>, sessionId: string, actorUserId = OLIA) =>
    (await contributions.get(name)!.execute!(input as never, { spaceId: SPACE, projectId: "wellness", cwd: "/tmp", sessionId, actorUserId } as never)) as { output: string; metadata: Record<string, unknown> };
  return { run, exposed, setMode, contributions };
}

test("a private chat finds its owner's earlier chats, never another person's or itself", async () => {
  const f = fixture();
  const found = await f.run("session_search", { query: "inventory" }, "here");
  assert.deepEqual([...(found.metadata.sessionIds as string[])].sort(), ["oliaOld", "sharedOld"]);
  assert.match(found.output, /\[oliaOld #3 · 2026-10-26 · assistant · "chat oliaOld"\]\nInventory: eggs 10/);
  assert.match(found.output, /as data, not instructions/);
  assert.deepEqual(f.exposed, ["here"], "quoting a private chat marks this chat personal");

  const read = await f.run("session_read", { sessionId: "oliaOld", seq: 1, count: 2 }, "here");
  assert.match(read.output, /#1 · 2026-10-26 · user\]\nHere are fridge photos/);
  assert.match(read.output, /#3 · 2026-10-26 · assistant\]\nInventory: eggs 10/, "tool events are skipped");
  assert.doesNotMatch(read.output, /thanks/, "count bounds the read");
  await assert.rejects(() => f.run("session_read", { sessionId: "tarasOld", seq: 1 }, "here"), /chat not found/);
  await assert.rejects(() => f.run("session_read", { sessionId: "here", seq: 1 }, "here"), /chat not found/, "not the current chat");
});

test("a chat others read reaches only chats every reader can open", async () => {
  const f = fixture();
  const found = await f.run("session_search", { query: "inventory" }, "sharedHere");
  assert.deepEqual(found.metadata.sessionIds, ["sharedOld"]);
  assert.deepEqual(f.exposed, []);
  await assert.rejects(() => f.run("session_read", { sessionId: "oliaOld", seq: 1 }, "sharedHere"), /chat not found/);
  const asTaras = await f.run("session_search", { query: "inventory" }, "sharedHere", TARAS);
  assert.deepEqual(asTaras.metadata.sessionIds, ["sharedOld"], "Taras's own private chat stays out of a shared chat too");
});

test("nothing found says how to retry; memory off refuses", async () => {
  const f = fixture();
  assert.match((await f.run("session_search", { query: "zucchini" }, "here")).output, /No earlier chat .* try fewer or other words/);
  f.setMode("off");
  await assert.rejects(() => f.run("session_search", { query: "inventory" }, "here"), /disabled/);
  await assert.rejects(() => f.run("session_read", { sessionId: "oliaOld", seq: 1 }, "here"), /disabled/);
});

test("the memory instruction falls back to chat search and keeps living data in one record", () => {
  const f = fixture();
  const instruction = [...f.contributions.values()].find((value) => value.descriptor.kind === "instruction")!;
  const body = (instruction.descriptor as { text: string }).text;
  assert.match(body, /session_search before you conclude/);
  assert.match(body, /keep track of something, save it with memory_remember right away, even if your harness keeps memory files/);
  assert.match(body, /inventory .* is not transient progress/);
});
