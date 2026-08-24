// Findings 4+5 (UX-SHELL-CONSOLIDATION-02), mounted through a real React
// root: right-clicking a session row opens that row's action menu (the same
// menu available through right-click, long-press, and keyboard) with
// delete/archive/pin items, correct ARIA
// menu roles, and the keyboard contract (focus lands in the menu, arrows
// cycle, Escape closes back to the button). Every permanent deletion confirms,
// with additional activity context for a running session.
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
const { activateProject, setSessions } = await import("../src/store.ts");
const { default: SessionList } = await import("../src/components/sidebar/SessionList.tsx");

const session = (over: Partial<SessionProjection>): SessionProjection => ({
  id: "s", projectId: "p1", title: "session", status: "idle",
  createdAt: Date.now() - 60_000, updatedAt: Date.now() - 30_000,
  ...over,
});

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const KeyboardEventCtor = (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
// Window-level dispatch target for global Shift keydown/keyup listeners.
const windowTarget = dom as unknown as EventTarget;

async function mountList() {
  activateProject("p1");
  setSessions("p1", [
    session({ id: "s-idle", title: "Idle session" }),
    session({ id: "s-run", title: "Running session", status: "working", lastTurnAt: Date.now() - 10_000 }),
  ]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(SessionList, { projectId: "p1" })); });
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
    const menu = container.querySelector<HTMLElement>('[role="menu"]');
    assert.ok(menu, "context menu opened");
    // Scoped to the exact row that was right-clicked.
    assert.equal(menu!.getAttribute("aria-label"), "Actions for Idle session");
    const items = [...menu!.querySelectorAll<HTMLElement>('[role^="menuitem"]')].map((b) => b.textContent?.trim());
    for (const expected of ["Rename", "Fork", "Pin to top", "Archive", "Delete"]) {
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
    assert.equal(container.querySelector('[role="menu"]'), null, "Escape closes the menu");
    assert.equal(document.activeElement?.getAttribute("aria-label"), "Open Idle session");
  } finally {
    await unmount();
  }
});

test("every permanent delete confirms; running sessions include activity context", async () => {
  const { container, unmount } = await mountList();
  const confirms: string[] = [];
  let confirmAnswer = false;
  (globalThis.window as unknown as { confirm: (msg?: string) => boolean }).confirm = (msg?: string) => {
    confirms.push(msg ?? "");
    return confirmAnswer;
  };
  try {
    // Idle: a declined confirmation sends nothing.
    const idleRow = rowOf(container, "Idle session");
    await act(async () => {
      idleRow.dispatchEvent(new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true }));
    });
    fetchCalls.length = 0;
    const idleDelete = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((b) => b.textContent?.trim() === "Delete");
    await act(async () => { idleDelete!.click(); });
    assert.equal(confirms.length, 1, "idle delete confirms first");
    assert.match(confirms[0]!, /permanently removes the session and its history/i);
    assert.equal(fetchCalls.filter((c) => c.method === "DELETE").length, 0, "declined idle delete changes nothing");

    // Accepting the same idle confirmation issues the delete.
    confirmAnswer = true;
    await act(async () => {
      idleRow.dispatchEvent(new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true }));
    });
    const idleDelete2 = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((b) => b.textContent?.trim() === "Delete");
    await act(async () => { idleDelete2!.click(); });
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
    confirmAnswer = false;
    const runRow = rowOf(container, "Running session");
    await act(async () => {
      runRow.dispatchEvent(new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true }));
    });
    fetchCalls.length = 0;
    const runDelete = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((b) => b.textContent?.trim() === "Delete");
    await act(async () => { runDelete!.click(); });
    assert.equal(confirms.length, 3, "running delete confirms first");
    assert.match(confirms[2]!, /still running|permanently/i);
    assert.equal(fetchCalls.filter((c) => c.method === "DELETE").length, 0, "declined confirm deletes nothing");

    // Accepted confirm goes through.
    confirmAnswer = true;
    await act(async () => {
      runRow.dispatchEvent(new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true }));
    });
    const runDelete2 = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((b) => b.textContent?.trim() === "Delete");
    await act(async () => { runDelete2!.click(); });
    assert.ok(fetchCalls.some((c) => c.method === "DELETE" && c.url === "/api/sessions/s-run"));
  } finally {
    await unmount();
  }
});

test("shift-hover quick actions arm in every key/pointer order and stay labeled", async () => {
  const { container, unmount } = await mountList();
  try {
    const row = rowOf(container, "Idle session");
    // Buttons live in the DOM regardless of the modifier (focus reveals them).
    const archive = row.querySelector('[aria-label="Archive Idle session"]');
    const del = row.querySelector('[aria-label="Delete Idle session"]');
    assert.ok(archive && del, "quick actions rendered with per-session labels");

    // (a) Modifier carried on the pointer event itself. React synthesizes
    // enter/leave from bubbling mouseover/mouseout, so dispatch those with a
    // relatedTarget outside the row.
    await act(async () => {
      row.dispatchEvent(new MouseEventCtor("mouseover", { bubbles: true, shiftKey: true, relatedTarget: document.body }));
    });
    assert.ok(row.className.includes("quick-armed"), `row armed on shift-hover (${row.className})`);
    await act(async () => {
      row.dispatchEvent(new MouseEventCtor("mouseout", { bubbles: true, relatedTarget: document.body }));
    });
    assert.ok(!row.className.includes("quick-armed"), "row disarms on leave");

    // (b) Hover first without the modifier, press Shift mid-hover.
    await act(async () => {
      row.dispatchEvent(new MouseEventCtor("mouseover", { bubbles: true, relatedTarget: document.body }));
    });
    assert.ok(!row.className.includes("quick-armed"), "plain hover stays disarmed");
    await act(async () => {
      windowTarget.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Shift" }));
    });
    assert.ok(row.className.includes("quick-armed"), "Shift keydown mid-hover arms");
    await act(async () => {
      windowTarget.dispatchEvent(new KeyboardEventCtor("keyup", { key: "Shift" }));
    });
    assert.ok(!row.className.includes("quick-armed"), "Shift keyup disarms");
    await act(async () => {
      row.dispatchEvent(new MouseEventCtor("mouseout", { bubbles: true, relatedTarget: document.body }));
    });

    // (c) Stage-3 regression: Shift held down BEFORE hovering, while the
    // pointer events themselves carry no modifier flag (synthesized input).
    await act(async () => {
      windowTarget.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Shift" }));
    });
    await act(async () => {
      row.dispatchEvent(new MouseEventCtor("mouseover", { bubbles: true, relatedTarget: document.body }));
    });
    assert.ok(row.className.includes("quick-armed"), "Shift-before-hover arms");
    await act(async () => {
      windowTarget.dispatchEvent(new KeyboardEventCtor("keyup", { key: "Shift" }));
      row.dispatchEvent(new MouseEventCtor("mouseout", { bubbles: true, relatedTarget: document.body }));
    });
    assert.ok(!row.className.includes("quick-armed"), "release + leave disarms");
  } finally {
    await unmount();
  }
});
