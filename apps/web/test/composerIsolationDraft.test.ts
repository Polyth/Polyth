// Typing into a new chat and then flipping "Isolate" (or picking repositories)
// republishes `newSessionIntent` with new metadata. Keystrokes never travel
// through that intent — `saveNewSessionDraftText` persists them to the scoped
// draft record without republishing — so its `draft` is only the seed the chat
// was installed with. A metadata choice must neither write that stale seed over
// the typed text nor make the mounted Composer re-seed its input from it.
//
// Mounts the real Composer, like composerDraftRemovalOrdering.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

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
(globalThis as typeof globalThis & { matchMedia: typeof globalThis.matchMedia }).matchMedia = () => ({
  matches: false,
  media: "",
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return false; },
});
globalThis.fetch = async () => new Response("{}", { status: 404 });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Composer } = await import("../src/components/Composer.tsx");
const { api } = await import("@polyth/session/web-api");
const {
  activateProject,
  applyProjectUpsert,
  getState,
  hydrateNewSessionDraft,
  setModels,
  setNewSessionRepositories,
  startNewSession,
} = await import("../src/store.ts");
const { loadScopedDraftRecord } = await import("../src/draftRecord.ts");
import type { ProjectDefaults } from "@polyth/contracts";

const settle = () => act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });

const typeInto = (input: HTMLTextAreaElement, value: string) => act(async () => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

/** Counts programmatic writes to the textarea's value. A user edit is the DOM's
 * own business; a write from the Composer means it re-seeded the input. */
function watchValueWrites(input: HTMLTextAreaElement): { count: number } {
  // React may already shadow `value` on the node; wrap whatever is in effect.
  let owner: object | null = input;
  let descriptor: PropertyDescriptor | undefined;
  while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, "value"))) {
    owner = Object.getPrototypeOf(owner);
  }
  assert.ok(descriptor?.get && descriptor.set, "the textarea value is an accessor the probe can wrap");
  const { get, set } = descriptor;
  const probe = { count: 0 };
  Object.defineProperty(input, "value", {
    configurable: true,
    get: () => get.call(input),
    set: (next: string) => { probe.count += 1; set.call(input, next); },
  });
  return probe;
}

async function mountNewChat(
  projectId: string,
  options: { installIntent?: boolean; git?: boolean; defaults?: ProjectDefaults } = {},
) {
  const originalWorktrees = api.listWorktrees;
  const originalBranches = api.gitBranches;
  // A known checkout makes the Isolate switch usable (it needs a current branch).
  const git = options.git !== false;
  api.listWorktrees = (async () => git ? [
    { path: "/repo", branch: "main", head: "0000000", isMain: true },
  ] : []) as typeof api.listWorktrees;
  api.gitBranches = (async () => git ? {
    current: "main",
    branches: [{ name: "main", current: true }],
  } : { current: "", branches: [] }) as typeof api.gitBranches;

  // Isolation is opt-in per project; these chats live in one that enabled it.
  applyProjectUpsert({
    id: projectId,
    path: `/projects/${projectId}`,
    name: projectId,
    createdAt: 0,
    defaults: options.defaults ?? { isolation: "workspace" },
  });
  activateProject(projectId);
  setModels([{ providerID: "test", modelID: "model", name: "Test model", connected: true }]);
  // Activating a project drops any intent, which is exactly the "none" state.
  if (options.installIntent !== false) startNewSession(projectId, { draft: "" });
  else assert.equal(getState().newSessionIntent, null);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(Composer)); });
  await settle();
  await settle();

  const input = () => {
    const found = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
    assert.ok(found, "the new-chat composer renders its input");
    return found;
  };
  const isolationSwitch = () => host.querySelector<HTMLButtonElement>("[role=\"switch\"]");
  const isolate = () => {
    const found = host.querySelector<HTMLButtonElement>("[role=\"switch\"]");
    assert.ok(found, "the new-chat composer renders the Isolate switch");
    return found;
  };
  return {
    input,
    isolate,
    isolationSwitch,
    async dispose() {
      await act(async () => { root.unmount(); });
      host.remove();
      api.listWorktrees = originalWorktrees;
      api.gitBranches = originalBranches;
    },
  };
}

test("flipping Isolate after typing keeps the text in the input and in the draft record", async () => {
  const projectId = "isolate-draft-project";
  const chat = await mountNewChat(projectId);
  try {
    assert.equal(chat.isolate().disabled, false, "the switch is usable once the checkout is known");
    await typeInto(chat.input(), "typed before the toggle");
    assert.equal(loadScopedDraftRecord(null).text, "typed before the toggle");

    const writes = watchValueWrites(chat.input());
    await act(async () => { chat.isolate().click(); });

    assert.equal(getState().newSessionIntent?.isolate, true, "the choice itself still takes effect");
    assert.equal(chat.isolate().getAttribute("aria-checked"), "true");
    assert.equal(chat.input().value, "typed before the toggle", "the text stays in the input");
    assert.equal(writes.count, 0, "the input is not re-seeded by a checkout choice");
    assert.equal(
      loadScopedDraftRecord(null).text,
      "typed before the toggle",
      "the stale seed is not persisted over the typed text",
    );

    // Typing carries on from where it was, and flipping back is just as safe.
    await typeInto(chat.input(), "typed before the toggle, and after");
    await act(async () => { chat.isolate().click(); });
    assert.equal(getState().newSessionIntent?.isolate, false);
    assert.equal(chat.input().value, "typed before the toggle, and after");
    assert.equal(loadScopedDraftRecord(null).text, "typed before the toggle, and after");

    // Leaving and re-entering the chat restores both the text and the choice.
    await act(async () => { chat.isolate().click(); });
    startNewSession(projectId);
    await settle();
    assert.equal(getState().newSessionIntent?.isolate, true);
    assert.equal(getState().newSessionIntent?.draft, "typed before the toggle, and after");
    assert.equal((await hydrateNewSessionDraft(projectId))?.draft, "typed before the toggle, and after");
  } finally {
    await chat.dispose();
  }
});

test("picking repositories after typing keeps the new-chat text", async () => {
  const projectId = "repository-draft-project";
  const chat = await mountNewChat(projectId);
  try {
    await typeInto(chat.input(), "typed before the repository choice");
    const writes = watchValueWrites(chat.input());

    await act(async () => { setNewSessionRepositories(projectId, ["repo-a"]); });

    assert.deepEqual(getState().newSessionIntent?.repositoryIds, ["repo-a"]);
    assert.equal(chat.input().value, "typed before the repository choice");
    assert.equal(writes.count, 0, "the input is not re-seeded by a repository choice");
    assert.equal(loadScopedDraftRecord(null).text, "typed before the repository choice");
  } finally {
    await chat.dispose();
  }
});

test("a choice made before any intent was installed still keeps the typed text", async () => {
  const projectId = "no-intent-draft-project";
  const chat = await mountNewChat(projectId, { installIntent: false });
  try {
    // Text can be typed while the store holds no intent for the project.
    await typeInto(chat.input(), "typed with no intent");
    assert.equal(getState().newSessionIntent, null);
    assert.equal(loadScopedDraftRecord(null).text, "typed with no intent");
    const writes = watchValueWrites(chat.input());

    await act(async () => { chat.isolate().click(); });

    assert.equal(getState().newSessionIntent?.isolate, true);
    assert.equal(chat.input().value, "typed with no intent");
    assert.equal(writes.count, 0, "the input is not re-seeded when the first intent is a checkout choice");
    assert.equal(loadScopedDraftRecord(null).text, "typed with no intent");
  } finally {
    await chat.dispose();
  }
});

test("starting a new chat with its own draft still re-seeds the mounted input", async () => {
  const projectId = "reseed-draft-project";
  const chat = await mountNewChat(projectId);
  try {
    await typeInto(chat.input(), "typed here first");
    await act(async () => { startNewSession(projectId, { draft: "seeded by navigation", title: "Prepared" }); });
    assert.equal(chat.input().value, "seeded by navigation", "a newly installed chat owns the input");
    assert.equal(loadScopedDraftRecord(null).text, "seeded by navigation");

    // The choice made afterwards leaves that seeded text alone, too.
    await act(async () => { chat.isolate().click(); });
    assert.equal(chat.input().value, "seeded by navigation");
    assert.equal(loadScopedDraftRecord(null).text, "seeded by navigation");
  } finally {
    await chat.dispose();
  }
});

test("the project isolate default preselects Isolate until the chat chooses otherwise", async () => {
  const projectId = "isolate-default-project";
  const chat = await mountNewChat(projectId, { defaults: { isolation: "workspace", isolateByDefault: true } });
  try {
    assert.equal(chat.isolate().getAttribute("aria-checked"), "true", "a fresh chat starts isolated");
    assert.equal(getState().newSessionIntent?.isolate, undefined, "the default is not written into the chat");

    await act(async () => { chat.isolate().click(); });
    assert.equal(getState().newSessionIntent?.isolate, false, "turning it off is this chat's own choice");
    assert.equal(chat.isolate().getAttribute("aria-checked"), "false");

    startNewSession(projectId);
    await settle();
    assert.equal(chat.isolate().getAttribute("aria-checked"), "false", "the chat's choice outranks the default");
  } finally {
    await chat.dispose();
  }
});

test("isolation does not exist for a project that has not enabled it", async () => {
  const chat = await mountNewChat("isolation-off-project", { defaults: {} });
  try {
    assert.equal(chat.isolationSwitch(), null, "no Isolate switch by default");
  } finally {
    await chat.dispose();
  }
});

test("an enabled isolation level still shows nothing for a project without Git", async () => {
  const chat = await mountNewChat("isolate-default-no-git", {
    git: false,
    defaults: { isolation: "workspace", isolateByDefault: true },
  });
  try {
    assert.equal(chat.isolationSwitch(), null);
  } finally {
    await chat.dispose();
  }
});
