// Mounted check: every finished answer keeps its quick actions, also when
// tools, an answered question or more text of the same turn follow it. Only the
// terminal answer of a turn carries the identity panel.
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

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Timeline } = await import("../src/components/Timeline.tsx");
const { activateProject, activateSession, applyEvent, getState, reduceSessionModel, setSessions } = await import("../src/store.ts");

const sessionId = "answer-actions";
let seq = 0;
const event = (type: string, data: JsonObject): SessionEvent => {
  seq += 1;
  return { id: `ev-${seq}`, sessionId, seq, time: Date.UTC(2026, 9, 14, 9, seq), type, data, v: 1 };
};
const idle = () => setSessions("p", [{ id: sessionId, projectId: "p", title: "Chat", status: "idle", createdAt: 1, updatedAt: 1 }]);

test("answers followed by more of their turn keep quick actions", async () => {
  const timeline = document.createElement("div");
  timeline.className = "timeline";
  const host = document.createElement("div");
  timeline.appendChild(host);
  document.body.appendChild(timeline);
  const root = createRoot(host);
  try {
    await act(async () => {
      activateProject("p");
      idle();
      activateSession(sessionId);
      for (const ev of [
        event("user/message", { text: "First." }),
        event("turn/started", { turnId: "t1" }),
        event("assistant/message", { partId: "a1", text: "Answer one." }),
        event("turn/stopped", { turnId: "t1", reason: "completed" }),
        event("user/message", { text: "Second." }),
        event("turn/started", { turnId: "t2" }),
        event("assistant/message", { partId: "a2", text: "Before the tool." }),
        event("tool/call", { callId: "c1", tool: "read", input: { path: "a.ts" } }),
        event("tool/result", { callId: "c1", tool: "read", output: "x" }),
        event("assistant/message", { partId: "a3", text: "Before the question." }),
        event("question/asked", { requestId: "q", questions: [{ id: "db", question: "DB?", options: [{ label: "pg" }] }] }),
        event("question/answered", { requestId: "q", answers: { db: "pg" } }),
        event("assistant/message", { partId: "a4", text: "Final." }),
        event("turn/stopped", { turnId: "t2", reason: "completed" }),
      ]) applyEvent(ev);
      // The server reports the finished turn as idle.
      idle();
      root.render(createElement(Timeline, { model: reduceSessionModel(sessionId, getState().events[sessionId] ?? []) }));
    });
    const answers = new Map([...host.querySelectorAll<HTMLElement>(".msg.assistant")]
      .map((row) => [row.querySelector(".bubble")?.textContent ?? "", row] as const)
      .filter(([text]) => text !== ""));
    const footer = (text: string) => answers.get(text)?.querySelector<HTMLElement>(".chat-response-footer") ?? null;
    for (const text of ["Answer one.", "Before the tool.", "Before the question.", "Final."]) {
      const row = footer(text);
      assert.ok(row, `${text} has a footer`);
      assert.ok(row.querySelector(".chat-response-actions"), `${text} has quick actions`);
      assert.equal(row.hasAttribute("data-dormant"), false, `${text} is not dormant`);
    }
    for (const text of ["Before the tool.", "Before the question."]) {
      assert.equal(footer(text)!.getAttribute("data-actions-only"), "true");
      assert.equal(footer(text)!.querySelector(".chat-response-identity"), null);
    }
    for (const text of ["Answer one.", "Final."]) {
      assert.equal(footer(text)!.hasAttribute("data-actions-only"), false);
      assert.ok(footer(text)!.querySelector(".chat-response-identity"));
    }

    // A live turn: an interim answer that a row already follows takes its
    // footer's box at once, dormant (invisible), so the turn's end only reveals
    // it and moves no row below it; answers of closed turns keep their
    // (dormant) footers too.
    await act(async () => {
      for (const ev of [
        event("user/message", { text: "Third." }),
        event("turn/started", { turnId: "t3" }),
        event("assistant/message", { partId: "a5", text: "Live interim." }),
        event("tool/call", { callId: "c2", tool: "read", input: { path: "b.ts" } }),
      ]) applyEvent(ev);
      setSessions("p", [{ id: sessionId, projectId: "p", title: "Chat", status: "working", createdAt: 1, updatedAt: 1 }]);
      root.render(createElement(Timeline, { model: reduceSessionModel(sessionId, getState().events[sessionId] ?? []) }));
    });
    const live = [...host.querySelectorAll<HTMLElement>(".msg.assistant")]
      .find((row) => row.querySelector(".bubble")?.textContent === "Live interim.");
    assert.ok(live);
    assert.equal(live.querySelector(".chat-response-footer")?.hasAttribute("data-dormant"), true,
      "the followed interim answer reserves its footer's box, invisibly");
    assert.equal(live.querySelector(".chat-response-footer")?.getAttribute("data-actions-only"), "true");
    const closed = [...host.querySelectorAll<HTMLElement>(".msg.assistant")]
      .find((row) => row.querySelector(".bubble")?.textContent === "Before the tool.");
    assert.equal(closed?.querySelector(".chat-response-footer")?.hasAttribute("data-dormant"), true);

    // The live tail's own answer gets nothing yet: no row follows it.
    await act(async () => {
      for (const ev of [
        event("tool/result", { callId: "c2", tool: "read", output: "y" }),
        event("assistant/message", { partId: "a6", text: "Tail interim." }),
      ]) applyEvent(ev);
      root.render(createElement(Timeline, { model: reduceSessionModel(sessionId, getState().events[sessionId] ?? []) }));
    });
    const tail = [...host.querySelectorAll<HTMLElement>(".msg.assistant")]
      .find((row) => row.querySelector(".bubble")?.textContent === "Tail interim.");
    assert.ok(tail);
    assert.equal(tail.querySelector(".chat-response-footer") === null, true, "the tail answer has no footer while the turn runs");
  } finally {
    await act(async () => {
      activateSession(null);
      setSessions("p", []);
    });
    await act(async () => root.unmount());
    timeline.remove();
  }
});
