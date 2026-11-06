// The permission card of a session that is not the open chat
// (`session.permission.requests`): the same card a chat shows, kept current from
// the session's canonical events because the socket follows only the active chat.
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
register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: SessionPermissions } = await import("../widgets/SessionPermissions.tsx");
const { setSessions } = await import("../../../apps/web/src/store.ts");

type Fixture = { id: string; sessionId: string; seq: number; time: number; v: number; type: string; data: Record<string, unknown> };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function session(id: string) {
  const log: Fixture[] = [];
  const add = (type: string, data: Record<string, unknown>) => {
    const seq = log.length + 1;
    log.push({ id: `${id}-${seq}`, sessionId: id, seq, time: seq, v: 1, type, data });
  };
  return { id, log, add };
}

const requested = (requestId: string, risk: "routine" | "high") => ({
  requestId, permission: "bash", tool: "Bash", patterns: ["rm -rf cache"],
  preview: { title: "Bash", lines: ["rm -rf cache"], risk },
});

/** Serves one session's log the way the server does, and records decisions. */
function serve(fixture: ReturnType<typeof session>, opts: { window?: number; onDecision?: (url: string, body: Record<string, unknown>) => Response | undefined } = {}) {
  const decisions: Array<{ url: string; body: Record<string, unknown> }> = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost/");
    if (url.pathname.endsWith("/events/forward")) {
      const after = Number(url.searchParams.get("afterSeq"));
      const events = fixture.log.filter((event) => event.seq > after);
      return json({ events, highWater: fixture.log.length, cursor: events.at(-1)?.seq ?? after, complete: true });
    }
    if (url.pathname.endsWith("/events")) {
      const before = Number(url.searchParams.get("beforeSeq") ?? Infinity);
      const limit = opts.window ?? Number(url.searchParams.get("limit") ?? 400);
      return json(fixture.log.filter((event) => event.seq < before).slice(-limit));
    }
    if (init?.method === "POST" || init?.method === "PATCH") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      decisions.push({ url: url.pathname, body });
      return opts.onDecision?.(url.pathname, body) ?? json({ ok: true, setting: body.setting });
    }
    return json({});
  }) as typeof fetch;
  return decisions;
}

type Effect = { confirmNote?: string; apply(level: "routine" | "all"): void };
type Notes = (props: { slot: string; context?: { addPolicyEffect?: (effect: Effect) => () => void; policyLevel?: unknown } }) => null;

async function mount(sessionId: string, requestIds: string[] = [], Slot?: Notes) {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(SessionPermissions, { sessionId, requestIds, ...(Slot ? { Slot: Slot as never } : {}) }));
    await delay(30);
  });
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}

const labels = (root: { querySelectorAll(selector: string): Iterable<unknown> }) =>
  [...root.querySelectorAll(".perm-actions button")].map((button) => (button as HTMLElement).className);

setSessions("p1", ["routine", "risky", "answered", "failing", "auto", "old", "expired", "effect-once", "effect-all", "effect-refused"].map((id) => (
  { id, projectId: "p1", title: id, status: "waiting", createdAt: 1, updatedAt: 1 }
)) as never);

test("a routine request offers the chat's decisions, Auto-Approve included", async () => {
  const fixture = session("routine");
  fixture.add("permission/requested", requested("r1", "routine"));
  serve(fixture);
  const view = await mount("routine", ["r1"]);
  try {
    const actions = labels(view.container);
    assert.ok(actions.some((name) => name.includes("permission-deny")));
    assert.ok(actions.some((name) => name.includes("permission-allow")));
    assert.ok(actions.some((name) => name.includes("permission-session")), "Auto-Approve is offered");
  } finally { await view.unmount(); }
});

test("a high-risk request offers Allow all, and it asks before anything is sent", async () => {
  const fixture = session("risky");
  fixture.add("permission/requested", requested("r1", "high"));
  const decisions = serve(fixture);
  const { resolveAlert } = await import("../../../apps/web/src/alerts.ts");
  const view = await mount("risky", ["r1"]);
  try {
    const all = view.container.querySelector(".permission-allow-all") as unknown as HTMLButtonElement | null;
    assert.ok(all, "Allow all is offered");
    assert.ok(view.container.querySelector(".permission-risk"), "the risk explanation comes with it");
    await act(async () => { all.click(); await delay(10); });
    assert.equal(decisions.length, 0, "nothing goes out before the confirmation");
    await act(async () => { resolveAlert(true); await delay(20); });
    assert.deepEqual(decisions.map((decision) => [decision.url, decision.body]), [
      ["/api/sessions/risky/permissions/auto-accept", { setting: "all" }],
    ]);
  } finally { await view.unmount(); }
});

test("an answer goes to the session and the card leaves at the click", async () => {
  const fixture = session("answered");
  fixture.add("permission/requested", requested("r1", "routine"));
  const decisions = serve(fixture);
  const view = await mount("answered", ["r1"]);
  try {
    const allow = view.container.querySelector(".permission-allow") as unknown as HTMLButtonElement;
    await act(async () => { allow.click(); await delay(20); });
    assert.deepEqual(decisions, [{ url: "/api/sessions/answered/permission/r1", body: { reply: "once" } }]);
    assert.ok(!view.container.querySelector(".perm-actions"), "not offered a second time");
  } finally { await view.unmount(); }
});

test("a refused answer brings the card back with the server's reason", async () => {
  const fixture = session("failing");
  fixture.add("permission/requested", requested("r1", "routine"));
  serve(fixture, { onDecision: () => new Response(JSON.stringify({ error: "permission request already resolved", code: "conflict" }), { status: 409 }) });
  const view = await mount("failing", ["r1"]);
  try {
    const allow = view.container.querySelector(".permission-allow") as unknown as HTMLButtonElement;
    await act(async () => { allow.click(); await delay(30); });
    assert.ok(view.container.querySelector(".permission-allow"), "offered again");
    assert.ok(view.container.querySelector(".permission-error")?.textContent, "and it says why");
  } finally { await view.unmount(); }
});

test("a decision made through the policy stays gone: the card reads the session while it waits", async () => {
  const fixture = session("auto");
  fixture.add("permission/requested", requested("r1", "routine"));
  serve(fixture, { onDecision: () => { fixture.add("permission/resolved", { requestId: "r1", reply: "once", auto: true }); return undefined; } });
  const view = await mount("auto", ["r1"]);
  try {
    const auto = view.container.querySelector(".permission-session") as unknown as HTMLButtonElement;
    await act(async () => { auto.click(); await delay(1_700); });
    assert.ok(!view.container.querySelector(".perm-banner"), "past the card's own grace, it did not come back");
  } finally { await view.unmount(); }
});

test("a request older than the first window is still found", async () => {
  const fixture = session("old");
  fixture.add("permission/requested", requested("r1", "routine"));
  for (let index = 0; index < 5; index += 1) fixture.add("assistant/chunk", { text: "x", partId: "p" });
  serve(fixture, { window: 3 });
  const view = await mount("old", ["r1"]);
  try {
    await act(async () => { await delay(60); });
    assert.ok(view.container.querySelector(".permission-allow"), "paged back to it");
  } finally { await view.unmount(); }
});

test("an expired request has no card: nothing could answer it", async () => {
  const fixture = session("expired");
  fixture.add("permission/requested", requested("r1", "routine"));
  fixture.add("permission/expired", { requestId: "r1" });
  serve(fixture);
  const view = await mount("expired", ["r1"]);
  try { assert.ok(!view.container.querySelector(".perm-banner")); }
  finally { await view.unmount(); }
});

/** A note that asks for one policy effect, as a package's checkbox does. */
function effectNote(applied: string[], levels: unknown[], confirmNote?: string): Notes {
  const effect: Effect = { ...(confirmNote ? { confirmNote } : {}), apply: (level) => { applied.push(level); } };
  return ({ context }) => {
    levels.push(context?.policyLevel);
    // A set: each row keeps one, however often it renders.
    context?.addPolicyEffect?.(effect);
    return null;
  };
}

test("a note's policy effect runs after Auto-Approve, not after Allow or Deny", async () => {
  const fixture = session("effect-once");
  fixture.add("permission/requested", requested("r1", "routine"));
  fixture.add("permission/requested", { ...requested("r2", "routine"), patterns: ["npm test"], preview: { title: "Bash", lines: ["npm test"], risk: "routine" } });
  serve(fixture);
  const applied: string[] = [];
  const levels: unknown[] = [];
  const view = await mount("effect-once", ["r1", "r2"], effectNote(applied, levels));
  try {
    assert.equal(levels[0], "routine");
    await act(async () => { (view.container.querySelector(".permission-allow") as unknown as HTMLButtonElement).click(); await delay(20); });
    assert.deepEqual(applied, [], "one answer is not a policy");
    await act(async () => { (view.container.querySelector(".permission-session") as unknown as HTMLButtonElement).click(); await delay(20); });
    assert.deepEqual(applied, ["routine"]);
  } finally { await view.unmount(); }
});

test("Allow all shows a note's words in its confirmation and applies only once confirmed", async () => {
  const fixture = session("effect-all");
  fixture.add("permission/requested", requested("r1", "high"));
  const decisions = serve(fixture);
  const { resolveAlert, useAlert } = await import("../../../apps/web/src/alerts.ts");
  const applied: string[] = [];
  let message = "";
  const Watch = () => { message = useAlert()?.message ?? message; return null; };
  const watcher = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
  await act(async () => watcher.render(createElement(Watch)));
  const view = await mount("effect-all", ["r1"], effectNote(applied, [], "Next sessions too."));
  try {
    await act(async () => { (view.container.querySelector(".permission-allow-all") as unknown as HTMLButtonElement).click(); await delay(10); });
    assert.match(message, /Next sessions too\.$/);
    assert.deepEqual(applied, [], "not before the person confirmed");
    await act(async () => { resolveAlert(false); await delay(10); });
    assert.deepEqual(applied, [], "not when they declined");
    assert.equal(decisions.length, 0);
    await act(async () => { (view.container.querySelector(".permission-allow-all") as unknown as HTMLButtonElement).click(); await delay(10); });
    await act(async () => { resolveAlert(true); await delay(20); });
    assert.deepEqual(applied, ["all"]);
  } finally {
    await view.unmount();
    await act(async () => watcher.unmount());
  }
});

test("a note's effect waits for the session: a refused level applies nothing", async () => {
  const fixture = session("effect-refused");
  fixture.add("permission/requested", requested("r1", "routine"));
  serve(fixture, { onDecision: () => new Response(JSON.stringify({ error: "forbidden", code: "forbidden" }), { status: 403 }) });
  const applied: string[] = [];
  const view = await mount("effect-refused", ["r1"], effectNote(applied, []));
  try {
    await act(async () => { (view.container.querySelector(".permission-session") as unknown as HTMLButtonElement).click(); await delay(30); });
    assert.deepEqual(applied, []);
    assert.ok(view.container.querySelector(".permission-session"), "the card is back to decide again");
  } finally { await view.unmount(); }
});
