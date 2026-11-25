// A failed startup row is only dropped from the navigator when the person chose
// "Delete failed startup sessions". With the choice off the row still holds no
// turn, but it holds the reason the chat never ran, so the list must keep it
// visible instead of making the person think it was deleted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionProjection } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost:3000/" });
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  location: dom.location, Event: dom.Event, Node: dom.Node, HTMLElement: dom.HTMLElement,
  getComputedStyle: dom.getComputedStyle.bind(dom), matchMedia: dom.matchMedia.bind(dom),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
globalThis.fetch = async () => { throw new Error("visibility must not fetch"); };
register("./tsxHooks.mjs", import.meta.url);

const store = await import("../src/store.ts");

const failedStartup = (id: string, extra: Partial<SessionProjection> = {}): SessionProjection => ({
  id,
  projectId: "p",
  title: "New session",
  titleSource: "placeholder",
  status: "failed",
  createdAt: 1,
  updatedAt: 2,
  ...extra,
} as SessionProjection);

const listed = (id: string): boolean => store.getState().sessions.some((session) => session.id === id);

test("a failed startup with no turn leaves the navigator when deletion is enabled", () => {
  store.updateSettings({ autoDeleteFailedStartupSessions: true });
  store.upsertSessions([failedStartup("zombie-allowed")]);
  assert.equal(listed("zombie-allowed"), false);
  store.upsertSession(failedStartup("zombie-allowed-single"));
  assert.equal(listed("zombie-allowed-single"), false);
});

test("a failed startup stays listed when the person kept failed sessions", () => {
  store.updateSettings({ autoDeleteFailedStartupSessions: false });
  try {
    store.upsertSessions([failedStartup("zombie-kept")]);
    assert.equal(listed("zombie-kept"), true);
    // A reconnect re-sends the same row as a new object: it must stay listed.
    store.upsertSessions([failedStartup("zombie-kept", { updatedAt: 3 })]);
    assert.equal(listed("zombie-kept"), true);
    store.upsertSession(failedStartup("zombie-kept-single", { updatedAt: 4 }));
    assert.equal(listed("zombie-kept-single"), true);
  } finally {
    store.updateSettings({ autoDeleteFailedStartupSessions: true });
  }
});
