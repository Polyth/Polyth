// The phone actions island's ⋮ opens the open chat's menu: a head naming the
// chat (a tap opens its overview), the Navigator row's actions and package
// contributions. Island buttons answer a press and an open menu with the glyph
// colour alone.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionProjection } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  Event: dom.Event,
  getComputedStyle: (elt: Element, pseudo?: string | null) =>
    (dom as unknown as { getComputedStyle(el: Element, pseudo?: string | null): CSSStyleDeclaration })
      .getComputedStyle(elt, pseudo),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
Object.defineProperty(globalThis, "HTMLElement", {
  value: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
  configurable: true,
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  value: (callback: FrameRequestCallback) => { callback(0); return 0; },
  configurable: true,
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { value: () => {}, configurable: true });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { fetch?: unknown }).fetch = async () =>
  ({ ok: true, status: 200, statusText: "OK", json: async () => [], text: async () => "[]" });

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: MobileSessionMenu } = await import("../src/components/mobile/MobileSessionMenu.tsx");
const { registerSlot } = await import("../src/slots.ts");
const { tr } = await import("../src/i18n/index.ts");

const now = Date.now();
const session: SessionProjection = {
  id: "s-1", projectId: "p", title: "Island chat", status: "idle",
  createdAt: now, updatedAt: now, lastTurnAt: now,
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const menu = () => document.querySelector('[role="menu"]');
const labels = () => [...(menu()?.querySelectorAll('[role="menuitem"]') ?? [])].map((item) => item.textContent ?? "");

async function mount(target: SessionProjection, onOpenOverview?: () => void) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(MobileSessionMenu, {
      session: target, title: target.title, status: { kind: "regular", glyph: "", label: "" } as never,
      meta: "Idle · Opus", pinnedSessions: [], onChanged: () => {},
      ...(onOpenOverview ? { onOpenOverview } : {}),
    }));
    await sleep(0);
  });
  const trigger = container.querySelector<HTMLButtonElement>(".mobile-session-menu-trigger");
  assert.ok(trigger, "the ⋮ trigger renders");
  return {
    trigger: trigger!,
    async toggle() { await act(async () => { trigger!.click(); await sleep(0); }); },
    async close() { await act(async () => root.unmount()); container.remove(); },
  };
}

test("⋮ opens the session menu with its head, actions and package contributions", async () => {
  const off = registerSlot(
    "sidebar.session.actions",
    "test.island-action",
    ({ sessionId }) => createElement("button", { role: "menuitem", type: "button" }, `pkg:${String(sessionId)}`),
    1,
  );
  let overview = 0;
  const view = await mount(session, () => { overview++; });
  try {
    assert.equal(view.trigger.getAttribute("aria-label"), tr("mobile.sessionmenu.sessionActions"));
    assert.equal(view.trigger.getAttribute("aria-expanded"), "false");
    await view.toggle();
    assert.equal(view.trigger.getAttribute("aria-expanded"), "true", "the open menu marks its trigger");
    const items = labels();
    for (const label of [
      tr("common.rename"), tr("sidebar.sessionlist.pinToTop"), tr("sidebar.sessionlist.fork"),
      tr("sidebar.sessionlist.copySessionId"), tr("common.archive"), tr("common.delete"), "pkg:s-1",
    ]) assert.ok(items.includes(label), `menu lists ${label}`);
    assert.ok(items[0]?.startsWith("Island chat"), "the head names the chat first");

    const head = menu()!.querySelector<HTMLButtonElement>(".mobile-session-menu-head")!;
    assert.match(head.textContent ?? "", /Idle · Opus/);
    await act(async () => { head.click(); await sleep(0); });
    assert.equal(overview, 1, "the head opens the overview");
    assert.equal(menu(), null, "and closes the menu");
    assert.equal(view.trigger.getAttribute("aria-expanded"), "false");
  } finally {
    await view.close();
    off();
  }
});

test("a conversation's head only names it, and an isolated chat offers no fork", async () => {
  const view = await mount({
    ...session,
    purpose: "conversation",
    isolation: { kind: "git-worktree", state: "active" } as never,
  });
  try {
    await view.toggle();
    const head = menu()!.querySelector(".mobile-session-menu-head")!;
    assert.equal(head.tagName, "DIV", "no overview to open");
    assert.equal(head.getAttribute("role"), null);
    const items = labels();
    assert.ok(!items.includes(tr("sidebar.sessionlist.fork")));
    assert.ok(items.includes(tr("sidebar.sessionlist.muteConversation")));
  } finally {
    await view.close();
  }
});

test("island buttons press and stay open as a colour change, with no plate or settle", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const looks = await readFile(new URL("../src/shellLooks.css", import.meta.url), "utf8");
  const header = await readFile(new URL("../src/components/mobile/MobileSessionHeader.tsx", import.meta.url), "utf8");
  const state = css.match(/:is\(\.mobile-float-navigation, \.mobile-float-actions\) > \.ui-icon-btn:is\(:active, \[aria-expanded="true"\]\):not\(:disabled\),[^{]*\{([^}]*)\}/);
  assert.ok(state, "one press/open rule covers every island button");
  assert.match(state![1]!, /color: var\(--accent-text\)/);
  assert.match(state![1]!, /transform: none/);
  assert.doesNotMatch(state![1]!, /background|box-shadow|filter/, "no plate or glow");
  // Looks that recolour island glyphs do so at rest only.
  for (const look of ["paper", "editorial"]) {
    assert.match(looks, new RegExp(`data-shell-look="${look}"\\]:not\\(#\\\\#\\) :is\\(\\.mobile-float-navigation, \\.mobile-float-actions\\) \\.ui-icon-btn:not\\(:active, \\[aria-expanded="true"\\]\\)`));
  }
  // ⋮ sits between New session and Open tools.
  const compose = header.indexOf('label={tr("mobile.island.newSession")}');
  const more = header.indexOf("<MobileSessionMenu");
  const tools = header.indexOf('label={tr("mobile.island.openTools")}');
  assert.ok(compose > 0 && compose < more && more < tools);
});
