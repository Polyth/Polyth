import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import type { SessionEvent } from "@polyth/contracts";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document });
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CompactionMarker, CompactionProgress } = await import("../widgets/runtime.tsx");
const { compactionRequestState, COMPACTION_PENDING_MAX_MS } = await import("../widgets/compactionProgress.ts");
const { compactionContext, compactionHandoffDraft, COMPACTION_MESSAGE_CHARS, COMPACTION_RECENT_MESSAGES } = await import("../widgets/compactionHandoff.ts");
const { en } = await import("../src/i18n/en.ts");

let seq = 0;
const ev = (type: string, data: Record<string, unknown>): SessionEvent =>
  ({ id: `e${++seq}`, sessionId: "source-1", seq, time: Date.UTC(2026, 9, 7, 9, 0, seq), type, data, v: 1 }) as SessionEvent;

const history = (summary?: string) => {
  seq = 0;
  const events = [
    ev("user/message", { text: "Plan the migration" }),
    ev("assistant/message", { partId: "a1", text: "Here is the plan." }),
    ev("user/message", { text: "hidden resolver prompt", hiddenUserMessage: true }),
    ev("user/message", { text: "Ship step one" }),
    ev("assistant/message", { partId: "a2", text: "Step one shipped." }),
  ];
  events.push(ev("context/pinned", { sourceEventSeq: 2 }));
  const compaction = ev("session/compacted", { backendEventId: "t:step:9", ...(summary ? { summary } : {}) });
  events.push(compaction, ev("user/message", { text: "after the compaction" }));
  return { events, compaction };
};

const translate = (key: string, values?: Record<string, string | number>) =>
  ((en as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? `{${name}}`));

test("the carried context stops at the marker and skips hidden prompts", () => {
  const { events, compaction } = history("# Summary\nThe migration plan is agreed.");
  const context = compactionContext(events, compaction);
  assert.equal(context.summary, "# Summary\nThe migration plan is agreed.");
  assert.deepEqual(context.recent.map((message) => message.text), ["Plan the migration", "Here is the plan.", "Ship step one", "Step one shipped."]);
  assert.deepEqual(context.pinned, [{ role: "assistant", text: "Here is the plan." }]);
  // A partially paged log only shortens the excerpt.
  assert.deepEqual(compactionContext(events.slice(3), compaction).recent.map((message) => message.text), ["Ship step one", "Step one shipped."]);
});

test("recent excerpts are bounded in count and length", () => {
  seq = 0;
  const events = Array.from({ length: COMPACTION_RECENT_MESSAGES + 4 }, (_, index) =>
    ev("user/message", { text: index === COMPACTION_RECENT_MESSAGES + 3 ? "x".repeat(COMPACTION_MESSAGE_CHARS * 2) : `m${index}` }));
  const compaction = ev("session/compacted", {});
  const context = compactionContext(events, compaction);
  assert.equal(context.summary, undefined);
  assert.equal(context.recent.length, COMPACTION_RECENT_MESSAGES);
  assert.equal(context.recent.at(-1)!.text.length, COMPACTION_MESSAGE_CHARS);
  assert.ok(context.recent.at(-1)!.text.endsWith("…"));
});

test("the handoff draft names its source and omits empty sections", () => {
  const labels = { intro: "INTRO", summary: "Summary", pinned: "Pinned", recent: "Recent", user: "User", assistant: "Assistant" };
  assert.equal(compactionHandoffDraft({ pinned: [], recent: [] }, labels), "INTRO\n\n");
  const draft = compactionHandoffDraft({ summary: "S", pinned: [], recent: [{ role: "user", text: "hi" }] }, labels);
  assert.equal(draft, "INTRO\n\n## Summary\n\nS\n\n## Recent\n\n**User:** hi\n\n");
});

const mount = (summary?: string) => {
  const { events, compaction } = history(summary);
  const started: Array<{ projectId: string; seed: { title?: string; draft?: string } | undefined }> = [];
  const host = {
    ui: {
      locale: { get: () => "en", translate },
      components: { MarkdownDoc: ({ text }: { text: string }) => createElement("div", { className: "markdown-stub" }, text) },
    },
    sessions: {
      events: () => events,
      get: () => ({ id: "source-1", projectId: "project-1", title: "Migration" }),
    },
    conversation: { startNewSession: (projectId: string, seed?: { title?: string; draft?: string }) => started.push({ projectId, seed }) },
  } as never;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container as never);
  act(() => root.render(createElement(CompactionMarker, { event: compaction, host, sessionId: "source-1", projectId: "project-1" })));
  const toggle = () => container.querySelector<HTMLButtonElement>(".pkg-harnesses-compaction-toggle")!;
  return { container, root, started, toggle };
};

test("the marker expands to the harness summary and starts a new chat from it", () => {
  const { container, root, started, toggle } = mount("The migration plan is agreed.");
  try {
    assert.equal(toggle().getAttribute("aria-expanded"), "false");
    assert.equal(container.querySelector(".pkg-harnesses-compaction-body"), null, "the collapsed marker mounts no body");
    assert.doesNotMatch(container.textContent ?? "", /migration plan is agreed/);

    act(() => toggle().click());
    assert.equal(toggle().getAttribute("aria-expanded"), "true");
    const body = container.querySelector(".pkg-harnesses-compaction-body")!;
    assert.equal(toggle().getAttribute("aria-controls"), body.id);
    assert.equal(body.querySelector(".markdown-stub")?.textContent, "The migration plan is agreed.");
    assert.deepEqual([...body.querySelectorAll(".pkg-harnesses-compaction-excerpt")].map((node) => node.textContent),
      ["Plan the migration", "Here is the plan.", "Ship step one", "Step one shipped."]);
    assert.doesNotMatch(body.textContent ?? "", /after the compaction|hidden resolver prompt/);

    const action = [...body.querySelectorAll("button")].find((button) => button.textContent?.includes(en["harnessruntime.compaction.startNewChat"]))!;
    act(() => action.click());
    assert.equal(started.length, 1);
    assert.equal(started[0]!.projectId, "project-1");
    assert.equal(started[0]!.seed?.title, "Migration (continued)");
    const draft = started[0]!.seed?.draft ?? "";
    assert.match(draft, /^Continue the work from the chat “Migration” \(Polyth session source-1\)/);
    assert.match(draft, /## Summary\n\nThe migration plan is agreed\./);
    assert.match(draft, /## Pinned context\n\n\*\*Assistant:\*\* Here is the plan\./);
    assert.match(draft, /\*\*User:\*\* Ship step one/);
    assert.doesNotMatch(draft, /after the compaction/);

    act(() => toggle().click());
    assert.equal(container.querySelector(".pkg-harnesses-compaction-body"), null);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test("without a native summary the marker says so and still offers a new chat", () => {
  const { container, root, started, toggle } = mount();
  try {
    act(() => toggle().click());
    assert.equal(container.querySelector(".markdown-stub"), null);
    assert.equal(container.querySelector(".pkg-harnesses-compaction-note")?.textContent, en["harnessruntime.compaction.noSummary"]);
    const action = container.querySelector<HTMLButtonElement>(".pkg-harnesses-compaction-actions button")!;
    act(() => action.click());
    assert.doesNotMatch(started[0]!.seed?.draft ?? "", /## Summary/);
    assert.match(started[0]!.seed?.draft ?? "", /## Before the compaction/);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test("a compaction request is pending until its marker, failure, or the next turn", () => {
  seq = 0;
  const request = ev("session/compaction-requested", { strategy: "fresh-runtime-leg" });
  const now = request.time + 1_000;
  assert.deepEqual(compactionRequestState([request], request, now), { kind: "pending" });
  assert.deepEqual(compactionRequestState([request], request, request.time + COMPACTION_PENDING_MAX_MS), { kind: "settled" });
  assert.deepEqual(compactionRequestState([request, ev("session/compacted", { summary: "S" })], request, now), { kind: "settled" });
  assert.deepEqual(compactionRequestState([request, ev("user/message", { text: "next" })], request, now), { kind: "settled" });
  assert.deepEqual(
    compactionRequestState([request, ev("session/compaction-failed", { strategy: "fresh-runtime-leg", error: "rate limited" })], request, now),
    { kind: "failed", error: "rate limited" },
  );
  // A native refusal is answered by the request itself.
  assert.deepEqual(
    compactionRequestState([request, ev("session/compaction-failed", { strategy: "native", error: "nope" })], request, now),
    { kind: "settled" },
  );
});

test("the progress row follows the log from compacting to failed to gone", () => {
  seq = 0;
  const request = { ...ev("session/compaction-requested", { strategy: "fresh-runtime-leg" }), time: Date.now() };
  let events: SessionEvent[] = [request];
  const listeners = new Set<() => void>();
  const host = {
    ui: { locale: { get: () => "en", translate } },
    sessions: {
      events: () => events,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
  } as never;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container as never);
  const push = (event: SessionEvent) => act(() => { events = [...events, event]; listeners.forEach((listener) => listener()); });
  try {
    act(() => root.render(createElement(CompactionProgress, { event: request, host, sessionId: "source-1" })));
    const row = () => container.querySelector(".pkg-harnesses-compaction-progress");
    assert.equal(row()?.getAttribute("data-state"), "pending");
    assert.equal(row()?.getAttribute("role"), "status");
    assert.match(row()?.textContent ?? "", new RegExp(en["harnessruntime.compaction.pendingHeading"]));

    push(ev("session/compaction-failed", { strategy: "fresh-runtime-leg", error: "provider rate limit reached" }));
    assert.equal(row()?.getAttribute("data-state"), "failed");
    assert.match(row()?.textContent ?? "", /provider rate limit reached/);
    assert.match(row()?.textContent ?? "", new RegExp(en["harnessruntime.compaction.failedDescription"]));

    push(ev("user/message", { text: "moving on" }));
    assert.equal(row() === null, true, "a settled request renders nothing");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
