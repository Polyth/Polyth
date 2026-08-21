// Finding 1 (UX-SHELL-CONSOLIDATION-02): Settings → Sessions white screen.
// SessionsPage returned a FRESH filtered array from its useStore selector, so
// every useSyncExternalStore getSnapshot differed and React looped until it
// threw (#185 "Maximum update depth exceeded"), white-screening the overlay.
// This mounts the REAL page through a React root and asserts it renders and
// keeps rendering across store updates without throwing or loop warnings.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionProjection } from "@polyth/contracts";

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
const { activateProject, setSessions } = await import("../src/store.ts");
const { default: SessionsPage } = await import("../src/components/settings/SessionsPage.tsx");

const session = (over: Partial<SessionProjection>): SessionProjection => ({
  id: "s", projectId: "p", title: "session", status: "idle",
  createdAt: Date.now() - 60_000, updatedAt: Date.now() - 30_000,
  ...over,
});

test("settings Sessions page mounts and renders the project's sessions without throwing", async () => {
  // React reports an uncached getSnapshot loop through console.error before
  // throwing — capture it so the regression is provable, not just crash-free.
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

  activateProject("p-settings");
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
    assert.match(text, /Sessions in project/);
    assert.match(text, /Fix the flaky test/);
    assert.match(text, /Ship the release/);
    // Only the active project's sessions belong on the page.
    assert.doesNotMatch(text, /Other project session/);

    // A later store update (e.g. a WS projection) re-renders once — no loop.
    await act(async () => {
      setSessions([
        session({ id: "s1", projectId: "p-settings", title: "Fix the flaky test", status: "finished" }),
      ]);
    });
    assert.match(container.textContent ?? "", /Fix the flaky test/);
    assert.doesNotMatch(container.textContent ?? "", /Ship the release/);

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

test("settings Sessions page renders the empty state when no project is active", async () => {
  activateProject(null);
  setSessions([]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(SessionsPage)); });
    assert.match(container.textContent ?? "", /No active project/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
