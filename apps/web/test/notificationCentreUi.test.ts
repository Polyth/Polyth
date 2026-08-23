// NTF-01 surfaces, mounted through a real React root: the bell is contributed
// through app.header.actions and the panel through workspace.right.tabs (the
// slot bridge derives surface "slot:notification-centre") — no host was edited.
// Covers bell badge/name/toggle, newest-first rows with semantic times and
// non-color kind labels, dead-session disabling, activation = mark-read +
// openSession, the Centre history display filter, read-all, the confirmed
// clear, and the error/retry state.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { NotificationRecord } from "@polyth/contracts";

const dom = new Window();
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Benign API stub: nothing in these tests may reach a real server.
(globalThis as { fetch?: unknown }).fetch = async () => ({
  ok: true, status: 200, statusText: "OK",
  json: async () => ({}), text: async () => "{}",
});

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { listSlots } = await import("../src/slots.ts");
const { slotSurfaces } = await import("../src/surfaces.ts");
const { getState, setRailPlugin, setSessions } = await import("../src/store.ts");
const { setUiSettings } = await import("../src/uiPrefs.ts");
const { createNotificationCentre } = await import("../src/notificationCentre.ts");
const {
  NOTIFICATION_SURFACE_ID, NotificationBell, NotificationCentrePanel, installNotificationCentre,
} = await import("../src/components/NotificationCentre.tsx");
type NotificationCentreRemote = import("../src/notificationCentre.ts").NotificationCentreRemote;

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const click = (el: Element) => el.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));

const rec = (over: Partial<NotificationRecord> & { id: string; ts: number }): NotificationRecord => ({
  key: `${over.sessionId ?? "s1"}:turn:idle`, kind: "completed",
  sessionId: "s1", projectId: "p1",
  title: "Polyth — Session", body: "Session — finished", read: false,
  ...over,
});

/** Test centre backed by a controllable remote, pre-seeded via bootstrap. */
async function seededCentre(items: NotificationRecord[], unread?: number) {
  const calls: Array<{ op: string; arg?: unknown }> = [];
  let failReads = false;
  const remote: NotificationCentreRemote = {
    async list(after) {
      calls.push({ op: "list", arg: after });
      return { items, unread: unread ?? items.filter((r) => !r.read).length };
    },
    async read(ids) {
      calls.push({ op: "read", arg: [...ids] });
      if (failReads) throw new Error("net");
      return { updated: ids.length, unread: 0 };
    },
    async readAll() {
      calls.push({ op: "readAll" });
      return { updated: 0, unread: 0 };
    },
    async clear() {
      calls.push({ op: "clear" });
      return { cleared: 0, unread: 0 };
    },
  };
  const centre = createNotificationCentre(remote);
  await centre.bootstrap();
  return { centre, calls, setFailReads: (v: boolean) => { failReads = v; } };
}

async function mount(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("install contributes bell + panel through the slot registry (no host edits)", () => {
  installNotificationCentre();
  installNotificationCentre(); // idempotent

  const bells = listSlots("app.header.actions").filter((i) => i.id === "notification-bell");
  assert.equal(bells.length, 1);

  const tabs = listSlots("workspace.right.tabs").filter((i) => i.id === "notification-centre");
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0]!.meta?.title, "Notifications");

  // The existing slot bridge turns the registration into the rail surface the
  // bell toggles — ContextRail renders it without enumerating anything new.
  const surfaces = slotSurfaces({ changeCount: 0, eventCount: 0, totalTokens: 0, hasSession: false });
  const bridged = surfaces.find((s) => s.id === NOTIFICATION_SURFACE_ID);
  assert.ok(bridged, "slot bridge derived the notification surface");
  assert.equal(bridged!.title, "Notifications");
});

test("bell: exact accessible count, absent badge at zero, 99+ display cap, rail toggle", async () => {
  const { centre } = await seededCentre([]);
  const { container, unmount } = await mount(createElement(NotificationBell, { centre }));
  try {
    const btn = container.querySelector("button")!;
    assert.equal(btn.getAttribute("aria-label"), "Notifications, none unread");
    assert.equal(container.querySelector(".notification-badge"), null);

    await act(async () => {
      for (let i = 0; i < 120; i++) centre.append(rec({ id: `n${i}`, ts: i + 1 }));
    });
    assert.equal(btn.getAttribute("aria-label"), "Notifications, 120 unread");
    assert.equal(container.querySelector(".notification-badge")!.textContent, "99+");

    // Toggle open/closed against the real store (global — works sessionless).
    setRailPlugin(null);
    await act(async () => { click(btn); });
    assert.equal(getState().railPlugin, NOTIFICATION_SURFACE_ID);
    assert.equal(btn.getAttribute("aria-expanded"), "true");
    await act(async () => { click(btn); });
    assert.equal(getState().railPlugin, null);
    assert.equal(btn.getAttribute("aria-expanded"), "false");
  } finally {
    await unmount();
  }
});

test("panel rows: newest first, semantic time, textual kind, dead-session row disabled", async () => {
  setSessions("p1", [{ id: "s-live", projectId: "p1", title: "Live", status: "idle", createdAt: 1, updatedAt: 2 }]);
  const { centre } = await seededCentre([
    rec({ id: "dead", ts: 1000, sessionId: "s-gone", kind: "failed" }),
    rec({ id: "live", ts: 2000, sessionId: "s-live", kind: "question" }),
  ]);
  const opened: string[] = [];
  const { container, unmount } = await mount(createElement(NotificationCentrePanel, {
    centre, open: async (id: string) => { opened.push(id); },
  }));
  try {
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".ntc-row")];
    assert.equal(rows.length, 2);

    // Newest first; kind is a textual label, never color alone.
    assert.ok(rows[0]!.textContent!.includes("Question"));
    assert.ok(rows[1]!.textContent!.includes("Failed"));

    // Unread rows carry sr-only text; times are semantic <time dateTime>.
    assert.ok(rows[0]!.querySelector(".sr-only")!.textContent!.includes("unread"));
    assert.equal(rows[0]!.querySelector("time")!.getAttribute("datetime"), new Date(2000).toISOString());

    // Live session row is enabled; missing session row is disabled + explained.
    assert.equal(rows[0]!.disabled, false);
    assert.equal(rows[1]!.disabled, true);
    assert.ok(rows[1]!.textContent!.includes("Session no longer available"));

    // A disabled button cannot navigate.
    await act(async () => { click(rows[1]!); });
    assert.deepEqual(opened, []);
  } finally {
    await unmount();
    setSessions("p1", []);
  }
});

test("project-mismatched session is disabled even though the session id exists", async () => {
  setSessions("p2", [{ id: "s-live", projectId: "p2", title: "Other project", status: "idle", createdAt: 1, updatedAt: 2 }]);
  const { centre } = await seededCentre([rec({ id: "a", ts: 1, sessionId: "s-live", projectId: "p1" })]);
  const { container, unmount } = await mount(createElement(NotificationCentrePanel, {
    centre, open: async () => {},
  }));
  try {
    const row = container.querySelector<HTMLButtonElement>(".ntc-row")!;
    assert.equal(row.disabled, true);
    assert.ok(row.textContent!.includes("Session no longer available"));
  } finally {
    await unmount();
    setSessions("p2", []);
  }
});

test("activating a live row marks it read optimistically and opens the session", async () => {
  setSessions("p1", [{ id: "s1", projectId: "p1", title: "Live", status: "idle", createdAt: 1, updatedAt: 2 }]);
  const { centre, calls } = await seededCentre([rec({ id: "a", ts: 1 })]);
  const opened: string[] = [];
  const { container, unmount } = await mount(createElement(NotificationCentrePanel, {
    centre, open: async (id: string) => { opened.push(id); },
  }));
  try {
    await act(async () => { click(container.querySelector(".ntc-row")!); });
    assert.deepEqual(opened, ["s1"]);
    assert.deepEqual(calls.filter((c) => c.op === "read"), [{ op: "read", arg: ["a"] }]);
    assert.equal(centre.getState().items[0]!.read, true);

    // Re-activating an already-read row re-opens but does not re-POST.
    await act(async () => { click(container.querySelector(".ntc-row")!); });
    assert.deepEqual(opened, ["s1", "s1"]);
    assert.equal(calls.filter((c) => c.op === "read").length, 1);
  } finally {
    await unmount();
    setSessions("p1", []);
  }
});

test("Centre history off keeps unread rows only and names the empty state", async () => {
  const { centre } = await seededCentre([
    rec({ id: "read1", ts: 1, read: true, title: "Already read row" }),
    rec({ id: "unread1", ts: 2, title: "Still unread row" }),
  ]);
  const { container, unmount } = await mount(createElement(NotificationCentrePanel, {
    centre, open: async () => {},
  }));
  try {
    assert.equal(container.querySelectorAll(".ntc-row").length, 2);

    await act(async () => { setUiSettings({ notificationCentreHistory: false }); });
    assert.equal(container.querySelectorAll(".ntc-row").length, 1);
    assert.ok(container.textContent!.includes("Still unread row"));
    assert.ok(!container.textContent!.includes("Already read row"));

    // Reading the last unread row leaves the named no-unread state (data kept).
    await act(async () => { await centre.markRead(["unread1"]); });
    assert.equal(container.querySelectorAll(".ntc-row").length, 0);
    assert.ok(container.textContent!.includes("No unread notifications"));

    // Turning history back on reveals the retained read rows again.
    await act(async () => { setUiSettings({ notificationCentreHistory: true }); });
    assert.equal(container.querySelectorAll(".ntc-row").length, 2);
  } finally {
    await unmount();
    setUiSettings({ notificationCentreHistory: true });
  }
});

test("mark all read; clear requires an explicit confirm step", async () => {
  const { centre, calls } = await seededCentre([rec({ id: "a", ts: 1 }), rec({ id: "b", ts: 2 })]);
  const { container, unmount } = await mount(createElement(NotificationCentrePanel, {
    centre, open: async () => {},
  }));
  try {
    const buttons = () => [...container.querySelectorAll<HTMLButtonElement>(".ntc-toolbar button")];
    const byText = (text: string) => buttons().find((b) => b.textContent === text);

    await act(async () => { click(byText("Mark all read")!); });
    assert.equal(calls.filter((c) => c.op === "readAll").length, 1);
    assert.equal(centre.getState().unread, 0);

    // First click only arms the confirm — nothing is deleted yet.
    await act(async () => { click(byText("Clear notifications")!); });
    assert.equal(calls.filter((c) => c.op === "clear").length, 0);
    assert.ok(byText("Confirm clear"));

    // Cancel disarms without clearing.
    await act(async () => { click(byText("Cancel")!); });
    assert.equal(calls.filter((c) => c.op === "clear").length, 0);
    assert.equal(centre.getState().items.length, 2);

    // Arm again and confirm: now the destructive call happens.
    await act(async () => { click(byText("Clear notifications")!); });
    await act(async () => { click(byText("Confirm clear")!); });
    assert.equal(calls.filter((c) => c.op === "clear").length, 1);
    assert.equal(centre.getState().items.length, 0);
  } finally {
    await unmount();
  }
});

test("a failed mutation surfaces the retryable error strip; Retry re-fetches", async () => {
  const { centre, calls, setFailReads } = await seededCentre([rec({ id: "a", ts: 1 })]);
  const { container, unmount } = await mount(createElement(NotificationCentrePanel, {
    centre, open: async () => {},
  }));
  try {
    setFailReads(true);
    await act(async () => { await centre.markRead(["a"]); });
    const alertEl = container.querySelector('[role="alert"]')!;
    assert.ok(alertEl.textContent!.includes("retry") || alertEl.textContent!.includes("Retry"));

    const listCallsBefore = calls.filter((c) => c.op === "list").length;
    await act(async () => { click(alertEl.querySelector("button")!); });
    assert.equal(calls.filter((c) => c.op === "list").length, listCallsBefore + 1);
  } finally {
    await unmount();
  }
});
