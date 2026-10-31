// A pinned chat older than the navigator's recency page must still load: the
// project refresh reads the reader's pinned rows alongside the newest fifty.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionProjection, SessionSummaryQuery } from "@polyth/contracts";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage as unknown as Storage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
globalThis.fetch = async () => new Response("{}", { status: 404 });

const { refreshSessions } = await import("../src/init.ts");
const { api } = await import("@polyth/session/web-api");
const { getState } = await import("../src/store.ts");

const row = (id: string, updatedAt: number, extra: Partial<SessionProjection> = {}): SessionProjection => ({
  id, projectId: "pin-project", title: id, status: "idle", createdAt: 1, updatedAt, lastTurnAt: updatedAt, summary: true, ...extra,
});

test("a project refresh loads pinned chats that fell off the recency page", async () => {
  const original = api.listSessionSummaries;
  const calls: SessionSummaryQuery[] = [];
  api.listSessionSummaries = (async (query: SessionSummaryQuery) => {
    calls.push(query);
    return query.pinned
      ? { sessions: [row("old-pinned", 1, { pinned: { position: 0 } })], complete: true, revision: 1 }
      : { sessions: [row("recent", 99)], complete: false, next: { updatedAt: 99, id: "recent" }, revision: 1 };
  }) as typeof api.listSessionSummaries;
  try {
    await refreshSessions("pin-project");
    const ids = getState().sessions.filter((session) => session.projectId === "pin-project").map((session) => session.id).sort();
    assert.deepEqual(ids, ["old-pinned", "recent"]);
    assert.deepEqual(getState().sessions.find((session) => session.id === "old-pinned")?.pinned, { position: 0 });
    assert.deepEqual(calls.map((call) => call.pinned === true).sort(), [false, true]);
  } finally {
    api.listSessionSummaries = original;
  }
});

test("a failed pinned read never loses the recency page", async () => {
  const original = api.listSessionSummaries;
  const warn = console.warn;
  console.warn = () => {};
  api.listSessionSummaries = (async (query: SessionSummaryQuery) => {
    if (query.pinned) throw new Error("old server");
    return { sessions: [row("still-recent", 98, { projectId: "pin-project-2" })], complete: true, revision: 1 };
  }) as typeof api.listSessionSummaries;
  try {
    await refreshSessions("pin-project-2");
    assert.ok(getState().sessions.some((session) => session.id === "still-recent"));
  } finally {
    api.listSessionSummaries = original;
    console.warn = warn;
  }
});
