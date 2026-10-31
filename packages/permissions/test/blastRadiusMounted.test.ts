// The mounted permission card's "What this affects" list: workspace-relative
// targets set apart and kept left-to-right, scope notes, and no list for a
// routine request.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  location: dom.location,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  getComputedStyle: dom.getComputedStyle,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: PermissionBanner } = await import("../widgets/PermissionBanner.tsx");
const { setSessions } = await import("../../../apps/web/src/store.ts");

const WORKTREE = "/home/dev/project/.worktrees/isolate";
setSessions("p1", [{
  id: "s1", projectId: "p1", title: "Card", status: "running", createdAt: 1, updatedAt: 1, worktreePath: WORKTREE,
}] as never);

async function card(command: string, risk: "high" | "low", reasons: string[] = []) {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => root.render(createElement(PermissionBanner, {
    permissions: [{
      sessionId: "s1",
      requestId: `r-${command.length}-${risk}`,
      permission: "bash",
      patterns: [command],
      status: "pending",
      time: 1,
      preview: { title: "bash", lines: [command], risk, reasons },
    }],
  } as never)));
  return {
    container,
    rows: () => [...container.querySelectorAll(".permission-blast li")],
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("the affects list names each target relative to the workspace and where it lands", async () => {
  const view = await card(
    `rm -rf ${WORKTREE}/apps/web/dist ${WORKTREE}/.git/refs/heads/old /etc/nginx/default && git branch -D release/q3`,
    "high",
    ["destructive-delete"],
  );
  try {
    assert.equal(view.container.querySelector(".permission-blast-heading")?.textContent, "What this affects");
    const rows = view.rows();
    assert.deepEqual(rows.map((row) => row.querySelector(".permission-blast-text")?.textContent), [
      "Deletes apps/web/dist and everything in it",
      "Deletes .git/refs/heads/old and everything in it",
      "Deletes /etc/nginx/default and everything in it",
      "Deletes branch release/q3",
    ]);
    // The target itself is isolated technical text, readable inside RTL copy.
    const target = rows[2]!.querySelector("bdi.permission-blast-target");
    assert.equal(target?.textContent, "/etc/nginx/default");
    assert.equal(target?.getAttribute("dir"), "ltr");
    assert.deepEqual(rows.map((row) => [...row.querySelectorAll(".permission-blast-note")].map((note) => note.textContent)), [
      [], ["Git data"], ["outside the workspace"], [],
    ]);
    assert.equal(view.container.querySelector(".permission-terminal-body")?.getAttribute("dir"), "ltr");
    // The explanation scrolls inside its own body; the decisions sit outside
    // it, so a long list can never push them out of the card.
    const row = view.container.querySelector(".permission-request");
    const body = row?.querySelector(":scope > .permission-request-body");
    assert.ok(body?.querySelector(".permission-blast"));
    assert.ok(row?.querySelector(":scope > .perm-actions"));
    assert.equal(body?.querySelector(".perm-actions"), null);
  } finally {
    await view.unmount();
  }
});

test("a high-risk card keeps Allow all on the decision row; a routine card keeps its session policy", async () => {
  const held = await card("git push --force origin main", "high", ["history-rewrite"]);
  try {
    const actions = held.container.querySelector(".perm-actions")!;
    assert.deepEqual([...actions.children].map((child) => child.classList[child.classList.length - 1]), [
      "permission-deny", "permission-allow", "permission-allow-all",
    ]);
    const allowAll = actions.querySelector(".permission-allow-all")!;
    // A quiet peer on the same row, never styled as the primary Allow once.
    assert.ok(allowAll.classList.contains("ui-btn--quiet"));
    assert.ok(!allowAll.classList.contains("ui-btn--primary"));
    assert.ok(actions.querySelector(".permission-allow")!.classList.contains("ui-btn--primary"));
    assert.ok(actions.querySelector(".permission-deny")!.classList.contains("ui-btn--danger"));
    assert.equal(actions.querySelector(".permission-session"), null);
  } finally {
    await held.unmount();
  }
  const routine = await card("npm test", "low");
  try {
    assert.equal(routine.container.querySelector(".permission-allow-all"), null);
    assert.ok(routine.container.querySelector(".permission-session"));
  } finally {
    await routine.unmount();
  }
});

test("a SQL statement is named whole, quotes included", async () => {
  const view = await card(`psql -c "UPDATE users SET role = 'admin'"`, "high", ["database-destruction"]);
  try {
    assert.deepEqual(view.rows().map((row) => row.textContent), ["Runs UPDATE users SET role = 'admin'"]);
  } finally {
    await view.unmount();
  }
});

test("the scroll body marks content past either edge and stops watching on unmount", async () => {
  const observers: Array<{ targets: unknown[]; disconnected: boolean; fire(): void }> = [];
  const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    entry: { targets: unknown[]; disconnected: boolean; fire(): void };
    constructor(callback: () => void) {
      this.entry = { targets: [], disconnected: false, fire: callback };
      observers.push(this.entry);
    }
    observe(target: unknown) { this.entry.targets.push(target); }
    disconnect() { this.entry.disconnected = true; }
  };
  const view = await card("git push --force origin main", "high", ["history-rewrite"]);
  try {
    const body = view.container.querySelector(".permission-request-body") as unknown as HTMLElement;
    const observer = observers.at(-1)!;
    assert.deepEqual(observer.targets, [body, body.querySelector(".permission-request-content")]);
    const edges = () => [body.hasAttribute("data-more-above"), body.hasAttribute("data-more-below")];
    assert.deepEqual(edges(), [false, false], "content that fits has no fades");

    // The card shrinks (a resize): content now runs past the bottom.
    Object.defineProperty(body, "scrollHeight", { configurable: true, value: 600 });
    Object.defineProperty(body, "clientHeight", { configurable: true, value: 200 });
    observer.fire();
    assert.deepEqual(edges(), [false, true]);

    const scrollTo = (top: number) => {
      body.scrollTop = top;
      body.dispatchEvent(new dom.Event("scroll") as unknown as Event);
    };
    scrollTo(150);
    assert.deepEqual(edges(), [true, true]);
    scrollTo(400);
    assert.deepEqual(edges(), [true, false]);
    scrollTo(0);
    assert.deepEqual(edges(), [false, true]);

    await view.unmount();
    assert.equal(observer.disconnected, true);
    scrollTo(150);
    assert.deepEqual(edges(), [false, true], "the scroll listener is gone after unmount");
  } finally {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
    if (view.container.isConnected) await view.unmount();
  }
});

test("a routine request shows no affects list", async () => {
  const view = await card("rm -rf apps/web/dist", "low");
  try {
    assert.equal(view.container.querySelector(".permission-risk"), null);
    assert.equal(view.container.querySelector(".permission-blast"), null);
  } finally {
    await view.unmount();
  }
});
