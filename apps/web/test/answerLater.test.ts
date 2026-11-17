// Answer later (docs/dev/ui.md "Answer later"): an open question folds into one
// waiting line above the composer, by hand (Later, Esc) or by itself when it
// arrives while the composer holds unsent text; Answer brings it back with the
// focus on its first control. Folding is tab-local UI state: the session's
// attention and its pending question stay as they were.
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
  Node: dom.Node,
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
register("./tsxHooks.mjs", import.meta.url);

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: QuestionPrompt } = await import("../src/components/QuestionCards.tsx");
const { default: AnswerLaterLine, waitingLabel } = await import("../src/components/AnswerLaterLine.tsx");
const later = await import("@polyth/web-sdk/answer-later");
const store = await import("../src/store.ts");

const SID = "s1";
store.setSessions("p1", [{
  id: SID, projectId: "p1", title: "Chat", status: "working", createdAt: 1, updatedAt: 1,
  attention: { questions: 1, permissions: 0, unread: 0 },
}] as never);

const question = (requestId: string) => ({
  kind: "question" as const, id: `question-${requestId}`, eventSeq: 1, requestId, status: "pending" as const, time: 1,
  questions: [{ id: "a", prompt: "Which audience?", type: "single", options: [
    { label: "Users", value: "users" }, { label: "Developers", value: "dev" },
  ] }],
});
const modelOf = (ids: string[]) => ({
  questions: ids.map((requestId) => ({ sessionId: SID, requestId, questions: [], status: "pending" as const, time: 1 })),
  permissions: [],
});

/** The timeline row and the pending stack, as the session view renders them. */
async function mount(ids: string[]) {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  const render = (next: string[]) => act(async () => root.render(h("div", null,
    h("div", { className: "timeline" }, ...next.map((id) => h(QuestionPrompt, { key: id, m: question(id) as never, sessionId: SID }))),
    h(AnswerLaterLine, { sessionId: SID, model: modelOf(next) as never }),
  )));
  await render(ids);
  const q = (selector: string) => container.querySelector(selector) as unknown as HTMLElement | null;
  return {
    q,
    count: (selector: string) => container.querySelectorAll(selector).length,
    render,
    settle: () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }),
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test.beforeEach(() => later.resetAnswerLater());

test("Later folds the question into one waiting line; Answer restores it with focus on its first control", async () => {
  const view = await mount(["q1"]);
  try {
    assert.ok(view.q(".question-open"), "the question shows");
    assert.equal(view.q(".answer-later"), null, "no waiting line while nothing waits");
    assert.equal(view.q(".question-later")?.textContent, "Later");
    assert.ok(view.q(".question-head .question-later"), "Later sits at the title's end, as on the approval card");
    assert.equal(view.q(".question-actions .question-later"), null, "never beside Submit");

    await act(async () => view.q(".question-later")!.click());
    assert.equal(view.q(".question-open"), null, "the card folds");
    assert.equal(view.q(".answer-later-count")?.textContent, "1 question waiting");
    assert.equal(view.q(".answer-later-action")?.textContent, "Answer");

    await act(async () => view.q(".answer-later-open")!.click());
    await view.settle();
    assert.ok(view.q(".question-open"), "the card is back");
    assert.equal(view.q(".answer-later"), null);
    assert.equal(dom.document.activeElement, view.q(".question-body input"), "focus on the first choice");
  } finally {
    await view.unmount();
  }
});

test("Esc inside the card folds it and hands the keyboard to the waiting line", async () => {
  const view = await mount(["q1"]);
  try {
    const first = view.q(".question-body input")!;
    first.focus();
    await act(async () => {
      first.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
    });
    await view.settle();
    assert.equal(view.q(".question-open"), null);
    assert.equal(dom.document.activeElement, view.q(".answer-later-open"), "Answer takes the focus");
  } finally {
    await view.unmount();
  }
});

test("a question that arrives under a draft arrives folded and opens once the draft is sent or cleared", async () => {
  const view = await mount([]);
  try {
    later.reportComposerDraft(SID, true);
    await view.render(["q1"]);
    await view.settle();
    assert.equal(view.q(".question-open"), null, "it never paints under the caret");
    assert.equal(view.q(".answer-later-count")?.textContent, "1 question waiting");

    // A second arrival under the same draft joins the line.
    await view.render(["q1", "q2"]);
    await view.settle();
    assert.equal(view.q(".answer-later-count")?.textContent, "2 questions waiting");

    await act(async () => later.reportComposerDraft(SID, false));
    assert.equal(view.q(".answer-later"), null);
    assert.equal(view.count(".question-open"), 2, "both auto-folded questions open again");
  } finally {
    await view.unmount();
  }
});

test("an item folded by hand stays folded when the draft is sent", async () => {
  const view = await mount(["q1"]);
  try {
    later.reportComposerDraft(SID, true);
    await act(async () => view.q(".question-later")!.click());
    await act(async () => later.reportComposerDraft(SID, false));
    assert.equal(view.q(".question-open"), null);
    assert.equal(view.q(".answer-later-count")?.textContent, "1 question waiting");
  } finally {
    await view.unmount();
  }
});

test("a question already on screen when typing starts never folds itself", async () => {
  const view = await mount(["q1"]);
  try {
    later.reportComposerDraft(SID, true);
    await view.render(["q1"]);
    await view.settle();
    assert.ok(view.q(".question-open"));
  } finally {
    await view.unmount();
  }
});

test("folding changes no attention count and no pending state", async () => {
  const before = JSON.stringify(store.getState().sessions.find((s) => s.id === SID)?.attention);
  const view = await mount(["q1"]);
  try {
    await act(async () => view.q(".question-later")!.click());
    assert.equal(JSON.stringify(store.getState().sessions.find((s) => s.id === SID)?.attention), before);
    assert.equal(later.isDeferred(later.answerLaterKey("question", SID, "q1")), true);
  } finally {
    await view.unmount();
  }
});

test("the waiting line names counts and kinds in plain words", () => {
  assert.equal(waitingLabel(1, 0), "1 question waiting");
  assert.equal(waitingLabel(3, 0), "3 questions waiting");
  assert.equal(waitingLabel(0, 1), "1 approval waiting");
  assert.equal(waitingLabel(1, 2), "1 question and 2 approvals waiting");
});

test("the composer reports its draft to Answer later", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  assert.match(source, /reportComposerDraft\(answerLaterSessionId, hasDraft\)/);
  const surfaces = readFileSync(new URL("../src/components/workspace/builtinSurfaces.tsx", import.meta.url), "utf8");
  assert.match(surfaces, /<AnswerLaterLine sessionId=\{sessionId\} model=\{model\} \/>/);
});
