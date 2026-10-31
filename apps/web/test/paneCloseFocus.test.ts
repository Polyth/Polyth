// Where focus goes when a package window closes (store.ts restorePaneFocus).
// On a touch device a text entry that takes focus raises the software
// keyboard, so a closing window must never hand focus to one: on the iOS app
// the composer took it whenever the window's invoker could not, and the
// keyboard flashed up until the leaving Workspace moved focus to Tools.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
let coarse = true;
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (media: string) => ({
    get matches() { return media.includes("pointer: coarse") ? coarse : false; },
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
const { registerSurface } = await import("../src/surfaces.ts");

const PROJECT = "pane-close-focus";
store.applyProjectUpsert({ id: PROJECT, path: "/work/pane-close-focus", name: "Focus", createdAt: 1 });
store.activateProject(PROJECT);
registerSurface({
  id: "focus-pane",
  title: "Pane",
  order: 1,
  component: () => null,
  presentation: { kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760, keepAlive: true, escape: "close" },
});

/** Past restorePaneFocus's tick and focusComposer's frame retries. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

function shell() {
  document.body.innerHTML = `
    <button id="opener">Open</button>
    <textarea id="composer" data-composer-input=""></textarea>
    <button id="tools" data-workspace-trigger="">Tools</button>`;
  const focused: string[] = [];
  document.addEventListener("focusin", (event) => focused.push((event.target as Element).id));
  // happy-dom has no layout: a rendered element reports one box.
  for (const id of ["opener", "composer", "tools"]) {
    (document.getElementById(id) as unknown as { getClientRects(): unknown[] }).getClientRects = () => [{}];
  }
  return focused;
}

/** Open the pane from `invoker` (focused first), optionally take the invoker
 *  away, close the pane, and report every element that took focus after. */
async function closeFrom(invoker: string, gone: boolean): Promise<{ focused: string[]; active: string }> {
  const focused = shell();
  document.getElementById(invoker)!.focus();
  store.openWorkspacePane("focus-pane");
  if (gone) document.getElementById(invoker)!.remove();
  focused.length = 0;
  store.closeWorkspacePane();
  await settle();
  return { focused: [...focused], active: (document.activeElement as Element | null)?.id ?? "" };
}

test("on a touch device a closing window never focuses a text entry", async () => {
  coarse = true;
  const lost = await closeFrom("opener", true);
  assert.ok(!lost.focused.includes("composer"), `the composer never takes focus (${lost.focused.join(", ")})`);
  assert.equal(lost.active, "tools", "focus goes to the phone's Tools control instead");

  const fromComposer = await closeFrom("composer", false);
  assert.ok(!fromComposer.focused.includes("composer"), "not even when the composer opened the window");
  assert.equal(fromComposer.active, "tools");

  const fromButton = await closeFrom("opener", false);
  assert.equal(fromButton.active, "opener", "an invoker that can take focus still gets it back");
});

test("with a mouse and keyboard the composer is still the fallback", async () => {
  coarse = false;
  const lost = await closeFrom("opener", true);
  assert.equal(lost.active, "composer", "focus returns to Chat's composer");
  const fromComposer = await closeFrom("composer", false);
  assert.equal(fromComposer.active, "composer", "…and to the composer that opened the window");
});

test("a phone Back leaves focus to the Workspace it returns to", async () => {
  const nav = await import("../src/mobileWorkspaceNavigation.ts");
  for (const touch of [true, false]) {
    coarse = touch;
    const focused = shell();
    document.getElementById("opener")!.focus();
    store.openWorkspacePane("focus-pane");
    document.getElementById("opener")!.remove();
    focused.length = 0;
    // ModuleView's Back: the Workspace is named first, then the window closes.
    nav.showMobileWorkspaceHome();
    store.closeWorkspacePane();
    await settle();
    assert.deepEqual(focused, [], `${touch ? "touch" : "mouse"}: no fallback races the revealed Workspace, which claims focus itself`);
    nav.hideMobileWorkspaceHome();

    // The Workspace tile that opened the window is still there: it gets focus back.
    const again = shell();
    document.getElementById("opener")!.focus();
    store.openWorkspacePane("focus-pane");
    // The window takes focus as it opens.
    (document.activeElement as HTMLElement | null)?.blur();
    again.length = 0;
    nav.showMobileWorkspaceHome();
    store.closeWorkspacePane();
    await settle();
    assert.deepEqual(again, ["opener"], `${touch ? "touch" : "mouse"}: the invoker is still restored`);
    nav.hideMobileWorkspaceHome();
  }
});
