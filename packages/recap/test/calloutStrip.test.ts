// The mounted CalloutStrip: nothing without callouts (or for an expected
// failure), quoted items most urgent first, one row shape (a ring that ticks the
// row off, the sentence, a kind tag) with a next step per kind (reply draft, fix
// request), ticks and dismissal that survive a reload, one fold for every strip,
// and every model-check outcome shown in place.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionEvent } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });

type Reply = { status: number; body: unknown };
const calls: Array<{ path: string; resolve(reply: Reply): void }> = [];
// The package transport binds fetch when the module loads.
globalThis.fetch = (async (input: RequestInfo | URL) => new Promise<Response>((resolve) => {
  calls.push({ path: String(input), resolve: (reply) => resolve(new Response(JSON.stringify(reply.body), { status: reply.status })) });
})) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: CalloutStrip } = await import("../widgets/CalloutStrip.tsx");
const { resetDismissedCacheForTests } = await import("../widgets/calloutDismissals.ts");
const { rememberAssistSettings } = await import("../widgets/assistSettings.ts");

// Enable callouts for tests; the production default is off.
rememberAssistSettings({ idleSeconds: 120, suggestNextPrompt: true, suggestionPriority: "harness", showCallouts: true });

const turn = (text: string): SessionEvent[] => [
  { seq: 1, type: "user/message", data: { text: "go" } },
  { seq: 2, type: "assistant/message", data: { text } },
  { seq: 3, type: "turn/stopped", data: { reason: "completed" } },
] as unknown as SessionEvent[];

const MANY = [
  "You need to set the `STRIPE_API_KEY` secret before the webhook works.",
  "The typecheck failed in `packages/harness-runtime` with 3 errors.",
  "Warning: the migration cannot be undone.",
  "Should I also delete the old route?",
  "Please restart the server after pulling.",
].join("\n\n");

function hostFor(events: SessionEvent[], revealed: number[] = [], inserted: string[] = []) {
  return {
    sessions: { events: () => events, subscribe: () => () => {} },
    ui: { locale: { translate: (key: string) => key } },
    conversation: {
      revealEvent: async (_: string, seq: number) => { revealed.push(seq); return true; },
      insert: (text: string) => { inserted.push(text); },
    },
    errors: { friendly: (action: string, cause: unknown) => `${action}: ${(cause as Error).message}` },
  } as unknown as WebPackageHost;
}

async function mount(host: WebPackageHost, sessionId: string) {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(createElement(CalloutStrip, { host, sessionId })));
  return {
    container,
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}
const click = async (element: Element | null | undefined) => {
  assert.ok(element, "missing control");
  await act(async () => { (element as unknown as { click(): void }).click(); });
};
const settle = async (reply: Reply) => {
  await act(async () => { calls.at(-1)!.resolve(reply); });
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
};
const kinds = (container: Element) => [...container.querySelectorAll(".callout-kind")].map((node) => node.textContent);
const row = (container: Element, kind: string) => container.querySelector(`.callout-${kind}`);

test("renders nothing when the turn has no callout, only an expected failure, or is unfinished", async () => {
  const plain = await mount(hostFor(turn("Renamed the helper and updated both call sites.")), "empty");
  assert.equal(plain.container.innerHTML, "");
  await plain.unmount();
  const mutation = await mount(hostFor(turn(
    "Quick mutation check: with the recap fallback removed, the new assertion should fail. It does, and the suite passes again with it restored.",
  )), "mutation");
  assert.equal(mutation.container.innerHTML, "", "an expected failure is not a failed check");
  await mutation.unmount();
  const running = await mount(hostFor(turn(MANY).slice(0, 2)), "running");
  assert.equal(running.container.innerHTML, "");
  await running.unmount();
});

test("renders nothing when showCallouts is false, even with real callouts", async () => {
  rememberAssistSettings({ idleSeconds: 120, suggestNextPrompt: true, suggestionPriority: "harness", showCallouts: false });
  try {
    const view = await mount(hostFor(turn(MANY)), "off");
    assert.equal(view.container.innerHTML, "", "callouts are hidden when the setting is off");
    await view.unmount();
  } finally {
    // Restore for remaining tests.
    rememberAssistSettings({ idleSeconds: 120, suggestNextPrompt: true, suggestionPriority: "harness", showCallouts: true });
  }
});

test("hides live when the setting turns off, without a reload", async () => {
  const view = await mount(hostFor(turn(MANY)), "live");
  try {
    assert.ok(view.container.querySelector(".callout-strip"), "the strip starts visible");
    await act(async () => {
      rememberAssistSettings({ idleSeconds: 120, suggestNextPrompt: true, suggestionPriority: "harness", showCallouts: false });
    });
    assert.equal(view.container.innerHTML, "", "the open strip disappears when the switch turns off");
  } finally {
    await view.unmount();
    rememberAssistSettings({ idleSeconds: 120, suggestNextPrompt: true, suggestionPriority: "harness", showCallouts: true });
  }
});

test("lists quoted items most urgent first, each with its next step", async () => {
  const revealed: number[] = [];
  const inserted: string[] = [];
  const view = await mount(hostFor(turn(MANY), revealed, inserted), "items");
  try {
    const strip = view.container.querySelector("section.callout-strip");
    assert.equal(strip?.getAttribute("aria-label"), "Key callouts from the last turn");
    assert.equal(strip?.querySelector(".callout-title")?.textContent, "Before you continue");
    assert.deepEqual(kinds(view.container), ["Decision", "Check failed", "Manual step", "To do", "Risk"]);

    const credential = row(view.container, "credential");
    assert.equal(credential?.querySelector(".callout-quote code")?.textContent, "STRIPE_API_KEY");
    assert.match(credential?.querySelector(".callout-quote")?.textContent ?? "", /^You need to set the STRIPE_API_KEY secret/);
    // The whole sentence opens its message; the kind is a tag beside it.
    const open = credential?.querySelector("button.callout-open");
    assert.equal(open?.getAttribute("title"), "Show in message");
    assert.match(open?.textContent ?? "", /^You need to set/);
    assert.equal(credential?.querySelector(".callout-trail .callout-kind")?.textContent, "Manual step");
    assert.equal(credential?.querySelector(".callout-dismiss"), null, "the ring replaces a per-row dismiss");
    await click(open);
    assert.deepEqual(revealed, [2]);

    // A question gets a reply draft quoting it; a failure gets a fix request. Nothing is sent.
    await click(row(view.container, "decision")?.querySelector(".callout-act"));
    await click(row(view.container, "failed-check")?.querySelector(".callout-act"));
    assert.deepEqual(inserted, [
      "> Should I also delete the old route?\n\n",
      "> The typecheck failed in `packages/harness-runtime` with 3 errors.\n\nPlease investigate this failure and fix it.",
    ]);
    assert.deepEqual(
      [...view.container.querySelectorAll(".callout-act")].map((node) => node.textContent),
      ["Reply", "Ask to fix"],
      "steps for the person and risks offer no agent action",
    );
    // Every row has the same shape: a named ring that ticks it off.
    const check = row(view.container, "action")?.querySelector<HTMLInputElement>(".callout-check input");
    assert.equal(check?.type, "checkbox");
    assert.match(check?.closest("label")?.textContent ?? "", /^Mark as done: Please restart the server/);
    assert.equal(view.container.querySelectorAll(".callout .callout-check input").length, 5);
    // Only what waits on the person now carries a dot.
    assert.deepEqual(
      [...view.container.querySelectorAll(".callout[data-urgent]")].map((node) => node.querySelector(".callout-kind")?.textContent),
      ["Decision", "Check failed"],
    );
    assert.ok(view.container.querySelector(".callout-dismiss-all"));
  } finally {
    await view.unmount();
  }
});

test("a run of one kind names it once, and the header counts what is still open", async () => {
  const view = await mount(hostFor(turn([
    "Warning: the migration cannot be undone.",
    "Rebasing means a force-push of the shared branch.",
    "Please restart the server after pulling.",
  ].join("\n\n"))), "runs");
  try {
    const rows = [...view.container.querySelectorAll(".callout")];
    assert.deepEqual(rows.map((node) => node.hasAttribute("data-continues")), [false, false, true]);
    // The repeated tag stays in the row for assistive technology only.
    assert.deepEqual(kinds(view.container), ["To do", "Risk", "Risk"]);
    assert.equal(rows[1]?.querySelector(".callout-kind")?.classList.contains("sr-only"), false);
    assert.equal(rows[2]?.querySelector(".callout-kind")?.classList.contains("sr-only"), true);
    assert.ok(rows[2]?.querySelector(".callout-check input"), "a continuing row keeps its ring");

    const total = () => view.container.querySelector(".callout-total")?.textContent;
    assert.equal(total(), "3");
    await click(row(view.container, "action")?.querySelector(".callout-check input"));
    assert.equal(total(), "2", "a ticked step no longer counts");
    await click(rows[1]?.querySelector(".callout-check input"));
    assert.equal(total(), "1", "nor a risk taken in");
  } finally {
    await view.unmount();
  }
});

test("ticks and dismissal survive a reload, and a new turn brings its own", async () => {
  const view = await mount(hostFor(turn(MANY)), "dismiss");
  // A question answered: struck through, and its reply step goes.
  await click(row(view.container, "decision")?.querySelector(".callout-check input"));
  assert.equal(row(view.container, "decision")?.hasAttribute("data-done"), true);
  assert.equal(row(view.container, "decision")?.querySelector(".callout-act"), null);
  await click(row(view.container, "action")?.querySelector(".callout-check input"));
  assert.equal(row(view.container, "action")?.hasAttribute("data-done"), true);
  await view.unmount();

  resetDismissedCacheForTests(); // a reload: only storage remains
  const reloaded = await mount(hostFor(turn(MANY)), "dismiss");
  assert.deepEqual(kinds(reloaded.container), ["Decision", "Check failed", "Manual step", "To do", "Risk"]);
  assert.equal(row(reloaded.container, "decision")?.hasAttribute("data-done"), true, "the ticks are kept");
  assert.equal(row(reloaded.container, "action")?.querySelector<HTMLInputElement>(".callout-check input")?.checked, true);
  await click(row(reloaded.container, "action")?.querySelector(".callout-check input"));
  assert.equal(row(reloaded.container, "action")?.hasAttribute("data-done"), false, "and can be taken back");
  await click(reloaded.container.querySelector(".callout-dismiss-all"));
  assert.equal(reloaded.container.innerHTML, "", "dismissing everything removes the strip");
  await reloaded.unmount();

  resetDismissedCacheForTests();
  const dismissed = await mount(hostFor(turn(MANY)), "dismiss");
  assert.equal(dismissed.container.innerHTML, "", "and it stays dismissed after a reload");
  await dismissed.unmount();

  const next = turn(MANY).map((event) => ({ ...event, seq: event.seq + 10 }));
  const fresh = await mount(hostFor(next as SessionEvent[]), "dismiss");
  assert.equal(kinds(fresh.container).length, 5, "the next turn's callouts are not hidden");
  assert.equal(fresh.container.querySelector("[data-done]"), null, "nor ticked");
  await fresh.unmount();
});

test("folding keeps a per-kind tally, holds for every strip, and long lists show the rest on demand", async () => {
  const view = await mount(hostFor(turn(MANY)), "fold");
  const toggle = () => view.container.querySelector(".callout-toggle");
  assert.equal(toggle()?.getAttribute("aria-expanded"), "true");
  assert.equal(toggle()?.getAttribute("aria-controls"), view.container.querySelector(".callout-list")?.id);
  await click(toggle());
  assert.equal(toggle()?.getAttribute("aria-expanded"), "false");
  assert.equal(view.container.querySelector(".callout-list"), null);
  assert.deepEqual(
    [...view.container.querySelectorAll(".callout-count")].map((node) => node.textContent),
    ["Decision 1", "Check failed 1", "Manual step 1", "To do 1", "Risk 1"],
  );
  await view.unmount();

  resetDismissedCacheForTests();
  const other = await mount(hostFor(turn(MANY)), "fold-other");
  assert.equal(other.container.querySelector(".callout-toggle")?.getAttribute("aria-expanded"), "false", "the fold is one preference");
  await click(other.container.querySelector(".callout-toggle"));
  await other.unmount();

  const long = [MANY, "You must rotate the leaked token.", "Please review the generated SQL file.", "I could not run the e2e suite here."].join("\n\n");
  const folded = await mount(hostFor(turn(long)), "long");
  assert.equal(folded.container.querySelectorAll(".callout").length, 4);
  const more = folded.container.querySelector(".callout-more");
  assert.equal(more?.textContent, "Show 4 more");
  await click(more);
  assert.equal(folded.container.querySelectorAll(".callout").length, 8);
  assert.equal(folded.container.querySelector(".callout-more"), null);
  await folded.unmount();
});

test("the model check shows checking, a failure, nothing found, and added items in place", async () => {
  const view = await mount(hostFor(turn(MANY)), "model");
  try {
    const ask = () => view.container.querySelector<HTMLButtonElement>(".callout-ask");
    const status = () => view.container.querySelector(".callout-status");

    assert.equal(ask()?.textContent, "Find more");
    await click(ask());
    assert.equal(calls.at(-1)!.path, "/api/sessions/model/assist/callouts");
    assert.equal(ask()?.getAttribute("aria-busy"), "true");
    assert.equal(ask()?.disabled, true);
    assert.equal(status()?.textContent, "Checking…");
    assert.equal(status()?.getAttribute("role"), "status");

    await settle({ status: 502, body: { error: "upstream", message: "timed out" } });
    assert.equal(ask()?.disabled, false);
    assert.equal(status()?.textContent, "Couldn't check with the model: timed out");
    assert.ok(status()?.classList.contains("callout-status-failed"));

    // A newer turn already replaced the callouts: the stale reply is dropped quietly.
    await click(ask());
    await settle({ status: 409, body: { error: "stale", message: "stale" } });
    assert.equal(status()?.textContent, "");

    await click(ask());
    await settle({ status: 200, body: { atSeq: 2, callouts: [] } });
    assert.equal(status()?.textContent, "The model found nothing more.");
    assert.equal(ask(), null, "a finished check is not offered again for the same turn");
  } finally {
    await view.unmount();
  }

  const added = await mount(hostFor(turn(MANY)), "model-added");
  try {
    await click(added.container.querySelector(".callout-ask"));
    await settle({ status: 200, body: { atSeq: 2, callouts: [
      { id: "2:credential:m0", kind: "credential", quote: "Please restart the server after pulling.", seq: 2, source: "model" },
      { id: "2:risk:m1", kind: "risk", quote: "A new model-only warning.", seq: 2, source: "model" },
    ] } });
    assert.equal(added.container.querySelector(".callout-status")?.textContent, "The model found 1 more.");
    const found = added.container.querySelectorAll('.callout[data-source="model"]');
    assert.equal(found.length, 1, "overlapping quotes are not repeated");
    assert.equal(found[0]?.querySelector(".callout-from-model")?.getAttribute("title"), "Found by model");
  } finally {
    await added.unmount();
  }
});
