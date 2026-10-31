import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

// Spaces §13: a new chat that names no harness, model or agent is pinned to
// the person's own default harness by the server. The client must leave
// those out exactly when the person has a usable default and chose nothing
// for the chat; otherwise the existing route (explicit pick, project
// defaults, Auto) is sent unchanged.

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });

const creates: Array<{ path: string; body: Record<string, unknown> }> = [];
let defaultReads = 0;
let personDefault: { harnessId: string | null; usable: boolean } | "missing" = { harnessId: "claude-work", usable: true };
(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
  const u = new URL(String(url), "http://localhost:3000");
  const method = init?.method ?? "GET";
  let status = 200;
  let payload: unknown = {};
  if ((u.pathname === "/api/sessions" || u.pathname === "/api/isolation/sessions") && method === "POST") {
    creates.push({ path: u.pathname, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    payload = { id: `created-${creates.length}` };
  } else if (u.pathname === "/api/harnesses/default") {
    defaultReads += 1;
    if (personDefault === "missing") status = 404;
    else payload = personDefault;
  } else if (u.pathname === "/api/sessions") {
    payload = [];
  } else if (/^\/api\/sessions\/[^/]+$/.test(u.pathname)) {
    payload = { id: u.pathname.split("/").pop(), projectId: "p1", title: "", status: "idle", createdAt: 1, updatedAt: 1 };
  } else if (/^\/api\/sessions\/[^/]+\/events\/forward$/.test(u.pathname)) {
    const cursor = Number(u.searchParams.get("afterSeq") ?? 0);
    payload = { events: [], cursor, highWater: cursor, complete: true };
  } else if (/^\/api\/sessions\/[^/]+\/events$/.test(u.pathname)) {
    payload = [];
  }
  return {
    ok: status < 400,
    status,
    statusText: status < 400 ? "OK" : "Not Found",
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
};

const store = await import("../src/store.ts");
const { setSessionDefaults } = await import("../src/sessionDefaults.ts");
const { createSession } = await import("../src/init.ts");
const { newChatPersonDefault, newChatRouteChosen, readPersonHarnessDefault } = await import("../src/personHarnessDefault.ts");
const { emptyComposerConfig } = await import("../src/composerConfig.ts");
const { emptyDraftExecutionConfig } = await import("../src/executionDraft.ts");

store.applyProjectAdded({ id: "p1", path: "/p1", name: "P1", createdAt: 1, defaults: { agent: "plan" } });
store.applyProjectAdded({ id: "p2", path: "/p2", name: "P2", createdAt: 1, defaults: { agent: "plan", worktreeBehavior: "fresh-worktree" } });
setSessionDefaults({ defaultModel: { providerID: "anthropic", modelID: "opus" } });

const lastCreate = () => creates[creates.length - 1]!;
const routeOf = (body: Record<string, unknown>) => ({ harness: body.harness, model: body.model, agent: body.agent });

test("nothing chosen for a new chat follows the person default; any pick keeps its route", () => {
  const draft = emptyDraftExecutionConfig();
  const cfg = emptyComposerConfig();
  assert.equal(newChatRouteChosen(draft, cfg), false);
  assert.equal(newChatRouteChosen(draft, { ...cfg, profile: { kind: "none" } }), false, "no profile is not a route");
  const chosen: Array<[string, boolean]> = [
    ["Auto tab", newChatRouteChosen({ ...draft, harnessSelectionExplicit: true }, cfg)],
    ["harness tab", newChatRouteChosen({ harnessSelection: { mode: "pinned", harnessId: "codex" }, harnessSelectionExplicit: true }, cfg)],
    ["draft model", newChatRouteChosen({ ...draft, model: { harnessId: "codex", providerID: "openai", modelID: "gpt" } }, cfg)],
    ["draft profile", newChatRouteChosen({ ...draft, profileId: "reviewer" }, cfg)],
    ["draft agent", newChatRouteChosen({ ...draft, agent: { harnessId: "opencode", agent: "plan" } }, cfg)],
    ["draft thinking", newChatRouteChosen({ ...draft, thinking: "high" }, cfg)],
    ["model", newChatRouteChosen(draft, { ...cfg, model: { providerID: "openai", modelID: "gpt" } })],
    ["agent", newChatRouteChosen(draft, { ...cfg, agent: "plan" })],
    ["Auto thinking", newChatRouteChosen(draft, { ...cfg, thinking: null })],
    ["profile", newChatRouteChosen(draft, { ...cfg, profile: { kind: "id", id: "reviewer" } })],
    ["staged harness", newChatRouteChosen(draft, { ...cfg, harness: { mode: "auto" } })],
  ];
  for (const [label, value] of chosen) assert.equal(value, true, label);
  assert.equal(newChatPersonDefault("claude-work", false), "claude-work");
  assert.equal(newChatPersonDefault("claude-work", true), undefined);
  assert.equal(newChatPersonDefault(undefined, false), undefined);
});

test("without a person default, a new chat still sends the project and session defaults", async () => {
  await createSession("p1", { title: "plain" });
  const { path, body } = lastCreate();
  assert.equal(path, "/api/sessions");
  assert.deepEqual(routeOf(body), { harness: undefined, model: { providerID: "anthropic", modelID: "opus" }, agent: "plan" });
});

test("explicit picks are sent unchanged", async () => {
  await createSession("p1", { harness: { mode: "pinned", harnessId: "codex" }, model: { providerID: "openai", modelID: "gpt" }, agent: "build" });
  assert.deepEqual(lastCreate().body.harness, { mode: "pinned", harnessId: "codex" });
  await createSession("p1", { harness: { mode: "auto" } });
  assert.deepEqual(lastCreate().body.harness, { mode: "auto" }, "Auto stays an explicit choice");
});

test("a chat following the person default names no harness, model or agent", async () => {
  await createSession("p1", { title: "mine", personDefaultHarnessId: "claude-work" });
  const { path, body } = lastCreate();
  assert.equal(path, "/api/sessions");
  assert.deepEqual(routeOf(body), { harness: undefined, model: undefined, agent: undefined });
  assert.equal(body.title, "mine");
  assert.equal("personDefaultHarnessId" in body, false, "the client-only flag never reaches the server");
});

test("an isolated chat can't use the server-side default, so it names the harness only", async () => {
  await createSession("p2", { title: "isolated", personDefaultHarnessId: "claude-work" });
  const { path, body } = lastCreate();
  assert.equal(path, "/api/isolation/sessions");
  assert.deepEqual(routeOf(body), { harness: { mode: "pinned", harnessId: "claude-work" }, model: undefined, agent: undefined });
  await createSession("p2", { title: "isolated plain" });
  assert.deepEqual(routeOf(lastCreate().body), { harness: undefined, model: { providerID: "anthropic", modelID: "opus" }, agent: "plan" });
});

test("only a usable saved default counts, and a missing route means none", async () => {
  personDefault = { harnessId: "claude-work", usable: true };
  assert.equal(await readPersonHarnessDefault("a"), "claude-work");
  const reads = defaultReads;
  assert.equal(await readPersonHarnessDefault("a"), "claude-work");
  assert.equal(defaultReads, reads, "cached per account/Space/catalog revision");
  personDefault = { harnessId: "claude-work", usable: false };
  assert.equal(await readPersonHarnessDefault("b"), undefined);
  personDefault = { harnessId: null, usable: false };
  assert.equal(await readPersonHarnessDefault("c"), undefined);
  personDefault = "missing";
  assert.equal(await readPersonHarnessDefault("d"), undefined);
});
