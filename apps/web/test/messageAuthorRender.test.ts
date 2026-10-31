// Mounted check: in a shared session, someone else's prompt carries a quiet
// name and an article label naming them; one's own prompt carries neither.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { JsonObject, SessionEvent } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  location: dom.location,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MutationObserver: dom.MutationObserver,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
dom.localStorage.setItem("polyth.activeAccount", "usr_ann");

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Timeline } = await import("../src/components/Timeline.tsx");
const { activateProject, activateSession, applyEvent, getState, reduceSessionModel, setSessions } = await import("../src/store.ts");

const sessionId = "shared-chat";
const event = (seq: number, type: string, data: JsonObject): SessionEvent => ({
  id: `ev-${seq}`, sessionId, seq, time: Date.UTC(2026, 9, 13, 9, seq), type, data, v: 1,
});

test("only someone else's prompt is named", async () => {
  const viewport = document.createElement("div");
  viewport.className = "timeline-viewport";
  const timeline = document.createElement("div");
  timeline.className = "timeline";
  const host = document.createElement("div");
  timeline.appendChild(host);
  viewport.append(timeline);
  document.body.appendChild(viewport);
  const root = createRoot(host);
  try {
    await act(async () => {
      activateProject("family");
      setSessions("family", [{ id: sessionId, projectId: "family", title: "Shared", status: "idle", createdAt: 1, updatedAt: 1 }]);
      activateSession(sessionId);
      for (const ev of [
        event(1, "user/message", { text: "mine", author: { userId: "usr_ann", name: "Ann" } }),
        event(2, "user/message", { text: "hers", author: { userId: "usr_bea", name: "Bea" } }),
        event(3, "user/message", { text: "unnamed", author: { userId: "usr_cy" } }),
        // A judge's fixed message is labeled whoever's judge sent it.
        event(4, "user/message", { text: "Continue.", author: { userId: "usr_ann", name: "Ann", via: "judge" } }),
        event(5, "user/message", { text: "Continue.", author: { userId: "usr_bea", name: "Bea", via: "judge" } }),
      ]) applyEvent(ev);
      root.render(createElement(Timeline, { model: reduceSessionModel(sessionId, getState().events[sessionId] ?? []) }));
    });
    const rows = [...host.querySelectorAll<HTMLElement>(".msg.user")];
    assert.equal(rows.length, 5);
    const names = rows.map((row) => row.querySelector(".msg-person")?.textContent ?? null);
    assert.deepEqual(names, [null, "Bea", "Someone else", "Sent by a judge", "Bea · Sent by a judge"]);
    assert.match(rows[3]!.getAttribute("aria-label") ?? "", /^User message sent at .*\. Sent by a judge$/);
    assert.match(rows[4]!.getAttribute("aria-label") ?? "", /^Message from Bea sent at .*\. Sent by a judge$/);
    assert.equal(rows[3]!.dataset.via, "judge");
    assert.match(rows[0]!.getAttribute("aria-label") ?? "", /^User message sent at /);
    assert.match(rows[1]!.getAttribute("aria-label") ?? "", /^Message from Bea sent at /);
    // The name sits above the bubble and is not read twice by a screen reader.
    assert.equal(rows[1]!.firstElementChild?.className, "msg-person");
    assert.equal(rows[1]!.querySelector(".msg-person")?.getAttribute("aria-hidden"), "true");
  } finally {
    await act(async () => {
      activateSession(null);
      setSessions("family", []);
    });
    await act(async () => root.unmount());
    viewport.remove();
  }
});
