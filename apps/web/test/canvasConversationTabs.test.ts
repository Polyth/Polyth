// The canvas has no session sidebar, so the conversation widget carries its
// own session switcher: the project's most recent sessions as tabs, five at a
// time, with the rest available on demand. Switching activates the canonical
// session without dropping the user out of Canvas back into Chat.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionProjection } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
  Element: (dom as unknown as { Element: typeof Element }).Element,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Nothing here may reach a server. Every attempted request is recorded and
// refused, so a canonical session open is observable without a live backend.
const requested: string[] = [];
globalThis.fetch = ((input: unknown) => {
  requested.push(
    typeof input === "string" ? input
    : input instanceof URL ? input.href
    : String((input as { url?: unknown }).url ?? input),
  );
  return Promise.reject(new Error("offline"));
}) as typeof fetch;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { activateSession, upsertSessions } = await import("../src/store.ts");
const { getWorkspaceMode, setWorkspaceMode, setWorkspaceModeProject } = await import(
  "../src/widgets/workspaceMode.ts"
);
const { ChatSessionTabs, CHAT_SESSION_TAB_PAGE } = await import("../src/widgets/builtinWidgets.tsx");

const PROJECT = "p-canvas";

const session = (index: number, overrides: Partial<SessionProjection> = {}): SessionProjection => ({
  id: `s${index}`,
  projectId: PROJECT,
  title: `Session ${index}`,
  status: "idle",
  createdAt: 1_000 - index,
  updatedAt: 1_000 - index,
  lastTurnAt: 1_000 - index,
  ...overrides,
} as SessionProjection);

async function mountTabs(projectId: string | null) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(ChatSessionTabs, { projectId })); });
  return {
    host,
    tabs: () => [...host.querySelectorAll<HTMLElement>('[role="tab"]')],
    more: () => host.querySelector<HTMLElement>(".widget-chat-tabs-more"),
    unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

test("the conversation widget offers the last five sessions and loads the rest on demand", async () => {
  assert.equal(CHAT_SESSION_TAB_PAGE, 5);
  upsertSessions([
    ...Array.from({ length: 7 }, (_unused, index) => session(index + 1)),
    // Archived work is read-only history, not a switching target.
    session(8, { status: "archived", title: "Archived" }),
    // Another project's sessions never leak into this strip.
    session(9, { projectId: "p-other", title: "Other project" }),
  ]);
  activateSession("s1");
  const view = await mountTabs(PROJECT);
  try {
    assert.deepEqual(
      view.tabs().map((tab) => tab.textContent),
      ["Session 1", "Session 2", "Session 3", "Session 4", "Session 5"],
      "the five most recent sessions of this project, newest first",
    );
    assert.equal(view.tabs()[0]?.getAttribute("aria-selected"), "true");
    assert.equal(view.tabs()[1]?.getAttribute("aria-selected"), "false");

    const more = view.more();
    assert.ok(more, "the remaining sessions are available behind one control");
    await act(async () => { more!.click(); });
    assert.deepEqual(
      view.tabs().map((tab) => tab.textContent),
      ["Session 1", "Session 2", "Session 3", "Session 4", "Session 5", "Session 6", "Session 7"],
      "loading more extends the same strip",
    );
    assert.equal(view.more(), null, "the control disappears once everything is listed");
  } finally { await view.unmount(); }
});

test("an open session older than the first page stays selectable", async () => {
  activateSession("s7");
  const view = await mountTabs(PROJECT);
  try {
    const labels = view.tabs().map((tab) => tab.textContent);
    assert.equal(labels.length, CHAT_SESSION_TAB_PAGE + 1);
    assert.equal(labels.at(-1), "Session 7");
    assert.equal(view.tabs().at(-1)?.getAttribute("aria-selected"), "true");
  } finally { await view.unmount(); }
});

test("switching a tab activates the session without leaving Canvas", async () => {
  setWorkspaceModeProject(PROJECT);
  setWorkspaceMode("widgets");
  activateSession("s1");
  const view = await mountTabs(PROJECT);
  try {
    requested.length = 0;
    await act(async () => { view.tabs()[2]!.click(); });
    assert.ok(
      requested.some((url) => url.includes("s3")),
      `the picked session is opened canonically, not rendered from a guess: ${requested.join(", ")}`,
    );
    assert.equal(getWorkspaceMode(), "widgets", "Canvas is not swapped for Chat by a tab switch");
  } finally {
    await view.unmount();
    setWorkspaceMode("chat");
  }
});

test("a project with no sessions renders no switcher at all", async () => {
  const view = await mountTabs("p-empty");
  try {
    assert.equal(view.host.querySelector(".widget-chat-tabs"), null);
  } finally { await view.unmount(); }
});
