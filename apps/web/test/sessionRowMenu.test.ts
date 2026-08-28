// Session row actions (P2-W1), mounted through a real React root: every row
// owns one ui/Menu reachable through right-click, long-press, Shift+F10, and
// a single ellipsis trigger (hover-revealed on fine pointers, persistent on
// touch). The menu carries delete/archive/pin/labels with correct ARIA menu
// roles and the keyboard contract (focus lands in the menu, arrows cycle,
// Escape closes back to the opener). Every permanent deletion confirms, with
// additional activity context for a running session. Quick archive/delete
// buttons exist only while a touch swipe is in progress — there is no
// Shift-hover layer and no duplicated always-on icon set.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionProjection } from "@polyth/contracts";

const dom = new Window();
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "isSecureContext", { value: true, configurable: true });
// Menus restore focus through requestAnimationFrame; run it synchronously.
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });

// Deterministic shell mode: responsiveShell caches these MediaQueryLists on
// first use, so the mutable `matches` flags steer wide vs compact per test.
const media = { compact: false, phone: false };
const mediaQueryList = (key: "compact" | "phone") => ({
  get matches() { return media[key]; },
  media: key,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => true,
});
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) =>
    mediaQueryList(query.includes("820") ? "compact" : "phone"),
});
let copiedText = "";
Object.defineProperty(dom.navigator, "clipboard", {
  value: { writeText: async (text: string) => { copiedText = text; } },
  configurable: true,
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Deterministic API seam: record calls, answer [] / {} like an empty server.
const fetchCalls: Array<{ url: string; method: string }> = [];
(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: { method?: string }) => {
  fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => [],
    text: async () => "[]",
  };
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
  activateProject, applyProjectUpsert, setSessions, setSidebarOpen,
} = await import("../src/store.ts");
const { default: SessionList } = await import("../src/components/sidebar/SessionList.tsx");
const { default: Sidebar } = await import("../src/components/Sidebar.tsx");
const { default: AlertDialog } = await import("../src/components/AlertDialog.tsx");

const session = (over: Partial<SessionProjection>): SessionProjection => ({
  id: "s", projectId: "p1", title: "session", status: "idle",
  createdAt: Date.now() - 60_000, updatedAt: Date.now() - 30_000,
  ...over,
});

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const KeyboardEventCtor = (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;

/** The row menu renders through a ui/Menu portal on document.body. */
const openMenu = () => document.querySelector<HTMLElement>('[role="menu"]');
const menuItems = () =>
  [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')];

async function mountList() {
  activateProject("p1");
  setSessions("p1", [
    session({ id: "s-idle", title: "Idle session" }),
    session({ id: "s-run", title: "Running session", status: "working", lastTurnAt: Date.now() - 10_000 }),
  ]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement("div", null,
      createElement(SessionList, { projectId: "p1" }),
      createElement(AlertDialog),
    ));
  });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

function rowOf(container: HTMLElement, title: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>(".session-row")]
    .find((el) => (el.textContent ?? "").includes(title));
  assert.ok(row, `row for "${title}" rendered`);
  return row!;
}

test("right-click opens the row-scoped menu with delete/archive/pin and menu ARIA", async () => {
  const { container, unmount } = await mountList();
  try {
    const row = rowOf(container, "Idle session");
    await act(async () => {
      row.dispatchEvent(new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true }));
    });
    const menu = openMenu();
    assert.ok(menu, "context menu opened");
    assert.ok(row.classList.contains("menu-open"), "open row keeps its trigger revealed");
    // Scoped to the exact row that was right-clicked.
    assert.equal(menu!.getAttribute("aria-label"), "Actions for Idle session");
    const items = menuItems().map((b) => b.textContent?.trim());
    for (const expected of ["Rename", "Fork", "Copy session ID", "Pin to top", "Archive", "Delete"]) {
      assert.ok(items.some((t) => t?.startsWith(expected)), `menu offers ${expected} (got: ${items.join(", ")})`);
    }

    // Keyboard contract: focus is in the menu, arrows cycle, Escape closes.
    assert.equal(document.activeElement?.textContent?.trim(), "Rename");
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEventCtor("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    assert.equal(document.activeElement?.textContent?.trim(), "Fork");
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    assert.equal(openMenu(), null, "Escape closes the menu");
    // A context-menu open returns focus to the row itself, not the ellipsis.
    assert.equal(document.activeElement?.getAttribute("aria-label"), "Open Idle session");
  } finally {
    await unmount();
  }
});

test("the session ellipsis trigger opens the same menu and receives returned focus", async () => {
  const { container, unmount } = await mountList();
  try {
    const row = rowOf(container, "Idle session");
    const trigger = row.querySelector<HTMLButtonElement>(".session-menu-trigger");
    assert.ok(trigger, "session actions have a single discoverable trigger");
    assert.equal(trigger!.getAttribute("aria-haspopup"), "menu");
    assert.equal(
      row.querySelectorAll("button[aria-haspopup]").length,
      1,
      "exactly one menu trigger per row — no duplicated tab stop",
    );
    await act(async () => { trigger!.click(); });
    assert.ok(openMenu(), "the trigger opens the row menu");
    assert.equal(trigger!.getAttribute("aria-expanded"), "true");

    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEventCtor("keydown", {
        key: "Escape", bubbles: true, cancelable: true,
      }));
    });
    assert.equal(openMenu(), null);
    assert.equal(document.activeElement, trigger, "focus returns to the ellipsis opener");
  } finally {
    await unmount();
  }
});

test("Escape closes a session menu inside the real mobile Sidebar, not the drawer", async () => {
  media.compact = true;
  applyProjectUpsert({ id: "p1", name: "Project one", path: "/workspace", createdAt: Date.now() });
  activateProject("p1");
  setSessions("p1", [session({ id: "s-mobile", title: "Mobile session" })]);
  setSidebarOpen(true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Sidebar)); });
    const drawer = container.querySelector<HTMLElement>("#polyth-session-drawer");
    const trigger = container.querySelector<HTMLButtonElement>(
      '.session-menu-trigger[aria-label="Actions for Mobile session"]',
    );
    assert.ok(drawer?.classList.contains("open"), "real compact Sidebar drawer is open");
    assert.ok(trigger, "session trigger is rendered in the Sidebar");

    await act(async () => { trigger!.click(); });
    assert.ok(document.querySelector('[role="menu"][aria-label="Actions for Mobile session"]'));
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEventCtor("keydown", {
        key: "Escape", bubbles: true, cancelable: true,
      }));
    });

    assert.equal(
      document.querySelector('[role="menu"][aria-label="Actions for Mobile session"]'),
      null,
      "Escape closes only the nested menu",
    );
    assert.ok(drawer!.classList.contains("open"), "Sidebar drawer remains open");
    assert.equal(document.activeElement, trigger, "focus returns to the session trigger");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    setSidebarOpen(false);
    media.compact = false;
  }
});

test("right-click Copy session ID writes the exact row id to the clipboard", async () => {
  const { container, unmount } = await mountList();
  try {
    copiedText = "";
    const row = rowOf(container, "Idle session");
    await act(async () => {
      row.dispatchEvent(new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true }));
    });
    const copy = menuItems().find((button) => button.textContent?.trim() === "Copy session ID");
    assert.ok(copy, "copy action is available in the row context menu");
    await act(async () => {
      copy!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(copiedText, "s-idle");
    assert.equal(openMenu(), null, "successful copy closes the menu");
  } finally {
    await unmount();
  }
});

test("pinned chats are first across worktrees and their menu offers Unpin", async () => {
  activateProject("p1");
  setSessions("p1", [
    session({ id: "other", title: "Other worktree", branch: "feature/other", worktreePath: "/repo-other" }),
    session({ id: "pinned", title: "Pinned worktree", branch: "feature/pinned", worktreePath: "/repo-pinned", pinned: { position: 0 } }),
  ]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(SessionList, { projectId: "p1" })); });
    const org = container.querySelector<HTMLElement>(".session-org");
    const pinned = container.querySelector<HTMLElement>(".session-pinned");
    assert.ok(org && pinned, "pinned section is rendered");
    assert.equal(org!.firstElementChild, pinned, "pinned chats lead the worktree groups");
    assert.match(pinned!.textContent ?? "", /feature\/pinned/, "pinned chat retains its worktree label");
    assert.ok(pinned!.querySelector(".session-pin-icon"), "pinned chat shows a pin icon");
    assert.equal(
      container.querySelectorAll('.session-worktree-sessions .session-row').length,
      1,
      "the pinned chat is not repeated inside its worktree",
    );

    const pinnedRow = rowOf(container, "Pinned worktree");
    await act(async () => {
      pinnedRow.dispatchEvent(new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true }));
    });
    const items = menuItems().map((item) => item.textContent?.trim());
    assert.ok(items.includes("Unpin"), `pinned row offers Unpin (got: ${items.join(", ")})`);
    assert.ok(!items.includes("Pin to top"), "pinned row does not offer Pin to top");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("every permanent delete confirms; running sessions include activity context", async () => {
  const { container, unmount } = await mountList();
  try {
    // Idle: a declined confirmation sends nothing.
    const idleRow = rowOf(container, "Idle session");
    await act(async () => {
      idleRow.dispatchEvent(new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true }));
    });
    fetchCalls.length = 0;
    const idleDelete = menuItems().find((b) => b.textContent?.trim() === "Delete");
    assert.ok(idleDelete, "row menu offers Delete");
    await act(async () => { idleDelete!.click(); });
    const idleDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Delete session"]');
    assert.ok(idleDialog, "idle delete opens the themed confirmation first");
    assert.match(idleDialog.textContent ?? "", /permanently removes the session and its history/i);
    await act(async () => {
      idleDialog.querySelector<HTMLButtonElement>(".ui-btn--quiet")!.click();
    });
    assert.equal(fetchCalls.filter((c) => c.method === "DELETE").length, 0, "declined idle delete changes nothing");

    // Accepting the same idle confirmation issues the delete.
    await act(async () => {
      idleRow.dispatchEvent(new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true }));
    });
    const idleDelete2 = menuItems().find((b) => b.textContent?.trim() === "Delete");
    await act(async () => { idleDelete2!.click(); });
    const idleDialog2 = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Delete session"]');
    assert.ok(idleDialog2);
    await act(async () => {
      idleDialog2.querySelector<HTMLButtonElement>(".alert-confirm")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(
      fetchCalls.some((c) => c.method === "DELETE" && c.url === "/api/sessions/s-idle"),
      `confirmed DELETE issued (got: ${JSON.stringify(fetchCalls)})`,
    );

    // The post-delete refresh answered [] through the fetch stub — re-seed the
    // store so the running row is still on screen for the second half.
    await act(async () => {
      setSessions("p1", [
        session({ id: "s-run", title: "Running session", status: "working", lastTurnAt: Date.now() - 10_000 }),
      ]);
    });

    // Running: confirmation additionally warns about active work.
    const runRow = rowOf(container, "Running session");
    await act(async () => {
      runRow.dispatchEvent(new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true }));
    });
    fetchCalls.length = 0;
    const runDelete = menuItems().find((b) => b.textContent?.trim() === "Delete");
    await act(async () => { runDelete!.click(); });
    const runDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Delete session"]');
    assert.ok(runDialog, "running delete opens the themed confirmation first");
    assert.match(runDialog.textContent ?? "", /still running|permanently/i);
    await act(async () => {
      runDialog.querySelector<HTMLButtonElement>(".ui-btn--quiet")!.click();
    });
    assert.equal(fetchCalls.filter((c) => c.method === "DELETE").length, 0, "declined confirm deletes nothing");

    // Accepted confirm goes through.
    await act(async () => {
      runRow.dispatchEvent(new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true }));
    });
    const runDelete2 = menuItems().find((b) => b.textContent?.trim() === "Delete");
    await act(async () => { runDelete2!.click(); });
    const runDialog2 = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Delete session"]');
    assert.ok(runDialog2);
    await act(async () => {
      runDialog2.querySelector<HTMLButtonElement>(".alert-confirm")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(fetchCalls.some((c) => c.method === "DELETE" && c.url === "/api/sessions/s-run"));
  } finally {
    await unmount();
  }
});

test("quick actions are swipe-only; keyboard reaches the same menu via Shift+F10", async () => {
  const { container, unmount } = await mountList();
  try {
    const row = rowOf(container, "Idle session");
    // No Shift-hover layer and no resting quick buttons: at rest the row has
    // exactly two interactive elements — open button and menu trigger.
    assert.equal(row.querySelector(".session-quick"), null, "quick actions absent at rest");
    assert.equal(row.getAttribute("data-swipe"), "closed");
    assert.equal(row.querySelectorAll("button").length, 2, "row = open button + menu trigger");

    // Shift+F10 on the row button opens the row menu (keyboard alternative to
    // right-click/long-press) and Escape returns focus to the row.
    const open = row.querySelector<HTMLButtonElement>(".session-btn")!;
    await act(async () => {
      open.dispatchEvent(new KeyboardEventCtor("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
    });
    assert.ok(openMenu(), "Shift+F10 opens the row menu");
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    assert.equal(openMenu(), null);
    assert.equal(document.activeElement, open, "focus returns to the row button");
  } finally {
    await unmount();
  }
});
