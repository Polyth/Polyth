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
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// node --test cannot load JSX — route .tsx through the esbuild transform hook.
register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
  activateProject, beginProjectListRequest, publishProjectList, setModels, setSessions,
} = await import("../src/store.ts");
const { default: SessionsPage } = await import("../src/components/settings/SessionsPage.tsx");

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
  setSessions([
    session({ id: "s1", projectId: "p-settings", title: "Fix the flaky test" }),
    session({ id: "s2", projectId: "p-settings", title: "Ship the release", status: "working", updatedAt: Date.now() - 5_000 }),
    session({ id: "s3", projectId: "p-other", title: "Other project session" }),
  ]);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(SessionsPage)); });
    const text = container.textContent ?? "";
    assert.match(text, /Technical behavior and defaults for new sessions/);
    assert.match(text, /Global default model/);
    assert.match(text, /Project default model/);
    assert.match(text, /Worktree behavior/);
    assert.match(text, /Default agent/);
    assert.match(text, /Sidebar grouping/);
    assert.match(text, /Open Schedule/);
    assert.doesNotMatch(text, /Fix the flaky test|Ship the release|Other project session/);

    await act(async () => {
      setSessions([
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

test("global defaults remain available when no project is active", async () => {
  publishProjects([]);
  activateProject(null);
  setSessions([]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(SessionsPage)); });
    assert.match(container.textContent ?? "", /Global default model/);
    assert.match(container.textContent ?? "", /No project selected/);
    assert.match(container.textContent ?? "", /Global defaults still apply/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
