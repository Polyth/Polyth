import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";

// The first Send on a new chat is one request: the create carries the first
// turn, the approval setting and package start steps. A reply with a queueId
// or turnId means the server owns the start (no client chain); an older
// server's bare {id} runs the old chain plus each start extension's `legacy`.
// The input stays usable while the chat starts. Mounts the real Composer.

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage as unknown as Storage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.matchMedia = () => ({
  matches: false, media: "", onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  dispatchEvent() { return false; },
});
globalThis.fetch = async () => new Response("{}", { status: 404 });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Composer } = await import("../src/components/Composer.tsx");
const { api } = await import("@polyth/session/web-api");
const { activateProject, applyProjectUpsert, endPendingSend, getState, setModels, startNewSession } = await import("../src/store.ts");
const { registerComposerSessionStartExtension } = await import("../src/composer/contributions.ts");
import type { ProjectDefaults, StartSessionResult } from "@polyth/contracts";

const settle = () => act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });

type Calls = { create: unknown[]; isolated: unknown[]; send: number; autoAccept: number; goal: number; legacy: unknown[]; inputAfter: string };

async function firstSend(name: string, options: {
  reply: StartSessionResult;
  defaults?: ProjectDefaults;
  /** Inspect the composer while the create request is still open. */
  whileCreating?: (input: HTMLTextAreaElement, send: HTMLButtonElement) => void | Promise<void>;
}): Promise<Calls> {
  const originals = {
    send: api.sendMessage, saveDraft: api.saveDraft, create: api.createSession, isolated: api.createIsolatedSession,
    events: api.getEvents, list: api.listSessions, autoAccept: api.autoAcceptSet, goal: api.goalAttach,
    worktrees: api.listWorktrees, branches: api.gitBranches,
  };
  const originalError = console.error;
  const projectId = `session-start-${name}`;
  const sessionId = options.reply.id;
  const calls: Calls = { create: [], isolated: [], send: 0, autoAccept: 0, goal: 0, legacy: [], inputAfter: "" };
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const answer = async () => { await released; return options.reply; };
  api.createSession = (async (input: unknown) => { calls.create.push(input); return answer(); }) as typeof api.createSession;
  api.createIsolatedSession = (async (input: unknown) => { calls.isolated.push(input); return answer(); }) as typeof api.createIsolatedSession;
  api.sendMessage = (async () => { calls.send += 1; return { turnId: "turn-1" }; }) as typeof api.sendMessage;
  api.autoAcceptSet = (async () => { calls.autoAccept += 1; return {}; }) as unknown as typeof api.autoAcceptSet;
  api.goalAttach = (async () => { calls.goal += 1; return {}; }) as unknown as typeof api.goalAttach;
  api.saveDraft = (async () => ({ draftUpdatedAt: 3 })) as typeof api.saveDraft;
  api.getEvents = (async () => []) as typeof api.getEvents;
  api.listSessions = (async () => [{ id: sessionId, projectId, title: "", status: "idle" as const, createdAt: 1, updatedAt: 1 }]) as typeof api.listSessions;
  api.listWorktrees = (async () => [{ path: "/repo", branch: "main", head: "0000000", isMain: true }]) as typeof api.listWorktrees;
  api.gitBranches = (async () => ({ current: "main", branches: [{ name: "main", current: true }] })) as typeof api.gitBranches;
  console.error = () => {};
  const unregister = registerComposerSessionStartExtension({
    id: "test.step",
    collect: ({ text }) => ({ echo: text }),
    legacy: async (context, payload) => { calls.legacy.push({ sessionId: context.sessionId, payload }); },
  });
  applyProjectUpsert({ id: projectId, path: `/projects/${projectId}`, name: projectId, createdAt: 0, ...(options.defaults ? { defaults: options.defaults } : {}) });
  activateProject(projectId);
  setModels([{ providerID: "test", modelID: "model", name: "Test model", connected: true }]);
  startNewSession(projectId, { draft: "" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(Composer)); });
    for (let round = 0; round < 8; round++) await settle();
    const input = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
    const button = host.querySelector<HTMLButtonElement>("button.send");
    assert.ok(input);
    assert.ok(button);
    await act(async () => {
      input.value = "hello";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button.click(); });
    await settle();
    const liveInput = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
    const liveSend = host.querySelector<HTMLButtonElement>("button.send");
    assert.ok(liveInput && liveSend);
    await options.whileCreating?.(liveInput, liveSend);
    release();
    for (let round = 0; round < 12; round++) await settle();
    calls.inputAfter = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]")?.value ?? "";
    return calls;
  } finally {
    unregister();
    await act(async () => { root.unmount(); });
    host.remove();
    for (const pending of getState().pendingSends) endPendingSend(pending.id);
    api.sendMessage = originals.send;
    api.saveDraft = originals.saveDraft;
    api.createSession = originals.create;
    api.createIsolatedSession = originals.isolated;
    api.getEvents = originals.events;
    api.listSessions = originals.list;
    api.autoAcceptSet = originals.autoAccept;
    api.goalAttach = originals.goal;
    api.listWorktrees = originals.worktrees;
    api.gitBranches = originals.branches;
    console.error = originalError;
  }
}

test("the first send is one create that carries the first turn and the start steps", async () => {
  const calls = await firstSend("main", {
    reply: { id: "started-main", queueId: "q-1" },
    whileCreating: (input, send) => {
      assert.equal(input.disabled, false, "the input stays usable while the chat starts");
      assert.equal(send.disabled, true, "the double-send latch holds until the new id is bound");
    },
  });
  assert.equal(calls.create.length, 1);
  assert.equal(calls.isolated.length, 0);
  const body = calls.create[0] as { start?: { firstTurn?: { text?: string }; extensions?: Record<string, unknown>; autoAccept?: unknown }; clientOperationId?: string };
  assert.equal(body.start?.firstTurn?.text, "hello");
  assert.deepEqual(body.start?.extensions, { "test.step": { echo: "hello" } });
  assert.equal(body.start?.autoAccept, undefined, "an inherited approval setting is not sent");
  assert.equal(typeof body.clientOperationId, "string", "the start stays a keyed create");
  // The server owns the rest of the start.
  assert.deepEqual({ send: calls.send, autoAccept: calls.autoAccept, goal: calls.goal, legacy: calls.legacy.length },
    { send: 0, autoAccept: 0, goal: 0, legacy: 0 });
});

test("words typed while the chat starts are in its composer once it opens", async () => {
  const calls = await firstSend("typed", {
    reply: { id: "started-typed", queueId: "q-1" },
    whileCreating: async (input) => {
      assert.equal(input.value, "", "the sent prompt left the input");
      await act(async () => {
        input.value = "next thought";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
  });
  assert.equal(getState().activeSessionId, "started-typed");
  // The stored draft is hidden while the first prompt is in flight; the words
  // must reach the chat's composer as live input all the same.
  assert.equal(calls.inputAfter, "next thought");
});

test("an admitted first turn (turnId) also owes nothing more", async () => {
  const calls = await firstSend("turn", { reply: { id: "started-turn", turnId: "t-1" } });
  assert.equal(calls.send, 0);
  assert.equal(calls.legacy.length, 0);
});

test("an older server that ignored start runs the old chain and each extension's legacy step", async () => {
  const calls = await firstSend("legacy", { reply: { id: "legacy-session" } });
  assert.equal(calls.create.length, 1);
  assert.equal(calls.send, 1, "the client delivers the first prompt itself");
  assert.deepEqual(calls.legacy, [{ sessionId: "legacy-session", payload: { echo: "hello" } }]);
});

test("an isolated new chat starts through the isolation route with the same start", async () => {
  const calls = await firstSend("isolated", {
    reply: { id: "started-isolated", queueId: "q-2" },
    defaults: { isolation: "workspace", isolateByDefault: true },
  });
  assert.equal(calls.create.length, 0);
  assert.equal(calls.isolated.length, 1);
  const body = calls.isolated[0] as { start?: { firstTurn?: { text?: string } } };
  assert.equal(body.start?.firstTurn?.text, "hello");
  assert.equal(calls.send, 0);
});

test("approval, goal and the worktree routes are part of the one start request", async () => {
  const composer = await readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  assert.match(composer, /newSessionAutoApprove !== "inherit" \? \{ autoAccept: newSessionAutoApprove \}/);
  assert.match(composer, /newSessionGoal \? \{ "goals\.attach": \{ objective: t \} \}/);
  assert.match(composer, /\.\.\.\(wire !== undefined \? \{ agentProfileId: wire \} : \{\}\),\n\s*\.\.\.\(newSessionAutoApprove/);
  assert.match(composer, /startWorktreeSession\(projectId, newSessionTarget\.kind === "branch"/);
  // The older-server fallback is marked for removal.
  assert.match(composer, /\/\/ ponytail: an older server ignored `start`/);
  // The input is never disabled by a starting chat.
  assert.doesNotMatch(composer, /disabled=\{creatingSession\}/);
});

test("a failed start gives its attachments back as pills only into an empty composer", async () => {
  const composer = await readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  assert.match(composer, /if \(pendingAttachments\(id\)\.length > 0\) return;\n\s*for \(const attachment of startFailure\.attachments\) addAttachment\(id, attachment\);/);
  assert.match(composer, /restoredStartFailures\.has\(key\)/);
});
