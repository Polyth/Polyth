// The streaming cursor means "this turn is producing output". A chunk-only
// answer of a failed or stopped turn never finalizes, so it must not keep the
// cursor: not after the stop, and not once the next turn starts working.
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
const { default: Timeline, ActivityGroupView } = await import("../src/components/Timeline.tsx");
const { activityGroup } = await import("../src/utils.ts");
const { emptyModel, reduceEvent, showsStreamingCaret } = await import("../src/reduce.ts");
const { activateProject, activateSession, applyEvent, getState, reduceSessionModel, setSessions } = await import("../src/store.ts");

let seq = 0;
const events = (sessionId: string) => (type: string, data: JsonObject): SessionEvent => {
  seq += 1;
  return { id: `ev-${seq}`, sessionId, seq, time: Date.UTC(2026, 9, 14, 9, 0, seq), type, data, v: 1 };
};

for (const [reason, status] of [["error", "failed"], ["aborted", "aborted"], ["completed", "stopped"]] as const) {
  test(`a partial answer shows the cursor only while its turn works (${reason})`, () => {
    const event = events("caret-model");
    const model = emptyModel();
    for (const ev of [
      event("user/message", { text: "Go." }),
      event("turn/started", { turnId: "t1" }),
      event("assistant/chunk", { partId: "a1", text: "Partial" }),
    ]) reduceEvent(model, ev);
    const answer = model.messages.find((m) => m.kind === "assistant");
    assert.ok(answer?.kind === "assistant");
    const caret = () => showsStreamingCaret(answer, model.turn?.status === "working");
    assert.equal(caret(), true);

    reduceEvent(model, event("turn/stopped", { turnId: "t1", reason }));
    assert.equal(model.turn?.status, status);
    assert.equal(answer.finalized, false, "a stop does not complete the answer");
    assert.equal(caret(), false);
  });
}

async function mounted(sessionId: string, run: (
  apply: (...list: Array<[string, JsonObject]>) => Promise<void>,
  carets: () => string[],
) => Promise<void>): Promise<void> {
  const event = events(sessionId);
  const timeline = document.createElement("div");
  timeline.className = "timeline";
  const host = document.createElement("div");
  timeline.appendChild(host);
  document.body.appendChild(timeline);
  const root = createRoot(host);
  const apply = async (...list: Array<[string, JsonObject]>) => {
    await act(async () => {
      for (const [type, data] of list) applyEvent(event(type, data));
      root.render(createElement(Timeline, { model: reduceSessionModel(sessionId, getState().events[sessionId] ?? []) }));
    });
  };
  /** The text of every bubble that currently carries the cursor. */
  const carets = () => [...host.querySelectorAll(".caret")]
    .map((caret) => caret.closest(".bubble")?.textContent?.trim() ?? "");
  try {
    await act(async () => {
      activateProject("p");
      setSessions("p", [{ id: sessionId, projectId: "p", title: "Chat", status: "working", createdAt: 1, updatedAt: 1 }]);
      activateSession(sessionId);
    });
    await run(apply, carets);
  } finally {
    await act(async () => {
      activateSession(null);
      setSessions("p", []);
    });
    await act(async () => root.unmount());
    timeline.remove();
  }
}

test("the answer row drops the cursor when its turn fails and stays without it in the next turn", async () => {
  await mounted("caret-row", async (apply, carets) => {
    await apply(
      ["user/message", { text: "First." }],
      ["turn/started", { turnId: "t1" }],
      ["assistant/chunk", { partId: "a1", text: "Half an answer" }],
    );
    assert.deepEqual(carets(), ["Half an answer"]);

    await apply(["turn/stopped", { turnId: "t1", reason: "error", error: "ACP rejected the prompt" }]);
    assert.deepEqual(carets(), []);

    await apply(["user/message", { text: "Again." }], ["turn/started", { turnId: "t2" }]);
    assert.deepEqual(carets(), [], "the new turn has produced nothing yet");

    await apply(["assistant/chunk", { partId: "a2", text: "New answer" }]);
    assert.deepEqual(carets(), ["New answer"]);
  });
});

// groupActivity currently surfaces answer text as its own row, so the group's
// prose renderer is mounted directly.
test("prose inside an activity group follows the same cursor rule", async () => {
  const event = events("caret-activity");
  const model = emptyModel();
  for (const ev of [
    event("user/message", { text: "Look." }),
    event("turn/started", { turnId: "t1" }),
    event("tool/call", { callId: "c1", tool: "read", input: { path: "a.ts" } }),
    event("tool/result", { callId: "c1", tool: "read", output: "x" }),
    event("assistant/chunk", { partId: "a1", text: "Reading further" }),
  ]) reduceEvent(model, ev);
  const group = activityGroup("group", model.messages.filter((m) => m.kind === "tool" || m.kind === "assistant"));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = async () => {
    await act(async () => {
      root.render(createElement(ActivityGroupView, {
        g: group, subagents: null, ticking: model.turn?.status === "working",
      }));
    });
  };
  try {
    await render();
    await act(async () => { host.querySelector<HTMLElement>(".ui-run-summary")!.click(); });
    const prose = () => host.querySelector(".activity-group-items .msg.assistant");
    assert.equal(prose()?.textContent, "Reading further");
    assert.equal(prose()!.querySelectorAll(".caret").length, 1);

    reduceEvent(model, event("turn/stopped", { turnId: "t1", reason: "error" }));
    await render();
    assert.equal(prose()?.textContent, "Reading further");
    assert.equal(prose()!.querySelectorAll(".caret").length, 0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
