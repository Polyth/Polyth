// Mounted check: only a turn's last answer renders its footer (model identity
// and quick actions), also while its turn still works; an answer that tools,
// an answered question or more text of the same turn follow shows none.
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

test("only the last answer of a turn has a footer", async () => {
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
    for (const text of ["Answer one.", "Final."]) {
      const row = footer(text);
      assert.ok(row, `${text} has a footer`);
      assert.ok(row.querySelector(".chat-response-actions"), `${text} has quick actions`);
      assert.ok(row.querySelector(".chat-response-identity"), `${text} names its model`);
    }
    for (const text of ["Before the tool.", "Before the question."]) {
      assert.equal(footer(text) === null, true, `${text} has no footer`);
    }

    // A live turn: its latest answer has the footer, also with tools under it.
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
    assert.ok(live.querySelector(".chat-response-footer .chat-response-identity"), "the latest answer keeps its footer while tools run");

    // The live tail's finished answer has its footer too.
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
    assert.ok(tail.querySelector(".chat-response-footer .chat-response-identity"), "the tail answer keeps its footer while the turn runs");
    assert.equal(live.querySelector(".chat-response-footer") === null, true, "a later answer took the footer from the interim one");
  } finally {
    await act(async () => {
      activateSession(null);
      setSessions("p", []);
    });
    await act(async () => root.unmount());
    timeline.remove();
  }
});
