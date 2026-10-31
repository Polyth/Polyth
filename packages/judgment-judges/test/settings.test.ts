import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionEvent } from "@polyth/contracts";
import type { BacktestResult, JudgeDefinition, JudgesSnapshot } from "../src/types.ts";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, localStorage: dom.localStorage,
  getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), ResizeObserver: dom.ResizeObserver });
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("../../models/test/tsxHooks.mjs", import.meta.url);
let handleFetch: (path: string, init?: RequestInit) => Promise<Response> = async () => { throw new Error("Unexpected request"); };
globalThis.fetch = (input, init) => handleFetch(String(input), init);
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: JudgesSettings } = await import("../widgets/JudgesSettings.tsx");
const { default: AssessmentMarker } = await import("../widgets/AssessmentMarker.tsx");
const { default: RequestVerdicts } = await import("../widgets/RequestVerdict.tsx");
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const saved: JudgeDefinition = { id: "j0123456789ab", name: "Scope creep", enabled: true, trigger: "turn-completed", filters: {},
  evidence: [{ pick: "changed-files", maxChars: 600 }], question: { type: "noul", text: "Did it touch unrelated files?" },
  fire: { threshold: 0.7, margin: 0.2 }, effects: [{ kind: "timeline-marker" }], dailyCap: 40, createdAt: 1, updatedAt: 1 };
const snapshot = (judges: JudgeDefinition[] = [saved], revision = 3): JudgesSnapshot =>
  ({ revision, judges, usage: { [saved.id]: { day: "2026-10-11", count: 4 } }, judgmentAvailable: true });
const button = (root: ParentNode, text: string) => [...root.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === text) as HTMLButtonElement | undefined;
function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof dom.HTMLTextAreaElement ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
}

async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); await pause(); });
  return { container, async unmount() { await act(async () => root.unmount()); container.remove(); } };
}

test("the Judges page lists, toggles, edits and backtests through package routes only", async () => {
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  let state = snapshot();
  handleFetch = async (path, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, method: init?.method ?? "GET", body });
    if (path.includes("/backtest")) return json({ judgeId: saved.id, usage: { day: "2026-10-11", count: 6 }, rows: [
      { sessionId: "s1", title: "Composer padding", turnSeq: 8, label: "yes", probability: 0.91, wouldFire: true },
      { sessionId: "s2", title: "", turnSeq: 4, wouldFire: false, skipped: "cap" },
    ] } satisfies BacktestResult);
    if (init?.method === "PUT") state = { ...state, revision: state.revision + 1, judges: [{ ...saved, ...body.judge }] };
    return json(state);
  };
  let opened = 0;
  const view = await mount(createElement(JudgesSettings, { projectId: "p1", openJudgment: () => { opened++; } }));
  try {
    const text = view.container.textContent ?? "";
    assert.match(text, /Settings → Judgment → Uses/);
    assert.match(text, /Scope creep/); assert.match(text, /4 \/ 40 today/);
    await act(async () => { button(view.container, "Open Judgment")!.click(); await pause(); });
    assert.equal(opened, 1);

    const toggle = view.container.querySelector('.judges-item [role="switch"]') as HTMLButtonElement;
    await act(async () => { toggle.click(); await pause(); });
    assert.deepEqual({ path: calls.at(-1)!.path, revision: calls.at(-1)!.body.revision, enabled: calls.at(-1)!.body.judge.enabled },
      { path: `/api/judges/${saved.id}?projectId=p1`, revision: 3, enabled: false });
    assert.equal(calls.at(-1)!.body.judge.id, undefined, "server-owned fields are not sent back");

    await act(async () => { button(view.container, "Edit")!.click(); await pause(); });
    const name = view.container.querySelector(".judges-editor input") as HTMLInputElement;
    assert.equal(name.value, "Scope creep");
    await act(async () => { type(name, "Unrelated edits"); await pause(); });
    await act(async () => { button(view.container, "Save judge")!.click(); await pause(); });
    assert.equal(calls.at(-1)!.method, "PUT"); assert.equal(calls.at(-1)!.body.revision, 4);
    assert.equal(calls.at(-1)!.body.judge.name, "Unrelated edits");
    assert.equal(view.container.querySelector(".judges-editor"), null, "the editor closes after saving");

    await act(async () => { button(view.container, "Backtest")!.click(); await pause(); });
    assert.equal(calls.at(-1)!.path, `/api/judges/${saved.id}/backtest?projectId=p1`); assert.deepEqual(calls.at(-1)!.body, { limit: 10 });
    const rows = [...view.container.querySelectorAll(".judges-table tbody tr")];
    assert.equal(rows.length, 2);
    assert.match(rows[0]!.textContent ?? "", /Composer padding.*Yes.*91%.*Would fire/);
    assert.match(rows[1]!.textContent ?? "", /Untitled chat.*Daily limit reached/);
    assert.match(view.container.textContent ?? "", /Would fire on 1 of 2 turns \(1 without an answer\)\. Nothing was recorded or done\./);
    assert.match(view.container.textContent ?? "", /6 \/ 40 today/, "backtest usage updates the count");
    assert.ok(calls.every((call) => call.path.startsWith("/api/judges")));
  } finally { await view.unmount(); }
});

test("a new judge is validated before sending; delete asks first", async () => {
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  let state = snapshot([]);
  handleFetch = async (path, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, method: init?.method ?? "GET", body });
    if (init?.method === "POST") state = { ...state, revision: 4, judges: [{ ...saved, ...body.judge }] };
    if (init?.method === "DELETE") state = { ...state, revision: 5, judges: [] };
    return json(state);
  };
  const confirms: string[] = [];
  let answer = false;
  const view = await mount(createElement(JudgesSettings, { projectId: "p1", openJudgment() {}, confirm: async (text: string) => { confirms.push(text); return answer; } }));
  try {
    assert.match(view.container.textContent ?? "", /No judges yet/);
    await act(async () => { button(view.container, "Add judge")!.click(); await pause(); });
    await act(async () => { button(view.container, "Add judge")!.click(); await pause(); });
    assert.match(view.container.querySelector('.judges-editor [role="alert"]')?.textContent ?? "", /Name must be/);
    const effects = view.container.querySelector(".judges-safe")?.closest("fieldset");
    assert.match(effects?.textContent ?? "", /Markers only change what you see/);
    assert.deepEqual([...effects!.querySelectorAll("label")].map((label) => label.textContent?.match(/^(Mark the chat|Flag it for me|Offer a follow-up)/)?.[0]),
      ["Mark the chat", "Flag it for me", "Offer a follow-up"], "the editor offers exactly the display allowlist");
    // Actions are a separate, opt-in section that says whose access they use.
    const acting = view.container.querySelector(".judges-act");
    assert.match(acting?.textContent ?? "", /Actions use your access/);
    assert.deepEqual([...acting!.querySelectorAll(".ui-checkbox-label")].map((label) => label.textContent),
      ["Send a message", "Merge the isolated work", "Change Auto-Approve"], "a turn judge offers exactly its action allowlist");
    assert.ok([...acting!.querySelectorAll("input")].every((input) => !(input as HTMLInputElement).checked), "no action is on by default");
    assert.equal(calls.filter((call) => !call.path.startsWith("/api/judges/routes")).length, 1, "an invalid judge is not sent");
    const [name] = view.container.querySelectorAll(".judges-editor input") as NodeListOf<HTMLInputElement>;
    await act(async () => { type(name!, "Waiting on me"); await pause(); });
    await act(async () => { type(view.container.querySelector(".judges-editor textarea") as HTMLTextAreaElement, "Is a decision needed?"); await pause(); });
    // Switching to a choice question offers answers and a fires-on picker.
    await act(async () => { button(view.container, "Choice")!.click(); await pause(); });
    assert.equal(view.container.querySelectorAll(".judges-option").length, 2);
    for (const [index, input] of ([...view.container.querySelectorAll('.judges-option [aria-label$="meaning"]')] as HTMLTextAreaElement[]).entries()) {
      await act(async () => { type(input, index ? "No decision needed." : "A decision is needed."); await pause(); });
    }
    await act(async () => { button(view.container, "Add judge")!.click(); await pause(); });
    const sent = calls.at(-1)!;
    assert.equal(sent.method, "POST"); assert.equal(sent.body.revision, 3);
    assert.equal(sent.body.judge.question.type, "choice"); assert.equal(sent.body.judge.fire.label, "yes");
    assert.deepEqual(sent.body.judge.effects, [{ kind: "timeline-marker" }]);

    await act(async () => { button(view.container, "Edit")!.click(); await pause(); });
    await act(async () => { button(view.container, "Delete judge")!.click(); await pause(); });
    // Opening the editor reads the model list; declining sends nothing else.
    assert.equal(confirms.length, 1); assert.equal(calls.filter((call) => !call.path.startsWith("/api/judges/routes")).at(-1)!.method, "POST", "declining keeps the judge");
    answer = true;
    await act(async () => { button(view.container, "Delete judge")!.click(); await pause(); });
    assert.equal(calls.at(-1)!.method, "DELETE"); assert.equal(calls.at(-1)!.path, `/api/judges/${saved.id}?projectId=p1&revision=4`);
  } finally { await view.unmount(); }
});

test("load failure and no project are explicit", async () => {
  handleFetch = async () => { throw new Error("offline"); };
  const failed = await mount(createElement(JudgesSettings, { projectId: "p1", openJudgment() {} }));
  try { assert.match(failed.container.querySelector('[role="alert"]')?.textContent ?? "", /Could not load judges/); }
  finally { await failed.unmount(); }
  const none = await mount(createElement(JudgesSettings, { projectId: null, openJudgment() {} }));
  try { assert.match(none.container.textContent ?? "", /Open a project/); }
  finally { await none.unmount(); }
});

test("the timeline marker shows the assessment and only fills the composer", async () => {
  const event = (data: Record<string, unknown>, type = "judgment/assessment") => ({ id: "e", sessionId: "s", seq: 9, time: 1, type, v: 1, data }) as unknown as SessionEvent;
  const inserted: string[] = [];
  const view = await mount(createElement("div", null,
    createElement(AssessmentMarker, { event: event({ useId: "judges.completion-check", scope: "judges.completion-check.v1", kind: "completion-check",
      title: "Claimed, not verified", label: "claimed_only", probability: 0.82, followUp: "Please verify.", ts: 1 }), insert: (text: string) => inserted.push(text) }),
    createElement(AssessmentMarker, { event: event({ title: "Waiting for you", probability: 0.9, attention: true, kind: "needs-you" }) }),
    createElement(AssessmentMarker, { event: event({ title: "x", probability: 1 }, "assistant/message") })));
  try {
    const markers = view.container.querySelectorAll(".judges-marker");
    assert.equal(markers.length, 2, "other event types render nothing");
    assert.match(markers[0]!.textContent ?? "", /Claimed, not verified.*82%/);
    assert.equal(markers[1]!.getAttribute("data-attention"), "true");
    await act(async () => { button(view.container, "Ask the agent to verify")!.click(); await pause(); });
    assert.deepEqual(inserted, ["Please verify."]);
  } finally { await view.unmount(); }
});

const checkbox = (root: ParentNode, label: string) => [...root.querySelectorAll(".ui-checkbox")]
  .find((entry) => entry.querySelector(".ui-checkbox-label")?.textContent === label)?.querySelector("input") as HTMLInputElement | undefined;

test("a choice judge ties actions to its answers, with message presets and a rounds limit", async () => {
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  let state: JudgesSnapshot = { ...snapshot([]), viewer: "user-a" };
  handleFetch = async (path, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, method: init?.method ?? "GET", body });
    if (init?.method === "POST") state = { ...state, revision: 4, judges: [{ ...saved, ...body.judge, id: "j00000000000a", ownerUserId: "user-a" }] };
    return json(state);
  };
  const view = await mount(createElement(JudgesSettings, { projectId: "p1", openJudgment() {} }));
  try {
    await act(async () => { button(view.container, "Add judge")!.click(); await pause(); });
    const [name] = view.container.querySelectorAll(".judges-editor input") as NodeListOf<HTMLInputElement>;
    await act(async () => { type(name!, "Finish the work"); await pause(); });
    await act(async () => { type(view.container.querySelector(".judges-editor textarea") as HTMLTextAreaElement, "Is the work finished?"); await pause(); });
    await act(async () => { button(view.container, "Choice")!.click(); await pause(); });
    const names = [...view.container.querySelectorAll(".judges-option-name")] as HTMLInputElement[];
    await act(async () => { type(names[0]!, "unfinished"); await pause(); });
    await act(async () => { type(names[1]!, "done"); await pause(); });
    for (const [index, input] of ([...view.container.querySelectorAll('.judges-option [aria-label$="meaning"]')] as HTMLTextAreaElement[]).entries()) {
      await act(async () => { type(input, index ? "Finished and verified." : "Work remains."); await pause(); });
    }
    const answers = [...view.container.querySelectorAll(".judges-answer-actions")];
    assert.deepEqual(answers.map((row) => row.querySelector(".judges-answer-name")?.textContent), ["unfinished", "done"]);
    await act(async () => { checkbox(answers[0]!, "Send a message")!.click(); await pause(); });
    await act(async () => { checkbox(answers[1]!, "Merge the isolated work")!.click(); await pause(); });
    const message = view.container.querySelector('.judges-answer-actions textarea[aria-label="Message for unfinished"]') as HTMLTextAreaElement;
    assert.match(message.value, /^You have not finished the work yet/, "a new message starts from the Continue preset");
    assert.ok(view.container.querySelector('[aria-label="Messages in a row (messages)"]'), "a judge that sends gets a rounds limit");
    // Renaming an answer carries its actions.
    await act(async () => { type(names[1]!, "finished"); await pause(); });
    await act(async () => { button(view.container, "Add judge")!.click(); await pause(); });
    const sent = calls.at(-1)!;
    assert.equal(sent.method, "POST", sent.body ? "" : "the judge is sent");
    assert.deepEqual(sent.body.judge.effects.filter((effect: { kind: string }) => effect.kind !== "timeline-marker"), [
      { kind: "send-message", text: "You have not finished the work yet. Continue from where you stopped and carry it through to the end.", when: "unfinished" },
      { kind: "merge-isolated", when: "finished" },
    ]);
    assert.match(view.container.textContent ?? "", /Acts as you/, "the list says whose access an acting judge uses");
  } finally { await view.unmount(); }
});

test("a limit judge allows models from the person's shortlist", async () => {
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  handleFetch = async (path, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, method: init?.method ?? "GET", body });
    if (path.startsWith("/api/judges/routes")) return json({ routes: [
      { key: "codex::openai/gpt-x", harnessId: "codex", providerID: "openai", modelID: "gpt-x", favorite: true, available: true, quotaUsed: 0.4, blocked: false },
      { key: "claude::anthropic/opus", harnessId: "claude", providerID: "anthropic", modelID: "opus", runs: "Claude Opus 5.5", favorite: false, available: true, quotaUsed: 1, blocked: true, blockedUntil: Date.UTC(2026, 9, 15, 18) },
    ] });
    return json({ ...snapshot([]), viewer: "user-a" });
  };
  const view = await mount(createElement(JudgesSettings, { projectId: "p1", openJudgment() {} }));
  try {
    await act(async () => { button(view.container, "Add judge")!.click(); await pause(); });
    await act(async () => { type(view.container.querySelector(".judges-editor input") as HTMLInputElement, "Keep going"); await pause(); });
    await act(async () => { button(view.container, "Usage limit")!.click(); await pause(); });
    assert.ok(calls.some((call) => call.path === "/api/judges/routes?projectId=p1"));
    const routes = view.container.querySelector(".judges-routes")!;
    assert.match(routes.textContent ?? "", /Favorite · 40% of quota used/);
    assert.match(routes.textContent ?? "", /Limit reached until/);
    await act(async () => { (routes.querySelector("input") as HTMLInputElement).click(); await pause(); });
    await act(async () => { button(view.container, "Add judge")!.click(); await pause(); });
    const sent = calls.at(-1)!;
    assert.equal(sent.method, "POST");
    assert.equal(sent.body.judge.trigger, "limit-reached");
    assert.deepEqual(sent.body.judge.routes, ["codex::openai/gpt-x"]);
    assert.deepEqual(sent.body.judge.effects, [{ kind: "switch-route" }]);
    assert.equal(sent.body.judge.question.type, "route");
  } finally { await view.unmount(); }
});

test("a judge that got no answer says why, and its editor names the model that answers", async () => {
  const at = Date.UTC(2026, 9, 16, 8, 21);
  const withModel = { ...saved, model: "codex::openai/gpt-x" };
  handleFetch = async (path) => {
    if (path.startsWith("/api/judges/routes")) return json({ routes: [
      { key: "codex::openai/gpt-x", harnessId: "codex", providerID: "openai", modelID: "gpt-x", favorite: true, available: true, blocked: false },
    ] });
    return json({ ...snapshot([withModel]), usage: { [saved.id]: { day: "2026-10-16", count: 2, failure: { reason: "model-unavailable", at } } } });
  };
  const view = await mount(createElement(JudgesSettings, { projectId: "p1", openJudgment() {} }));
  try {
    const failure = view.container.querySelector(".judges-item-failure")?.textContent ?? "";
    assert.match(failure, /got no answer\. Its model is not available\. Choose a Small Model in Settings → Sessions, or pick a model for this judge\./);
    assert.match(view.container.querySelector(".judges-item-meta")?.textContent ?? "", /No answer/);
    await act(async () => { button(view.container, "Edit")!.click(); await pause(); });
    const answeredBy = view.container.querySelector('.judges-editor [aria-label="Answered by"]');
    assert.ok(answeredBy, "the editor shows who answers");
    assert.match(answeredBy!.textContent ?? "", /codex · openai\/gpt-x/);
  } finally { await view.unmount(); }
});

test("the marker says what a judge did with its owner's access", async () => {
  const event = { id: "e", sessionId: "s", seq: 9, time: 1, type: "judgment/assessment", v: 1, data: { kind: "custom", title: "Finish the work",
    label: "unfinished", probability: 0.86, ts: 1, actions: [
      { kind: "merge-isolated", status: "skipped", detail: "nothing to merge yet" },
      { kind: "send-message", status: "sending", detail: "You have not finished the work yet." },
      { kind: "set-approval", status: "failed", detail: "Only people who manage this chat can do that" },
    ] } } as unknown as SessionEvent;
  const view = await mount(createElement(AssessmentMarker, { event }));
  try {
    const marker = view.container.querySelector(".judges-marker")!;
    assert.match(marker.textContent ?? "", /unfinished, 86% likely/);
    assert.deepEqual([...marker.querySelectorAll(".judges-marker-action")].map((item) => item.textContent), [
      "Merge skipped: nothing to merge yet",
      "Sent “You have not finished the work yet.”",
      "Auto-Approve change failed: Only people who manage this chat can do that",
    ]);
    assert.equal(marker.getAttribute("data-attention"), "true", "a failed action raises the marker");
  } finally { await view.unmount(); }
});

test("a request's card shows each judge's latest verdict and its safety, live", async () => {
  let seq = 0;
  const at = (type: string, data: Record<string, unknown>) => ({ id: `e${++seq}`, sessionId: "s", seq, time: seq, type, v: 1, data }) as unknown as SessionEvent;
  const verdict = (data: Record<string, unknown>) => at("judgment/request-judged",
    { judgeId: "j0123456789ab", title: "Permissions judge", requestId: "req-1", verdict: "unsure", safety: 0.64, label: "safe", probability: 0.64, ts: 1, ...data });
  // The host store replaces a chat's event array when it changes, never mutating it.
  let events: readonly SessionEvent[] = [
    // An older request's verdict is never shown on a newer card.
    verdict({ requestId: "req-0", verdict: "against" }),
    at("permission/requested", { requestId: "req-1", permission: "bash" }),
    verdict({ verdict: "approve" }),
    verdict({}),
    // A mirrored copy belongs to the parent's card for that child, and a malformed one to no card.
    verdict({ sourceSessionId: "child", verdict: "against", safety: 0.1 }),
    verdict({ judgeId: "jffffffffffff", verdict: "maybe" }),
  ];
  const listeners = new Set<() => void>();
  const sessions = { events: () => events, subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); } };
  const view = await mount(createElement("div", null,
    createElement(RequestVerdicts, { sessions, sessionId: "s", requestId: "req-1" }),
    createElement("section", { id: "mirror" }, createElement(RequestVerdicts, { sessions, sessionId: "s", requestId: "req-1", sourceSessionId: "child" }))));
  try {
    const notes = [...view.container.querySelectorAll(":scope > div > .judges-verdicts > .judges-verdict")];
    assert.equal(notes.length, 1, "one line per judge: its latest verdict");
    assert.equal(notes[0]!.getAttribute("data-verdict"), "unsure");
    assert.equal(notes[0]!.querySelector(".ui-badge")?.textContent, "Unsure");
    assert.equal(notes[0]!.querySelector(".judges-verdict-judge")?.textContent, "Permissions judge");
    assert.equal(notes[0]!.querySelector(".judges-verdict-percent")?.textContent, "64% safe");
    assert.equal((notes[0]!.querySelector(".judges-verdict-meter") as HTMLElement).style.getPropertyValue("--judges-verdict-safety"), "0.64");
    assert.equal(notes[0]!.getAttribute("title"), "Permissions judge answered “safe” (64%). The decision is yours.");
    const mirror = view.container.querySelector("#mirror .judges-verdict")!;
    assert.equal(mirror.getAttribute("data-verdict"), "against");
    assert.match(mirror.textContent ?? "", /Advises against.*10% safe/);

    // A verdict that arrives later replaces the line; an approval that did not go through says why.
    events = [...events, verdict({ verdict: "approve", safety: 0.93, probability: 0.93,
      action: { kind: "approve-request", status: "skipped", detail: "this judge acts for no one; save it again to let it act for you", reason: "acts-for-no-one" } })];
    await act(async () => { listeners.forEach((listener) => listener()); await pause(); });
    const approved = () => view.container.querySelector(":scope > div > .judges-verdicts > .judges-verdict")!;
    assert.equal(approved().getAttribute("data-verdict"), "approve");
    assert.equal(approved().querySelector(".ui-badge")?.textContent, "Approved");
    // A known skip reads in the person's language; any other reason as the server said it.
    assert.equal(approved().querySelector(".judges-verdict-detail")?.textContent, "Not applied: save the judge again so it can act for you");
    assert.match(approved().getAttribute("title") ?? "", /The decision is yours\.$/, "a card that still waits says the decision is the person's");
    events = [...events, verdict({ verdict: "approve", safety: 0.93, probability: 0.93,
      action: { kind: "approve-request", status: "failed", detail: "Only people who manage this chat can do that" } })];
    await act(async () => { listeners.forEach((listener) => listener()); await pause(); });
    assert.equal(approved().querySelector(".judges-verdict-detail")?.textContent, "Not applied: Only people who manage this chat can do that");
    // A denial that did not go through reads the same way; advice never says "not applied".
    events = [...events, verdict({ verdict: "deny", safety: 0.03, probability: 0.97, label: "dangerous",
      action: { kind: "deny-request", status: "failed", detail: "Only people who work in this chat can do that" } })];
    await act(async () => { listeners.forEach((listener) => listener()); await pause(); });
    assert.equal(approved().querySelector(".ui-badge")?.textContent, "Denied");
    assert.equal(approved().querySelector(".judges-verdict-detail")?.textContent, "Not applied: Only people who work in this chat can do that");
    events = [...events, verdict({ verdict: "clear", safety: 0.92, probability: 0.92, label: "fine", action: { kind: "deny-request", status: "skipped" } })];
    await act(async () => { listeners.forEach((listener) => listener()); await pause(); });
    assert.equal(approved().querySelector(".ui-badge")?.textContent, "No objection");
    assert.equal(approved().querySelector(".judges-verdict-detail"), null);
  } finally { await view.unmount(); }
  const empty = await mount(createElement(RequestVerdicts, { sessions: { events: () => [], subscribe: () => () => {} }, sessionId: "s", requestId: "req-1" }));
  try { assert.equal(empty.container.innerHTML, "", "no verdict yet: nothing on the card"); }
  finally { await empty.unmount(); }
});

test("a card says a judge is checking, then its verdict, or that it got no answer", async () => {
  let seq = 0;
  const at = (type: string, data: Record<string, unknown>, time = 1_000) =>
    ({ id: `e${++seq}`, sessionId: "s", seq, time, type, v: 1, data }) as unknown as SessionEvent;
  const check = (data: Record<string, unknown>) => at("judgment/request-check",
    { judgeId: "j0123456789ab", title: "Permissions judge", requestId: "req-1", state: "checking", ts: 1_000, ...data });
  let events: readonly SessionEvent[] = [at("permission/requested", { requestId: "req-1", permission: "bash" }), check({})];
  const listeners = new Set<() => void>();
  const sessions = { events: () => events, subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); } };
  const push = async (event: SessionEvent) => { events = [...events, event]; await act(async () => { listeners.forEach((listener) => listener()); await pause(); }); };
  let now = 1_000 + 30_000;
  const view = await mount(createElement(RequestVerdicts, { sessions, sessionId: "s", requestId: "req-1", now: () => now }));
  const note = () => view.container.querySelector(".judges-verdict")!;
  try {
    assert.equal(note().getAttribute("data-verdict"), "checking");
    assert.equal(view.container.querySelectorAll('[role="status"]').length, 1, "one live region announces every judge's change");
    assert.equal(note().parentElement?.getAttribute("role"), "status");
    assert.equal(note().querySelector(".sr-only")?.textContent, "Permissions judge is checking this request.", "the tooltip is read out too");
    assert.equal(note().querySelector(".ui-badge")?.textContent, "Checking…");
    assert.ok(note().querySelector(".ui-badge .ui-spinner"), "a turning ring in place of the dot");
    assert.equal(note().querySelector(".judges-verdict-meter"), null, "no safety before an answer");
    assert.equal(note().getAttribute("title"), "Permissions judge is checking this request.");

    // The verdict replaces the check.
    await push(at("judgment/request-judged", { judgeId: "j0123456789ab", title: "Permissions judge", requestId: "req-1", verdict: "unsure",
      safety: 0.64, label: "safe", probability: 0.64, ts: 2_000 }));
    assert.equal(note().getAttribute("data-verdict"), "unsure");
    assert.equal(view.container.querySelectorAll(".judges-verdict").length, 1);

    // A second judge checks after it; when its call gets no answer, the card says so and leaves the decision to the person.
    await push(check({ judgeId: "jffffffffffff", title: "Second opinion", ts: 3_000 }));
    const second = () => view.container.querySelectorAll(".judges-verdict")[1]!;
    assert.equal(second().getAttribute("data-verdict"), "checking");
    await push(check({ judgeId: "jffffffffffff", title: "Second opinion", state: "no-answer", reason: "timeout", ts: 4_000 }));
    assert.equal(second().getAttribute("data-verdict"), "no-answer");
    assert.equal(second().querySelector(".ui-badge")?.textContent, "No answer");
    assert.equal(second().querySelector(".ui-spinner"), null);
    assert.equal(second().getAttribute("title"), "Second opinion got no answer in time. The decision is yours.");
  } finally { await view.unmount(); }

  // A check with nothing after it for too long was cut short (a restart): it stops spinning, even while the card stays open.
  events = [at("permission/requested", { requestId: "req-1", permission: "bash" }), check({ ts: 10_000 })];
  now = 10_000 + 5 * 60_000 - 100;
  const open = await mount(createElement(RequestVerdicts, { sessions, sessionId: "s", requestId: "req-1", now: () => now }));
  try {
    const only = () => open.container.querySelector(".judges-verdict")!;
    assert.equal(only().getAttribute("data-verdict"), "checking");
    now += 200;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    assert.equal(only().getAttribute("data-verdict"), "no-answer");
    assert.equal(only().getAttribute("title"), "Permissions judge got no answer about this request. The decision is yours.");
  } finally { await open.unmount(); }
});

test("a permission judge denies on its own answer, never on one that lets the request through", async () => {
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  let state: JudgesSnapshot = { ...snapshot([]), viewer: "user-a" };
  handleFetch = async (path, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, method: init?.method ?? "GET", body });
    if (path.includes("/routes")) return json({ routes: [] });
    if (init?.method === "POST") state = { ...state, revision: 4, judges: [{ ...saved, ...body.judge, id: "j00000000000a", ownerUserId: "user-a" }] };
    return json(state);
  };
  const view = await mount(createElement(JudgesSettings, { projectId: "p1", openJudgment() {} }));
  try {
    await act(async () => { button(view.container, "Add judge")!.click(); await pause(); });
    const [name] = view.container.querySelectorAll(".judges-editor input") as NodeListOf<HTMLInputElement>;
    await act(async () => { type(name!, "Gatekeeper"); await pause(); });
    await act(async () => { button(view.container, "Permission request")!.click(); await pause(); });
    const answers = () => [...view.container.querySelectorAll(".judges-answer-actions")];
    assert.deepEqual(answers().map((row) => row.querySelector(".judges-answer-name")?.textContent), ["safe", "unsure"]);
    // "safe" already approves: it cannot also deny.
    assert.equal(checkbox(answers()[0]!, "Approve the request")!.checked, true);
    assert.equal(checkbox(answers()[0]!, "Deny the request")!.disabled, true);
    assert.match(answers()[0]!.textContent ?? "", /Not with approving or Full access on the same answer/);
    // "unsure" may deny; then it may not approve, nor turn on Full access.
    await act(async () => { checkbox(answers()[1]!, "Deny the request")!.click(); await pause(); });
    assert.equal(checkbox(answers()[1]!, "Approve the request")!.disabled, true);
    await act(async () => { checkbox(answers()[1]!, "Change Auto-Approve")!.click(); await pause(); });
    assert.deepEqual([...answers()[1]!.querySelectorAll(".seg button")].map((entry) => entry.textContent), ["Auto-Approve", "Off"]);
    await act(async () => { button(view.container, "Add judge")!.click(); await pause(); });
    const sent = calls.at(-1)!;
    assert.equal(sent.method, "POST", "the judge is sent");
    assert.deepEqual(sent.body.judge.effects, [{ kind: "approve-request", when: "safe" }, { kind: "deny-request", when: "unsure" },
      { kind: "set-approval", level: "on", when: "unsure" }]);
    assert.match(view.container.textContent ?? "", /approves and denies and changes Auto-Approve/, "the list names what the judge does");
  } finally { await view.unmount(); }
});

test("a check that arrives while the card is open is timed by this device's clock, whatever the server's says", async () => {
  // This device's clock runs an hour ahead of the server that stamped the check.
  let now = 1_000_000 + 60 * 60_000;
  let events: readonly SessionEvent[] = [{ id: "e1", sessionId: "s", seq: 1, time: 1_000_000, type: "permission/requested", v: 1, data: { requestId: "req-1" } } as unknown as SessionEvent];
  const listeners = new Set<() => void>();
  const sessions = { events: () => events, subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); } };
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  // A new clock function re-schedules the stale timer from the current time, as any later render would.
  const render = async () => { const clock = () => now; await act(async () => { root.render(createElement(RequestVerdicts, { sessions, sessionId: "s", requestId: "req-1", now: clock })); await pause(); }); };
  try {
    await render();
    events = [...events, { id: "e2", sessionId: "s", seq: 2, time: 1_000_500, type: "judgment/request-check", v: 1,
      data: { judgeId: "j0123456789ab", title: "Permissions judge", requestId: "req-1", state: "checking", ts: 1_000_500 } } as unknown as SessionEvent];
    await act(async () => { listeners.forEach((listener) => listener()); await pause(); });
    const note = () => container.querySelector(".judges-verdict")!;
    assert.equal(note().getAttribute("data-verdict"), "checking", "not cut short by the skew");
    now += 4 * 60_000;
    await render();
    assert.equal(note().getAttribute("data-verdict"), "checking", "four minutes on this clock are not enough");
    now += 60_000 + 100;
    await render();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    assert.equal(note().getAttribute("data-verdict"), "no-answer", "five minutes on this clock end it");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
