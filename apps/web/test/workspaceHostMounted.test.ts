// EXTENSION-SEAMS slice 2, mounted through a real React root: the workspace
// surface host must react to late registration/disposal without editing the
// host, fall back deterministically when the active surface disappears or its
// plugin is disabled, render the standard project/session empty states when a
// requirement is absent, and isolate a throwing surface behind its boundary —
// recovering on same-id replacement.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

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

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerWorkspaceSurface } = await import("../src/workspace/surfaceRegistry.ts");
const { default: WorkspaceHost } = await import("../src/components/workspace/WorkspaceHost.ts");
const { activateProject, activateSession, setActiveView } = await import("../src/store.ts");
const { setPlugins } = await import("../src/prefs.ts");

type Cleanup = () => void;

async function mountHost() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(WorkspaceHost)); });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

function probe(id: string, text: string, over: Record<string, unknown> = {}) {
  return registerWorkspaceSurface({
    id,
    title: text,
    order: 0,
    component: () => createElement("div", { className: `probe-${id}` }, text),
    ...over,
  });
}

test("mounted host: late registration renders, disposal falls back deterministically", async () => {
  setActiveView("files");
  activateProject(null);
  const { container, unmount } = await mountHost();
  const offs: Cleanup[] = [];
  try {
    // Nothing registered yet → honest empty workspace, no crash.
    assert.match(container.textContent ?? "", /Nothing to show here yet/);

    // Registration after the initial React mount must trigger a render.
    offs.push(probe("session", "session surface"));
    await act(async () => {});
    assert.match(container.textContent ?? "", /session surface/);

    // The active view's surface arrives late and takes over.
    let offFiles = probe("files", "files surface", { order: 10 });
    await act(async () => {});
    assert.match(container.textContent ?? "", /files surface/);

    // Disposal selects the deterministic fallback (session) without touching
    // the store's active view.
    await act(async () => { offFiles(); });
    assert.match(container.textContent ?? "", /session surface/);

    // Re-registration restores the still-active view — nothing was deleted.
    offFiles = probe("files", "files surface", { order: 10 });
    offs.push(offFiles);
    await act(async () => {});
    assert.match(container.textContent ?? "", /files surface/);
  } finally {
    for (const off of offs) off();
    await unmount();
  }
});

test("mounted host: project and session requirements render standard empty states", async () => {
  setActiveView("goals");
  activateProject(null);
  const offs: Cleanup[] = [];
  const { container, unmount } = await mountHost();
  try {
    offs.push(probe("goals", "goals surface", { requires: "session" }));
    await act(async () => {});
    // No project → the standard project empty state (not the surface).
    assert.match(container.textContent ?? "", /Bring your work into focus/);
    assert.ok(container.querySelector(".hero-open-project"));

    // Project but no session → the standard session empty state.
    await act(async () => { activateProject("p1"); });
    assert.match(container.textContent ?? "", /No session selected/);
    assert.match(container.textContent ?? "", /Open or start a session to use goals surface\./);

    // Session present → the surface renders with canonical ids available.
    await act(async () => { activateSession("s1"); });
    assert.match(container.textContent ?? "", /goals surface/);
  } finally {
    for (const off of offs) off();
    await act(async () => { activateSession(null); activateProject(null); });
    await unmount();
  }
});

test("mounted host: a disabled plugin gates its surface to the fallback", async () => {
  setActiveView("github");
  activateProject("p1");
  const offs: Cleanup[] = [];
  const { container, unmount } = await mountHost();
  try {
    offs.push(probe("session", "session surface"));
    offs.push(probe("github", "github surface", { order: 25, plugin: "github" }));
    await act(async () => { setPlugins([]); });
    assert.match(container.textContent ?? "", /session surface/);

    // Enabling the plugin makes the requested surface available reactively.
    await act(async () => { setPlugins(["github"]); });
    assert.match(container.textContent ?? "", /github surface/);
  } finally {
    for (const off of offs) off();
    await act(async () => { setPlugins([]); activateProject(null); });
    await unmount();
  }
});

test("mounted host: a throwing surface fails inside its boundary and recovers on replacement", async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

  setActiveView("session");
  activateProject("p1");
  const offs: Cleanup[] = [];
  const { container, unmount } = await mountHost();
  try {
    offs.push(registerWorkspaceSurface({
      id: "session",
      title: "Broken",
      order: 0,
      component: () => { throw new Error("broken surface"); },
    }));
    await act(async () => {});
    // The standard error state renders inside the host — the shell survives.
    assert.match(container.textContent ?? "", /This view couldn’t render/);
    assert.ok(errors.some((e) => e.includes("broken surface")));
    // Inline variant: no nested <main> page wrapper inside the workspace.
    assert.equal(container.querySelector("main"), null);

    // Same-id replacement (a fixed contribution) must visibly recover
    // without remounting the host.
    offs.push(probe("session", "recovered surface"));
    await act(async () => {});
    assert.match(container.textContent ?? "", /recovered surface/);
  } finally {
    console.error = originalError;
    for (const off of offs) off();
    await act(async () => { activateProject(null); });
    await unmount();
  }
});
