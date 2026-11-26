// Command palette chat rows: the row gives its width to the chat (full title
// plus project · branch or the matching excerpt); archive / pin / rename live
// in one ⋯ actions menu that Tab or the inward arrow opens from the field.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { register } from "node:module";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  localStorage: dom.localStorage,
  location: dom.location,
  getComputedStyle: (element: Element) => dom.getComputedStyle(
    element as unknown as Parameters<Window["getComputedStyle"]>[0],
  ),
  requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
  cancelAnimationFrame: () => {},
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@polyth/session/web-api");
const store = await import("../src/store.ts");
const { default: CommandPalette, chatPaletteEntry } = await import("../src/components/CommandPalette.tsx");

const LONG_TITLE = "Fix the card payment failure in the mobile app after the iOS 18.2 update";

async function tick(ms = 0) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); }
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
}

test("chatPaletteEntry falls back to the chat's known branch for its second line", () => {
  const result = {
    sessionId: "s1", projectId: "p1", title: "Payments", status: "idle" as const, updatedAt: 1, messageHits: 0,
    matches: [{ field: "title" as const, snippet: "Payments" }],
  };
  assert.equal(chatPaletteEntry(result, "Shop", "feat/pay").item.subtitle, "Shop · feat/pay");
  assert.equal(chatPaletteEntry(result, "Shop").item.subtitle, "Shop");
  const branchHit = { ...result, matches: [{ field: "branch" as const, snippet: "fix/pay" }] };
  assert.equal(chatPaletteEntry(branchHit, "Shop", "feat/pay").item.subtitle, "Shop · fix/pay", "the matched branch wins");
});

test("chat rows show the whole chat and keep their verbs in one keyboard-reachable ⋯ menu", async () => {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [{ id: "p1", name: "Shop", path: "/shop", createdAt: 1 }]);
  store.setSessions("p1", [
    { id: "s-pay", projectId: "p1", title: LONG_TITLE, status: "idle", branch: "fix/ios-card", createdAt: 1, updatedAt: 2 },
    { id: "s-hook", projectId: "p1", title: "Webhooks", status: "idle", createdAt: 1, updatedAt: 1, pinned: { position: 0 } },
  ]);
  store.activateProject("p1");
  store.openPalette("all");
  const originals = { searchSessions: api.searchSessions, searchWorkspaces: api.searchWorkspaces, filesSearchScored: api.filesSearchScored };
  api.searchWorkspaces = async () => [];
  api.filesSearchScored = async () => [];
  api.searchSessions = (async () => [
    { sessionId: "s-pay", projectId: "p1", title: LONG_TITLE, status: "idle", updatedAt: 2, messageHits: 0,
      matches: [{ field: "title", snippet: LONG_TITLE }] },
    { sessionId: "s-hook", projectId: "p1", title: "Webhooks", status: "idle", updatedAt: 1, messageHits: 1,
      matches: [{ field: "message", snippet: "a retried payment must not charge twice", ranges: [[10, 17]] }] },
  ]) as typeof api.searchSessions;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(CommandPalette)); });
    const input = document.querySelector<HTMLInputElement>(".palette-input")!;
    await act(async () => { type(input, "payment"); });
    await tick(250);

    const chatRows = [...document.querySelectorAll<HTMLElement>(".palette-session")];
    assert.equal(chatRows.length, 2);
    assert.equal(chatRows[0]!.querySelector(".palette-label")!.textContent, LONG_TITLE, "the full title is rendered");
    assert.equal(chatRows[0]!.querySelector(".palette-sub")!.textContent, "Shop · fix/ios-card", "project · known branch");
    assert.equal(chatRows[1]!.querySelector(".palette-excerpt mark")?.textContent, "payment", "message hit shows its excerpt");
    for (const row of chatRows) {
      assert.equal(row.querySelector(".palette-meta") === null, true, "no 'open chat' meta crowds the row");
      const buttons = [...row.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
      assert.equal(buttons.some((label) => /^(Archive|Pin to top|Unpin|Rename)$/.test(label)), false, "no text verb buttons in the row");
      const more = row.querySelectorAll(".palette-session-more");
      assert.equal(more.length, 1, "one ⋯ trigger per chat row");
      assert.equal(more[0]!.getAttribute("aria-haspopup"), "menu");
      assert.equal(more[0]!.getAttribute("aria-expanded"), "false");
    }

    const key = (target: EventTarget, init: Record<string, unknown>) => act(async () => {
      target.dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }) as unknown as Event);
    });
    // Select the first chat row, then open its actions from the field.
    const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    while (!options().find((o) => o.getAttribute("aria-selected") === "true")?.classList.contains("palette-session")) {
      await key(input, { key: "ArrowDown" });
    }
    assert.ok(document.querySelector(".palette-footer")!.textContent!.includes("Tab"), "footer announces the actions key");
    // The inward arrow only opens the menu once it cannot move the caret.
    input.setSelectionRange(0, 0);
    await key(input, { key: "ArrowRight" });
    assert.equal(document.querySelector(".ui-menu") === null, true, "ArrowRight mid-text still moves the caret");
    await key(input, { key: "Tab" });
    const menu = document.querySelector<HTMLElement>(".ui-menu");
    assert.equal(menu?.getAttribute("role"), "menu");
    assert.deepEqual([...menu!.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()), ["Pin to top", "Rename", "Archive"]);
    assert.equal(document.querySelector(".palette-session.active .palette-session-more")!.getAttribute("aria-expanded"), "true");
    await key(menu!.querySelector('[role="menuitem"]')!, { key: "Escape" });
    assert.equal(document.querySelector(".ui-menu") === null, true, "Escape closes the actions menu");
    assert.equal(store.getState().overlay, "palette", "…without closing the palette");

    // The pinned chat offers Unpin; the caret at the end lets → open it too.
    await key(input, { key: "ArrowDown" });
    input.setSelectionRange(input.value.length, input.value.length);
    await key(input, { key: "ArrowRight" });
    assert.deepEqual([...document.querySelectorAll('.ui-menu [role="menuitem"]')].map((item) => item.textContent?.trim()), ["Unpin", "Rename", "Archive"]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    Object.assign(api, originals);
    store.setOverlay(null);
  }
});
