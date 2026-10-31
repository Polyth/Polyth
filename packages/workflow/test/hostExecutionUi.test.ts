// A workflow card sits at its run's place in the transcript, and later prompts
// read below it. Moved out of apps/web/test/executionUi.test.ts (with the
// minimal store → reduce → Timeline harness it needs) so the host test no
// longer names the removable package.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import type { JsonObject } from "@polyth/contracts";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  location: dom.location,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  getComputedStyle: dom.getComputedStyle,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Timeline } = await import("../../../apps/web/src/components/Timeline.tsx");
// The workflow timeline card is contributed by its own package through the
// generic `session.timeline.event` slot.
const { webPackageHost } = await import("../../../apps/web/src/packages/webHost.ts");
const { default: installWorkflowWidgets } = await import("../widgets/index.tsx");
installWorkflowWidgets(webPackageHost)();
const {
  activateProject,
  activateSession,
  applyEvent,
  getState,
  setSessions,
  reduceSessionModel,
} = await import("../../../apps/web/src/store.ts");

/** Minimal timeline shell for activity ordering and scheduling tests. */
const activityTimelineHost = () => {
  const viewport = document.createElement("div");
  viewport.className = "timeline-viewport";
  const timeline = document.createElement("div");
  timeline.className = "timeline";
  const host = document.createElement("div");
  timeline.appendChild(host);
  viewport.append(timeline);
  document.body.appendChild(viewport);
  return { viewport, timeline, host };
};

/** Full store → reduce → Timeline mount: the reproducer shape behind the
 *  reported bug. Uses the same projection path as the running app. */
let timelineHostSeq = 0;
const timelineHost = () => {
  const sessionId = `activity-status-${++timelineHostSeq}`;
  const { viewport, host } = activityTimelineHost();
  const root = createRoot(host);
  const event = (seq: number, type: string, data: JsonObject, time = seq) => ({
    id: `ev-${sessionId}-${seq}`,
    sessionId,
    seq,
    time,
    type,
    data,
    v: 1 as const,
  });
  return {
    event,
    host,
    async render(events: ReturnType<typeof event>[]) {
      await act(async () => {
        activateProject("activity-status-test");
        setSessions("activity-status-test", [{
          id: sessionId,
          projectId: "activity-status-test",
          title: "Activity status",
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
        }]);
        activateSession(sessionId);
        for (const ev of events) applyEvent(ev);
        root.render(createElement(Timeline, { model: reduceSessionModel(sessionId, getState().events[sessionId] ?? []) }));
      });
    },
    async cleanup() {
      await act(async () => {
        activateSession(null);
        setSessions("activity-status-test", []);
      });
      await act(async () => root.unmount());
      viewport.remove();
    },
  };
};

test("a workflow card sits at its run's place and later prompts read below it", async () => {
  const t = timelineHost();
  try {
    await t.render([
      t.event(1, "user/message", { text: "Plan the change" }),
      t.event(2, "assistant/message", { partId: "a1", text: "Planned." }),
      t.event(3, "workflow/run-started", {
        runId: "run-1", workflowId: "review", name: "Review", input: "Review the plan",
        layers: [["review"]], nodes: [{ id: "review", role: "Reviewer", status: "done" }],
      }),
      t.event(4, "workflow/run-completed", { runId: "run-1", status: "done", result: "No blocking issues." }),
    ]);
    const order = () => [...t.host.querySelectorAll<HTMLElement>(".workflow-timeline-card, .msg.user, .msg.assistant")]
      .map((element) => element.classList.contains("workflow-timeline-card")
        ? "card"
        : element.classList.contains("user") ? `user:${element.textContent?.includes("Apply") ? "follow-up" : "first"}` : "assistant");
    assert.deepEqual(order(), ["user:first", "assistant", "card"]);
    assert.equal(t.host.querySelector(".workflow-timeline-card")?.textContent?.includes("Continue in chat"), false,
      "the parent agent already has the result; no composer hand-off");

    await t.render([
      t.event(5, "user/message", { text: "Apply the review" }),
      t.event(6, "assistant/message", { partId: "a2", text: "Applied." }),
    ]);
    assert.deepEqual(order(), ["user:first", "assistant", "card", "user:follow-up", "assistant"]);
  } finally {
    await t.cleanup();
  }
});
