// Session row actions (P2-W1), mounted through a real React root: every row
// owns one ui/Menu reachable through right-click, long-press, Shift+F10, and
// a single ellipsis trigger (hover-revealed on fine pointers, persistent on
// touch). The menu carries delete/archive/pin/labels with correct ARIA menu
// roles and the keyboard contract (focus lands in the menu, arrows cycle,
// Escape closes back to the opener). Every menu/swipe deletion confirms, with
// additional activity context for a running session. Quick archive/delete
// buttons mount while a touch swipe is in progress or while Shift is held on
// a desktop shell (shift-quick mode); Shift-quick delete skips confirmation
// for background rows and keeps it for sessions with live agent activity.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionProjection, WorkspaceLabel } from "@polyth/contracts";
import { readFile } from "node:fs/promises";

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
const fetchCalls: Array<{ url: string; method: string; body?: string }> = [];
let labelFixtures: WorkspaceLabel[] = [];
let sessionListFixtures: SessionProjection[] | null = null;
(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }) => {
  const request = { url: String(url), method: init?.method ?? "GET", ...(init?.body ? { body: init.body } : {}) };
  fetchCalls.push(request);
  const payload = request.method === "GET" && request.url === "/api/labels"
    ? labelFixtures
    : request.method === "GET" && request.url === "/api/sessions/s-idle"
      ? { id: "s-idle", projectId: "p1", title: "Idle session", status: "idle", createdAt: 1, updatedAt: 1 }
    : request.method === "GET" && request.url.startsWith("/api/sessions?") && sessionListFixtures !== null
      ? sessionListFixtures
      : [];
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
    text: async () => JSON.stringify(payload),
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
const label = (id: string, name: string): WorkspaceLabel => ({
  id,
  name,
  color: `label-color-${id}`,
  position: Number(id.replace(/\D/g, "")) || 0,
  revision: 1,
});

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const KeyboardEventCtor = (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
const EventCtor = (dom as unknown as { Event: typeof Event }).Event;

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
    session({ id: "pinned", title: "Pinned worktree", status: "working", branch: "feature/pinned", worktreePath: "/repo-pinned", pinned: { position: 0 } }),
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
    assert.doesNotMatch(pinned!.textContent ?? "", /feature\/pinned/, "active state outranks the narrow worktree pill");
    assert.ok(pinned!.querySelector(".session-pin-icon"), "pinned chat shows a pin icon");
    assert.match(
      pinned!.querySelector<HTMLButtonElement>(".session-btn")?.title ?? "",
      /feature\/pinned/,
      "the full branch remains available on hover",
    );
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

test("quick actions absent at rest; keyboard reaches the same menu via Shift+F10", async () => {
  const { container, unmount } = await mountList();
  try {
    const row = rowOf(container, "Idle session");
    // No resting quick buttons: without a swipe or a held Shift the row has
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

test("pointer intent wires the bounded session-tail prefetch once", async () => {
  const { container, unmount } = await mountList();
  try {
    const open = rowOf(container, "Idle session").querySelector<HTMLButtonElement>(".session-btn")!;
    const before = fetchCalls.length;
    await act(async () => {
      open.dispatchEvent(new (dom as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent(
        "pointerover",
        { bubbles: true, pointerType: "mouse" },
      ));
      open.dispatchEvent(new (dom as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent(
        "pointerover",
        { bubbles: true, pointerType: "mouse" },
      ));
      await Promise.resolve();
    });
    assert.deepEqual(
      fetchCalls.slice(before).filter((call) => call.url.includes("/api/sessions/s-idle/events")),
      [{ url: "/api/sessions/s-idle/events?afterSeq=0&limit=40&prefetch=1", method: "GET" }],
    );
  } finally {
    await unmount();
  }
});

test("holding Shift mounts quick actions; delete skips confirm only for background rows", async () => {
  const { container, unmount } = await mountList();
  const pressShift = () => act(async () => {
    (dom as unknown as EventTarget).dispatchEvent(
      new KeyboardEventCtor("keydown", { key: "Shift", shiftKey: true }) as unknown as Event,
    );
  });
  const releaseShift = () => act(async () => {
    (dom as unknown as EventTarget).dispatchEvent(
      new KeyboardEventCtor("keyup", { key: "Shift" }) as unknown as Event,
    );
  });
  try {
    const idleRow = rowOf(container, "Idle session");
    assert.equal(idleRow.querySelector(".session-quick"), null, "no quick layer before Shift");

    await pressShift();
    assert.ok(idleRow.classList.contains("shift-quick"), "held Shift arms the row");
    const quick = idleRow.querySelector<HTMLElement>(".session-quick");
    assert.ok(quick, "quick layer mounts while Shift is held");
    assert.equal(quick!.querySelectorAll(".session-quick-btn").length, 2, "archive + delete");

    // Background idle row: Shift-quick delete is immediate — no dialog.
    fetchCalls.length = 0;
    const idleDelete = quick!.querySelector<HTMLButtonElement>(".session-quick-btn.danger");
    assert.ok(idleDelete);
    await act(async () => {
      idleDelete!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      container.querySelector('[role="dialog"][aria-label="Delete session"]'),
      null,
      "background rows delete without a confirmation",
    );
    assert.ok(
      fetchCalls.some((c) => c.method === "DELETE" && c.url === "/api/sessions/s-idle"),
      `immediate DELETE issued (got: ${JSON.stringify(fetchCalls)})`,
    );

    // The refresh stub answered [] — re-seed so the running row stays visible.
    await act(async () => {
      setSessions("p1", [
        session({ id: "s-run", title: "Running session", status: "working", lastTurnAt: Date.now() - 10_000 }),
      ]);
    });
    await pressShift();

    // A session with live agent activity keeps its confirmation even in
    // shift-quick mode.
    const runRow = rowOf(container, "Running session");
    fetchCalls.length = 0;
    const runDelete = runRow.querySelector<HTMLButtonElement>(".session-quick .session-quick-btn.danger");
    assert.ok(runDelete, "running row also mounts the quick layer");
    await act(async () => { runDelete!.click(); });
    const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Delete session"]');
    assert.ok(dialog, "active work keeps the delete confirmation");
    await act(async () => {
      dialog!.querySelector<HTMLButtonElement>(".ui-btn--quiet")!.click();
    });
    assert.equal(fetchCalls.filter((c) => c.method === "DELETE").length, 0, "declined confirm deletes nothing");

    // Releasing Shift disarms the quick layer.
    await releaseShift();
    assert.equal(runRow.querySelector(".session-quick"), null, "quick layer unmounts on release");
    assert.ok(!runRow.classList.contains("shift-quick"));
  } finally {
    await releaseShift();
    await unmount();
  }
});

test("six or fewer labels stay as inline menu checkboxes", async () => {
  labelFixtures = Array.from({ length: 6 }, (_, index) =>
    label(`label-${index + 1}`, `Label ${index + 1}`));
  const { container, unmount } = await mountList();
  try {
    const row = rowOf(container, "Idle session");
    await act(async () => {
      row.dispatchEvent(new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true }));
    });

    assert.equal(
      document.querySelectorAll('[role="menuitemcheckbox"]').length,
      6,
      "short label lists render inline checkboxes",
    );
    assert.equal(
      menuItems().some((item) => item.textContent?.trim() === "Labels…"),
      false,
      "short label lists do not add a nested picker",
    );
  } finally {
    labelFixtures = [];
    await unmount();
  }
});

test("more than six labels open a searchable apply-immediately picker", async () => {
  const labels = [
    label("label-1", "Alpha"),
    label("label-2", "Beta"),
    label("label-3", "Build"),
    label("label-4", "Docs"),
    label("label-5", "Feature"),
    label("label-6", "Fix"),
    label("label-7", "Gamma"),
  ];
  labelFixtures = labels;
  const { container, unmount } = await mountList();
  try {
    const row = rowOf(container, "Idle session");
    await act(async () => {
      row.dispatchEvent(new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true }));
    });
    assert.equal(document.querySelectorAll('[role="menuitemcheckbox"]').length, 0);
    const openLabels = menuItems().find((item) => item.textContent?.trim() === "Labels…");
    assert.ok(openLabels, "long label lists expose one picker row");

    await act(async () => { openLabels!.click(); });
    const picker = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Labels"]');
    assert.ok(picker, "Labels row opens the responsive picker");
    assert.equal(picker!.querySelectorAll(".session-label-option").length, 7);

    const search = picker!.querySelector<HTMLInputElement>('[aria-label="Search labels"]');
    assert.ok(search, "picker has a searchable text input");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        (dom as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue!.call(search, "gamma");
      search!.dispatchEvent(new EventCtor("input", { bubbles: true }));
    });
    const filtered = picker!.querySelectorAll<HTMLElement>(".session-label-option");
    assert.equal(filtered.length, 1, "search filters labels");
    assert.match(filtered[0]?.textContent ?? "", /Gamma/);

    sessionListFixtures = [
      session({ id: "s-idle", title: "Idle session" }),
      session({ id: "s-run", title: "Running session", status: "working", lastTurnAt: Date.now() - 10_000 }),
    ];
    fetchCalls.length = 0;
    const gammaCheckbox = filtered[0]!.querySelector<HTMLInputElement>('input[type="checkbox"]');
    assert.ok(gammaCheckbox);
    await act(async () => {
      gammaCheckbox!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const organize = fetchCalls.find((call) =>
      call.method === "PATCH" && call.url === "/api/sessions/s-idle/organize");
    assert.ok(organize, "toggle calls organizeSession for the selected row");
    assert.deepEqual(JSON.parse(organize!.body ?? "{}"), { labelIds: ["label-7"] });
    assert.ok(
      document.querySelector('[role="dialog"][aria-label="Labels"]'),
      "the picker stays open after applying a label",
    );
  } finally {
    labelFixtures = [];
    sessionListFixtures = null;
    await unmount();
  }
});

test("palette session verbs reuse sidebar handlers and never expose delete", async () => {
  const [palette, list, actions] = await Promise.all([
    readFile(new URL("../src/components/CommandPalette.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/sidebar/SessionList.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/sessionActions.ts", import.meta.url), "utf8"),
  ]);
  for (const handler of [
    "archiveSessionWithPolicy",
    "renameSessionTitle",
    "toggleSessionPin",
  ]) {
    assert.ok(palette.includes(handler), `palette calls shared ${handler}`);
    assert.ok(list.includes(handler), `sidebar calls shared ${handler}`);
    assert.ok(actions.includes(`function ${handler}`), `${handler} has one implementation`);
  }
  assert.match(
    palette,
    /SESSION_PALETTE_VERBS:[\s\S]*\[\s*"archive",\s*"pin",\s*"rename",?\s*\]/,
  );
  assert.match(palette, /e\.key === "Tab" \|\| e\.key === "ArrowRight"/);
  assert.match(palette, /e\.key === "Enter"[\s\S]*runSessionVerb/);
  assert.doesNotMatch(
    palette.slice(
      palette.indexOf("const SESSION_PALETTE_VERBS"),
      palette.indexOf("function CommandIcon"),
    ),
    /delete/i,
  );
});
