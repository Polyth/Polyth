// Package-window seams a package reaches through `host.surfaces` and
// `host.ui`: whether a window exists (`surfaces.has`), what an explicit
// `openWorkspacePane(id, resource)` hands its content (`paneResource`), and
// the window Back a list-and-item window borrows (`useWindowBack`).
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (media: string) => ({
    matches: false,
    media,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }),
});
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  matchMedia: dom.matchMedia.bind(dom),
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });

const store = await import("../src/store.ts");
const { hasPackageWindow, registerSurface } = await import("../src/surfaces.ts");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { WindowBackContext, useWindowBack } = await import("../src/components/ui/windowBack.ts");

const PROJECT = "package-window-seams";
store.applyProjectUpsert({ id: PROJECT, path: "/work/package-window-seams", name: "Seams", createdAt: 1 });
store.activateProject(PROJECT);
const presentation = { kind: "workspace", defaultRatio: 0.5, minWidth: 340, preferredMaxWidth: 900, keepAlive: true, escape: "close" } as const;

test("surfaces.has answers for a registered window and forgets it on dispose", () => {
  assert.equal(hasPackageWindow("seam-catalog"), false);
  const off = registerSurface({ id: "seam-catalog", title: "Catalog", order: 1, component: () => null, presentation });
  try {
    assert.equal(hasPackageWindow("seam-catalog"), true);
  } finally {
    off();
  }
  assert.equal(hasPackageWindow("seam-catalog"), false, "a disabled package takes the way in with it");
});

test("an explicit resource reaches the window; the same one asked again is a new request", () => {
  const off = registerSurface({ id: "seam-dir", title: "Directory", order: 2, component: () => null, presentation });
  try {
    assert.equal(store.openWorkspacePane("seam-dir", "linear"), true);
    const first = store.getState().paneResource;
    assert.equal(first?.surfaceId, "seam-dir");
    assert.equal(first?.resource, "linear");

    store.openWorkspacePane("seam-dir", "linear");
    const again = store.getState().paneResource;
    assert.equal(again?.resource, "linear");
    assert.ok((again?.seq ?? 0) > (first?.seq ?? 0), "a repeat request still lands after the person navigated away inside");

    // Opening from the rail (no resource) starts at the window's home: the
    // remembered resource is not replayed.
    const before = store.getState().paneResource?.seq;
    store.openWorkspacePane("seam-dir");
    assert.equal(store.getState().paneResource?.seq, before);
  } finally {
    store.closeWorkspacePane({ restoreFocus: false });
    off();
  }
});

test("Files and Git keep their own channels instead of paneResource", () => {
  const before = store.getState().paneResource;
  const off = registerSurface({ id: "files", title: "Files", order: 3, component: () => null, presentation });
  try {
    store.openWorkspacePane("files", "file:src/a.ts");
    assert.equal(store.getState().editorFile, "src/a.ts");
    assert.equal(store.getState().paneResource, before);
  } finally {
    store.closeWorkspacePane({ restoreFocus: false });
    off();
  }
});

test("useWindowBack lends the step only to a window that draws its own Back", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const claims: Array<() => void> = [];
  const released: number[] = [];
  const seam = (drawsBack: boolean) => ({
    drawsBack,
    claim(handler: () => void) {
      claims.push(handler);
      const index = claims.length - 1;
      return () => { released.push(index); };
    },
  });
  let lent: boolean | null = null;
  let steps = 0;
  function Content({ inItem }: { inItem: boolean }) {
    lent = useWindowBack(inItem ? () => { steps += 1; } : null);
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host as unknown as Element);
  const phone = seam(true);

  await act(async () => { root.render(createElement(WindowBackContext.Provider, { value: phone }, createElement(Content, { inItem: true }))); });
  assert.equal(lent, true, "the phone window's Back now steps back inside");
  assert.equal(claims.length, 1);
  claims[0]!();
  assert.equal(steps, 1);

  await act(async () => { root.render(createElement(WindowBackContext.Provider, { value: phone }, createElement(Content, { inItem: false }))); });
  assert.equal(lent, false);
  assert.deepEqual(released, [0], "back on the list, the window's Back leaves the window again");

  await act(async () => { root.render(createElement(WindowBackContext.Provider, { value: seam(false) }, createElement(Content, { inItem: true }))); });
  assert.equal(lent, false, "a wide window draws no Back, so the content keeps its own");

  await act(async () => { root.render(createElement(Content, { inItem: true })); });
  assert.equal(lent, false, "outside a window nothing is lent");
  await act(async () => { root.unmount(); });
});
