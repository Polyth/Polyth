// Mounted render tests for the opt-in progress bar and sub-agent panel.
import test, { after, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";

register("./tsxHooks.mjs", import.meta.url);
const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node });
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
after(async () => { await dom.happyDOM.close(); });
afterEach(() => mock.timers.reset());
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SessionProgressBar, SubagentPanel } = await import("../widgets/SessionProgress.tsx");

const NOW = Date.UTC(2026, 9, 9, 10, 0, 0);
let seq = 0;
const ev = (sessionId: string, type: string, time: number, data: Record<string, unknown>) =>
  ({ id: `e${++seq}`, sessionId, seq, time, type, data, v: 1 }) as SessionEvent;
const list = (sessionId: string, statuses: string[], startedAt = NOW - 754_000) => [
  ev(sessionId, "task/snapshot", startedAt, { listId: "todo", revision: 1, items: statuses.map((_, i) => ({ id: `t${i}`, text: `Step ${i + 1}`, status: "pending" })) }),
  ev(sessionId, "task/snapshot", NOW - 30_000, { listId: "todo", revision: 2, items: statuses.map((status, i) => ({ id: `t${i}`, text: `Step ${i + 1}`, status })) }),
];

const events = new Map<string, SessionEvent[]>([
  ["empty", []],
  ["seven", list("seven", ["completed", "completed", "completed", "in_progress", "cancelled", "pending", "pending"])],
  ["forty", list("forty", Array.from({ length: 40 }, (_, i) => (i < 23 ? "completed" : i === 23 ? "in_progress" : "pending")))],
  ["done", list("done", ["completed", "completed"])],
  ["agents", [ev("agents", "subagent/snapshot", NOW, { revision: 1, agents: [
    { sessionId: "c1", label: "Usage QA", status: "running", currentTask: "Screenshot the matrix" },
    { sessionId: "c2", label: "Todos QA", status: "running" },
    { sessionId: "c3", label: "Browser QA", status: "failed" },
    { sessionId: "c4", label: "Files QA", status: "completed" },
    { sessionId: "c6", label: "Explore", status: "waiting" },
  ] })]],
  ["c1", [ev("c1", "subagent/snapshot", NOW, { revision: 1, agents: [{ sessionId: "c5", label: "Nested reviewer", status: "running" }] })]],
]);
const projections = new Map<string, Partial<SessionProjection>>([
  ["c1", { status: "working", tokenTotals: { input: 182_000, output: 21_400 } as SessionProjection["tokenTotals"], costTotal: 1.84 }],
  ["c2", { status: "idle", tokenTotals: { input: 64_000, output: 9_000 } as SessionProjection["tokenTotals"], costTotal: 0.42 }],
  ["c3", { status: "failed", tokenTotals: { input: 12_000, output: 600 } as SessionProjection["tokenTotals"], costTotal: 0.004 }],
  ["c4", { status: "finished", tokenTotals: { input: 2_400_000, output: 130_000 } as SessionProjection["tokenTotals"], costTotal: 12.5 }],
  ["c5", { status: "working" }],
  ["c6", { status: "idle" }],
]);

let locale = "en";
const opened: string[] = [];
const host = {
  ui: { locale: { get: () => locale, translate: (key: string) => key } },
  sessions: {
    subscribe: () => () => {},
    events: (id: string) => events.get(id) ?? [],
    get: (id: string) => projections.get(id) as SessionProjection | undefined,
  },
  conversation: { openSession: async (id: string) => { opened.push(id); } },
} as never;

async function mount(component: typeof SessionProgressBar, sessionId: string | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(component, { host, sessionId })));
  return { container, dispose: async () => { await act(async () => root.unmount()); container.remove(); } };
}

const text = (node: Node | null | undefined): string => {
  if (!node) return "";
  const parts: string[] = [];
  const walk = (child: Node) => { if (child.nodeType === 3) parts.push(child.textContent ?? ""); else child.childNodes.forEach(walk); };
  walk(node);
  return parts.map((part) => part.trim()).filter(Boolean).join(" ");
};

test("progress empty and no-session states use the shared empty state inside the package root", async () => {
  for (const [sessionId, title, hint] of [
    ["empty", "No todo list yet", "Steps appear here when the agent plans its work."],
    [null, "No session selected", "Choose a session to see its progress."],
  ] as const) {
    const view = await mount(SessionProgressBar, sessionId);
    try {
      assert.ok(view.container.querySelector(".todos-widget > .todos-widget__empty .empty-state.empty-state--compact"));
      assert.equal(text(view.container.querySelector(".empty-state-title")), title);
      assert.equal(text(view.container.querySelector(".empty-state-desc")), hint);
      assert.equal(view.container.querySelector('[role="progressbar"]'), null);
    } finally {
      await view.dispose();
    }
  }
});

test("a seven-step list reports counts, failures, elapsed time and the current step", async () => {
  mock.timers.enable({ apis: ["Date", "setInterval"], now: NOW });
  const view = await mount(SessionProgressBar, "seven");
  try {
    const bar = view.container.querySelector('[role="progressbar"]')!;
    assert.equal(bar.getAttribute("aria-valuenow"), "3");
    assert.equal(bar.getAttribute("aria-valuemax"), "7");
    assert.equal(bar.getAttribute("aria-label"), "Task progress: 3 of 7 completed");
    assert.equal(view.container.querySelector<HTMLElement>(".todos-progress__fill")?.style.width, "43%");
    assert.equal(text(view.container.querySelector(".todos-progress__count")), "3/7");
    assert.equal(text(view.container.querySelector(".todos-progress__failed")), "1 failed");
    assert.equal(text(view.container.querySelector(".todos-progress__elapsed")), "Elapsed 12 min 34 sec");
    const current = view.container.querySelector(".todos-progress__current")!;
    assert.equal(current.getAttribute("aria-live"), "polite");
    assert.equal(text(current), "Now Step 4");
    // Agent text keeps its own direction inside an RTL layout.
    assert.equal(current.querySelector("bdi.todos-progress__text")?.textContent, "Step 4");
    await act(async () => { mock.timers.tick(1_000); });
    assert.equal(text(view.container.querySelector(".todos-progress__elapsed")), "Elapsed 12 min 35 sec");
  } finally {
    await view.dispose();
  }
});

test("a forty-step list and a finished list", async () => {
  mock.timers.enable({ apis: ["Date", "setInterval"], now: NOW });
  const forty = await mount(SessionProgressBar, "forty");
  const done = await mount(SessionProgressBar, "done");
  try {
    assert.equal(text(forty.container.querySelector(".todos-progress__count")), "23/40");
    assert.equal(text(forty.container.querySelector(".todos-progress__current bdi")), "Step 24");
    assert.equal(done.container.querySelector(".todos-progress")?.getAttribute("data-settled"), "true");
    assert.equal(text(done.container.querySelector(".todos-progress__current")), "All steps finished");
    // Settled lists freeze their span at the last snapshot.
    assert.equal(text(done.container.querySelector(".todos-progress__elapsed")), "Elapsed 12 min 4 sec");
  } finally {
    await forty.dispose();
    await done.dispose();
  }
});

test("progress copy and numbers follow the host locale", async () => {
  mock.timers.enable({ apis: ["Date", "setInterval"], now: NOW });
  locale = "uk";
  const uk = await mount(SessionProgressBar, "seven");
  locale = "ar";
  const ar = await mount(SessionProgressBar, "seven");
  locale = "en";
  try {
    assert.equal(text(uk.container.querySelector(".todos-progress__failed")), "Не вдалося: 1");
    assert.equal(text(uk.container.querySelector(".todos-progress__elapsed")), "Минуло 12 хв 34 с");
    assert.equal(text(ar.container.querySelector(".todos-progress__now")), "الآن");
  } finally {
    await uk.dispose();
    await ar.dispose();
  }
});

test("the sub-agent panel: empty, states, nesting, partial totals and opening a child", async () => {
  const empty = await mount(SubagentPanel, "empty");
  const panel = await mount(SubagentPanel, "agents");
  try {
    assert.equal(text(empty.container.querySelector(".empty-state-title")), "No sub-agents");
    const rows = [...panel.container.querySelectorAll<HTMLElement>(".todos-agents__row")];
    assert.deepEqual(rows.map((row) => row.dataset.state), ["running", "running", "idle", "failed", "done", "idle"]);
    assert.equal(rows[1]!.style.getPropertyValue("--todos-depth"), "1");
    assert.equal(text(panel.container.querySelector(".todos-agents__head > span")), "2 running of 6");
    assert.equal(text(panel.container.querySelector(".todos-agents__total")), "2.8M tokens · $14.76");
    assert.match(text(panel.container.querySelector(".todos-agents__note")), /totals may be incomplete/);
    const failed = rows[3]!.querySelector("button")!;
    // The visible content names the button; no aria-label hides state and usage.
    assert.equal(failed.hasAttribute("aria-label"), false);
    assert.equal(text(failed), "Browser QA Failed 13K · <$0.01");
    assert.equal(failed.title, "Open session Browser QA");
    await act(async () => failed.click());
    assert.deepEqual(opened, ["c3"]);
  } finally {
    await empty.dispose();
    await panel.dispose();
  }
});

test("a clipped sub-agent list fades its tail and clears the fade at the end", async () => {
  const panel = await mount(SubagentPanel, "agents");
  try {
    const root = panel.container.querySelector<HTMLElement>(".todos-widget")!;
    const scroll = async (top: number) => {
      Object.defineProperty(root, "scrollHeight", { configurable: true, value: 500 });
      Object.defineProperty(root, "clientHeight", { configurable: true, value: 300 });
      Object.defineProperty(root, "scrollTop", { configurable: true, value: top });
      await act(async () => { root.dispatchEvent(new dom.Event("scroll") as unknown as Event); });
    };
    await scroll(0);
    assert.equal(root.getAttribute("data-more"), "true");
    await scroll(200);
    assert.equal(root.hasAttribute("data-more"), false);
  } finally {
    await panel.dispose();
  }
});
