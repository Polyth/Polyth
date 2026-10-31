// Settings → Sessions owns defaults and technical behavior, not session
// browsing. Mount the real page and keep the getSnapshot-loop regression guard.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project, SessionProjection } from "@polyth/contracts";

// happy-dom globals must exist before react-dom/client (and the store's
// localStorage-backed actions) initialize.
const dom = new Window();
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { fetch?: unknown }).fetch = async () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => ({ days: 30, cutoff: 1, eligibleCount: 2 }),
  text: async () => "",
});

// node --test cannot load JSX — route .tsx through the esbuild transform hook.
register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
  activateProject, beginProjectListRequest, getState, publishProjectList, setAgents, setModels, setSessions, updateSettings,
} = await import("../src/store.ts");
const { default: SessionsPage } = await import("../src/components/settings/SessionsPage.tsx");
const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
const { setRoleKind } = await import("../src/rolePrefs.ts");

const session = (over: Partial<SessionProjection>): SessionProjection => ({
  id: "s", projectId: "p", title: "session", status: "idle",
  createdAt: Date.now() - 60_000, updatedAt: Date.now() - 30_000,
  ...over,
});

const project = (over: Partial<Project> = {}): Project => ({
  id: "p-settings",
  path: "/repo/settings",
  name: "Settings project",
  createdAt: Date.now(),
  ...over,
});

function publishProjects(projects: Project[]): void {
  const ticket = beginProjectListRequest();
  assert.equal(publishProjectList(ticket, projects), "published");
}

test("settings Sessions page renders defaults and never lists sessions", async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

  publishProjects([project()]);
  activateProject("p-settings");
  setModels([{
    providerID: "openai",
    modelID: "gpt-test",
    providerName: "OpenAI",
    name: "GPT Test",
  }]);
  setAgents([
    { name: "build", mode: "primary" },
    { name: "review", mode: "subagent" },
    { name: "plan", mode: "primary" },
    { name: "compaction", mode: "all" },
  ]);
  setRoleKind("build", "subagent");
  setRoleKind("review", "main");
  setSessions("p-settings", [
    session({ id: "s1", projectId: "p-settings", title: "Fix the flaky test" }),
    session({ id: "s2", projectId: "p-settings", title: "Ship the release", status: "working", updatedAt: Date.now() - 5_000 }),
  ]);
  setSessions("p-other", [
    session({ id: "s3", projectId: "p-other", title: "Other project session" }),
  ]);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(SessionsPage)); });
    await act(async () => { await Promise.resolve(); });
    const text = container.textContent ?? "";
    // The settings shell owns the sole page title; page content starts with
    // the first meaningful section instead of repeating a subtitle.
    assert.doesNotMatch(text, /Set defaults and retention for sessions/);
    assert.match(text, /New sessions/);
    assert.match(text, /New sessions will start with/);
    assert.match(text, /Default model/);
    assert.match(text, /Default thinking/);
    assert.match(text, /Default agent/);
    assert.match(text, /Small model/);
    assert.match(text, /Walkthrough model/);
    assert.match(text, /Behavior/);
    assert.match(text, /Default sessions loaded/);
    assert.match(text, /How many sessions the navigator shows/);
    assert.equal(
      container.querySelector<HTMLInputElement>('input[aria-label="Default sessions loaded"]')?.value,
      "6",
    );
    assert.match(text, /Delete failed startup sessions/);
    assert.match(text, /Cleanup/);
    assert.match(text, /Expire sessions after/);
    assert.match(text, /When cleaning up/);
    assert.match(text, /Nothing is cleaned up automatically/);
    assert.match(text, /Clean up expired sessions/);
    assert.match(text, /Expired sessions right now: 2\./);
    assert.match(text, /Delete archives older than/);
    assert.match(text, /Delete all archives/);
    // Each cleanup action is named once; the old duplicate "Manual Cleanup"
    // rows and their copy-pasted hints are gone.
    assert.doesNotMatch(text, /Manual Cleanup/i);
    const headings = [...container.querySelectorAll(".settings-section-title")].map((node) => node.textContent);
    assert.deepEqual(headings, ["New sessions", "Behavior", "Cleanup", "Archive"]);
    assert.doesNotMatch(text, /__default__|When sessions expire/);
    assert.doesNotMatch(text, /Fix the flaky test|Ship the release|Other project session/);
    assert.equal(container.querySelectorAll(".model-picker").length, 3);
    assert.equal(container.querySelectorAll(".model-picker-trigger").length, 3);
    assert.equal(
      container.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Delete failed startup sessions"]')?.getAttribute("aria-checked"),
      "true",
    );
    const agentPicker = container.querySelector<HTMLButtonElement>('button[aria-label="Default agent"]');
    assert.ok(agentPicker);
    await act(async () => { agentPicker.click(); });
    const agentOptions = [...document.querySelectorAll<HTMLElement>('[role="option"] .palette-label')]
      .map((option) => option.textContent);
    assert.deepEqual(agentOptions, ["OpenCode agent default", "review", "plan"]);

    await act(async () => {
      setSessions("p-settings", [
        session({ id: "s4", projectId: "p-settings", title: "Still not settings content" }),
      ]);
    });
    assert.doesNotMatch(container.textContent ?? "", /Still not settings content/);

    assert.equal(
      errors.filter((e) => /getSnapshot|Maximum update depth/i.test(e)).length,
      0,
      `render loop reported: ${errors.join("\n")}`,
    );
  } finally {
    console.error = originalError;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("large navigator defaults require an explicit performance confirmation", async () => {
  updateSettings({ defaultVisibleSessionCount: 6 });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(SessionsPage)); });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Default sessions loaded"]');
    assert.ok(input);
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")?.set;
      assert.ok(setValue);
      setValue.call(input, "21");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.match(document.body.textContent ?? "", /Load more sessions\?/);
    assert.equal(getState().settings.defaultVisibleSessionCount, 6);

    const apply = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Apply");
    assert.ok(apply);
    await act(async () => { apply.click(); });
    assert.equal(getState().settings.defaultVisibleSessionCount, 21);
  } finally {
    updateSettings({ defaultVisibleSessionCount: 6 });
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("session defaults remain available when no project is active", async () => {
  publishProjects([]);
  activateProject(null);
  setSessions("p-settings", []);
  setSessions("p-other", []);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(SessionsPage)); });
    assert.match(container.textContent ?? "", /Default model/);
    assert.match(container.textContent ?? "", /Default thinking/);
    assert.match(container.textContent ?? "", /Expire sessions after/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("model picker renders a contributed catalog header inside its overlay", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(ModelPicker, {
        models: [{ providerID: "openai", modelID: "gpt-test", name: "GPT Test" }],
        onPick: () => {},
        header: createElement("div", { "data-test-harness-tabs": true }, "OpenCode  Codex"),
      }));
    });
    assert.equal(document.body.querySelector("[data-test-harness-tabs]"), null, "the contribution stays lazy while the picker is closed");
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    assert.equal(
      document.body.querySelector("[data-test-harness-tabs]")?.textContent,
      "OpenCode  Codex",
    );
    assert.ok(document.body.querySelector(".model-picker-header"), "the contribution precedes the model catalog");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("model picker returns the harness identity for colliding provider/model ids", async () => {
  let picked: { harnessId?: string; providerID: string; modelID: string } | undefined;
  const models = [
    { harnessId: "acp-a", providerID: "shared", modelID: "same", name: "From A" },
    { harnessId: "acp-b", providerID: "shared", modelID: "same", name: "From B" },
  ];
  const picker = (harnessId: string) => createElement(ModelPicker, {
    harnessId,
    models,
    value: { harnessId: "acp-a", providerID: "shared", modelID: "same" },
    onPick: (model) => { picked = model; },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(picker("acp-a")); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    const rowsA = [...document.body.querySelectorAll<HTMLElement>('.model-picker-row[role="option"]')];
    assert.equal(rowsA.length, 1, "the picker displays the currently selected harness catalog");
    assert.equal(rowsA[0]?.textContent?.includes("From A"), true);

    // The parent owns harness selection and passes its scope through
    // ModelPicker.harnessId. Simulate that selection change here; equal
    // provider/model ids remain distinct in the returned routing identity.
    await act(async () => { root.render(picker("acp-b")); });
    const rowsB = [...document.body.querySelectorAll<HTMLElement>('.model-picker-row[role="option"]')];
    assert.equal(rowsB.length, 1);
    assert.equal(rowsB[0]?.textContent?.includes("From B"), true);
    await act(async () => { rowsB[0]!.click(); });
    assert.deepEqual(picked, { harnessId: "acp-b", providerID: "shared", modelID: "same" });
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("default visible session count input does not commit on composing Enter", async () => {
  updateSettings({ defaultVisibleSessionCount: 6 });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(SessionsPage)); });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Default sessions loaded"]');
    assert.equal(input !== null, true, "input is mounted");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "10");
      input!.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.equal(getState().settings.defaultVisibleSessionCount, 6);

    // 1. Enter with isComposing: true does not commit
    await act(async () => {
      input!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }));
    });
    assert.equal(getState().settings.defaultVisibleSessionCount, 6, "composing Enter must not commit count");

    // 2. Enter with keyCode: 229 does not commit
    await act(async () => {
      input!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, keyCode: 229 }));
    });
    assert.equal(getState().settings.defaultVisibleSessionCount, 6, "keyCode 229 Enter must not commit count");

    // 3. Normal Enter commits
    await act(async () => {
      input!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    assert.equal(getState().settings.defaultVisibleSessionCount, 10, "normal Enter commits count");
  } finally {
    updateSettings({ defaultVisibleSessionCount: 6 });
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("sessions page model picker mounts slot header with harness routing context", async () => {
  const { registerSlot } = await import("../src/slots.ts");
  let capturedContext: Record<string, unknown> | undefined;
  const unregister = registerSlot("modelPicker.header", "test-sessions-header", (context) => {
    capturedContext = context;
    return createElement("div", { "data-test-sessions-header": true }, "Test Harness Header");
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(SessionsPage)); });
    const trigger = container.querySelector<HTMLButtonElement>(".model-picker-trigger");
    assert.ok(trigger);
    await act(async () => { trigger.click(); });
    const headerEl = document.body.querySelector("[data-test-sessions-header]");
    assert.ok(headerEl, "opening the picker renders the modelPicker.header contribution");
    assert.ok(capturedContext, "the slot contribution receives context");
    assert.equal(typeof capturedContext.onSelectHarness, "function", "context includes onSelectHarness");
  } finally {
    unregister();
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

