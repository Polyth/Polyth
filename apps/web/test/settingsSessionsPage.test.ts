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
  activateProject, beginProjectListRequest, publishProjectList, setAgents, setModels, setSessions,
} = await import("../src/store.ts");
const { default: SessionsPage } = await import("../src/components/settings/SessionsPage.tsx");
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
    assert.match(text, /Set defaults and retention for sessions/);
    assert.match(text, /Session Defaults/);
    assert.match(text, /New sessions will start with/);
    assert.match(text, /Default Model/);
    assert.match(text, /Default Thinking/);
    assert.match(text, /Default Agent/);
    assert.match(text, /Small Model/);
    assert.match(text, /Changes Walkthrough Model/);
    assert.match(text, /Session Retention/);
    assert.match(text, /Retention Period/);
    assert.match(text, /Expired sessions are archived only when you run manual cleanup/);
    assert.match(text, /Manual Cleanup/);
    assert.match(text, /Eligible for archiving right now: 2/);
    assert.doesNotMatch(text, /__default__|When sessions expire/);
    assert.doesNotMatch(text, /Fix the flaky test|Ship the release|Other project session/);
    assert.equal(
      container.querySelector<HTMLSelectElement>('select[aria-label="Small Model"]')?.options[0]?.text,
      "Not selected",
    );
    const agentOptions = [...container.querySelectorAll<HTMLOptionElement>('select[aria-label="Default Agent"] option')]
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
    assert.match(container.textContent ?? "", /Default Model/);
    assert.match(container.textContent ?? "", /Default Thinking/);
    assert.match(container.textContent ?? "", /Retention Period/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
