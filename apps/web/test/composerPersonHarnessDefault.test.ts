import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

// The new-chat composer leaves harness, model and agent out of the create
// request only when the person has a usable default and chose nothing for
// this chat (Spaces §13); otherwise it sends its route exactly as before.

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

let personDefault: { harnessId: string | null; usable: boolean } | null = null;
// The caller's server roster; null answers 404 like the stubbed shell.
let roster: string[] | null = null;
const requested: string[] = [];
globalThis.fetch = async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://127.0.0.1:4400");
  requested.push(`${url.pathname}${url.search}`);
  if (url.pathname === "/api/harnesses/default" && personDefault) return new Response(JSON.stringify(personDefault));
  if (url.pathname === "/api/harnesses/roster" && roster) {
    return new Response(JSON.stringify(roster.map((id) => ({ identity: { id, name: id }, policy: { enabled: true, priority: 0, autoSelect: true } }))));
  }
  // The default harness's own catalog, so the picker can show it and Send is
  // not held back by a missing model list. Auto resolves to it as well.
  if (url.pathname === "/api/harnesses/snapshots"
    && (url.searchParams.get("harnessId") === "claude-work" || (roster && url.searchParams.get("auto") === "1"))) {
    return new Response(JSON.stringify([{
      identity: { id: "claude-work", name: "Claude · Work", integration: "native" },
      policy: { enabled: true, priority: 0, autoSelect: false },
      availability: { harnessId: "claude-work", state: "ready", installed: true, healthy: true, authenticated: true, checkedAt: 1 },
      context: { projectId: url.searchParams.get("projectId") ?? "", revision: "r", fetchedAt: 1 },
      catalog: { models: [{ providerID: "anthropic", modelID: "sonnet", name: "Sonnet", connected: true, harnessId: "claude-work" }] },
    }]));
  }
  return new Response("{}", { status: 404 });
};

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Composer } = await import("../src/components/Composer.tsx");
const { api } = await import("@polyth/session/web-api");
const { activateProject, endPendingSend, getState, setModels, startNewSession } = await import("../src/store.ts");
const { writeDraftExecutionConfig } = await import("../src/executionDraft.ts");
const { invalidateRuntimeCatalogs } = await import("@polyth/models/runtime-catalog");

type CreateInput = Parameters<typeof api.createSession>[0];

async function firstSend(name: string, setup: (projectId: string) => void = () => {}): Promise<CreateInput> {
  const originals = { send: api.sendMessage, saveDraft: api.saveDraft, create: api.createSession, events: api.getEvents, list: api.listSessions };
  const originalError = console.error;
  const projectId = `person-default-${name}`;
  const sessionId = `person-default-session-${name}`;
  let created: CreateInput | undefined;
  let sent!: () => void;
  const sentOnce = new Promise<void>((resolve) => { sent = resolve; });
  api.sendMessage = (async () => { sent(); return { turnId: "turn-1" }; }) as typeof api.sendMessage;
  api.saveDraft = (async () => ({ draftUpdatedAt: 3 })) as typeof api.saveDraft;
  api.createSession = (async (input: CreateInput) => { created = input; return { id: sessionId }; }) as typeof api.createSession;
  api.getEvents = (async () => []) as typeof api.getEvents;
  api.listSessions = (async () => [{ id: sessionId, projectId, title: "", status: "idle" as const, createdAt: 1, updatedAt: 1 }]) as typeof api.listSessions;
  // Background reads in this stubbed shell fail by design; keep them quiet.
  console.error = () => {};
  // The person default is cached per catalog revision; start each case fresh.
  invalidateRuntimeCatalogs();
  activateProject(projectId);
  setModels([{ providerID: "test", modelID: "model", name: "Test model", connected: true }]);
  setup(projectId);
  startNewSession(projectId, { draft: "" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(Composer)); });
    for (let round = 0; round < 8; round++) await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
    const input = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
    const button = host.querySelector<HTMLButtonElement>("button.send");
    assert.ok(input);
    assert.ok(button);
    await act(async () => {
      input.value = "hello";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button.click(); await sentOnce; });
    assert.ok(created, "the first send created a session");
    return created!;
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    for (const pending of getState().pendingSends) endPendingSend(pending.id);
    api.sendMessage = originals.send;
    api.saveDraft = originals.saveDraft;
    api.createSession = originals.create;
    api.getEvents = originals.events;
    api.listSessions = originals.list;
    console.error = originalError;
  }
}

test("with no person default the new chat sends its route as before", async () => {
  personDefault = null;
  const created = await firstSend("none");
  assert.equal(created.harness, undefined);
  assert.deepEqual(created.model && { providerID: created.model.providerID, modelID: created.model.modelID }, { providerID: "test", modelID: "model" });
});

test("a usable person default and nothing chosen: no harness, model or agent is sent", async () => {
  personDefault = { harnessId: "claude-work", usable: true };
  const created = await firstSend("applies");
  assert.deepEqual({ harness: created.harness, model: created.model, agent: created.agent }, { harness: undefined, model: undefined, agent: undefined });
});

test("an unusable saved default is ignored", async () => {
  personDefault = { harnessId: "claude-work", usable: false };
  const created = await firstSend("unusable");
  assert.equal(created.model?.modelID, "model");
});

test("an explicit Auto pick for this chat wins over the person default", async () => {
  personDefault = { harnessId: "claude-work", usable: true };
  const created = await firstSend("auto", (projectId) => writeDraftExecutionConfig(projectId, {
    harnessSelection: { mode: "auto" },
    harnessSelectionExplicit: true,
  }));
  assert.deepEqual(created.harness, { mode: "auto" });
});

test("a remembered pick the caller's roster hides is dropped once the roster is known", async () => {
  personDefault = null;
  roster = ["claude-work"];
  requested.length = 0;
  try {
    const created = await firstSend("hidden", (projectId) => writeDraftExecutionConfig(projectId, {
      harnessSelection: { mode: "pinned", harnessId: "codex" },
      harnessSelectionExplicit: true,
    }));
    // At most the one read made before the roster answered.
    const codexReads = requested.filter((path) => path.includes("harnessId=codex")).length;
    assert.ok(codexReads <= 1, requested.join("\n"));
    // Once it answered, the route follows the caller's own harnesses.
    const snapshotReads = requested.filter((path) => path.startsWith("/api/harnesses/snapshots"));
    assert.ok(snapshotReads.at(-1)?.includes("auto=1"), requested.join("\n"));
    // It runs where the composer showed it would, on a harness the caller may use.
    assert.deepEqual(created.harness, { mode: "pinned", harnessId: "claude-work" });
  } finally {
    roster = null;
  }
});
