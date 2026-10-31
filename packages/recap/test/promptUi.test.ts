import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionEvent } from "@polyth/contracts";
import type { ComposerDraftSnapshot, WebPackageHost } from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

// The package's API transport captures `fetch` once at module load, so every
// test routes through one delegating stub.
let fetchHandler: typeof fetch = async () => { throw new Error("unexpected request"); };
const delegatingFetch: typeof fetch = (input, init) => fetchHandler(input, init);

test("mounted prompt controls rewrite, undo, regenerate and discard stale or unmounted results", async () => {
  const dom = new Window();
  Object.assign(globalThis, { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; draft: string; resolve(value: Response): void }> = [];
  globalThis.fetch = delegatingFetch;
  fetchHandler = async (input, init) => String(input) === "/api/settings/assist"
    ? new Response(JSON.stringify({ idleSeconds: 120, suggestNextPrompt: true }), { status: 200 })
    : new Promise<Response>((resolve) => {
      calls.push({ path: String(input), draft: JSON.parse(String(init?.body)).draft, resolve });
    });
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: PromptAssist } = await import("../widgets/PromptAssist.tsx");
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  let current: ComposerDraftSnapshot = { projectId: "p1", sessionId: null, text: "fix teh bug", revision: 1, latestSeq: 0 };
  const replacements: string[] = [];
  const notices: string[] = [];
  const listeners = new Set<() => void>();
  let events: SessionEvent[] = [];
  const host = {
    sessions: {
      events: () => events,
      get: () => undefined,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    },
    ui: { locale: { translate: (key: string) => key } },
    errors: { friendly: (action: string) => action, show: (message: string) => notices.push(message) },
  } as unknown as WebPackageHost;
  const render = () => root.render(createElement(PromptAssist, {
    host, draft: {
      ...current, busy: false, read: () => ({ ...current }),
      replace: (text: string) => {
        replacements.push(text);
        current = { ...current, text, revision: current.revision + 1 };
        render();
      },
    },
  }));
  const click = async (label: string) => {
    const button = container.querySelector(`button[aria-label="${label}"]`);
    assert.ok(button, `missing button ${label}`);
    await act(async () => { (button as unknown as { click(): void }).click(); });
  };
  const reply = async (text: string, atSeq = 0) => {
    await act(async () => {
      calls.at(-1)!.resolve(new Response(JSON.stringify({ suggestion: text, atSeq }), { status: 200 }));
    });
  };
  try {
    await act(async () => render());
    await click("composer.improvePrompt");
    assert.equal(calls[0]!.path, "/api/projects/p1/assist/prompt");
    assert.equal(container.querySelector("button")?.disabled, true);
    await reply("Fix the bug.");
    assert.deepEqual(replacements, ["Fix the bug."]);
    await click("timeline.regenerate");
    assert.equal(calls.at(-1)!.draft, "fix teh bug", "regeneration uses the original words");
    await reply("Repair the bug.");
    await click("settings.widgetspage.undo");
    assert.equal(current.text, "fix teh bug");

    await click("composer.improvePrompt");
    current = { ...current, text: "keep my edits", revision: current.revision + 1 };
    await act(async () => render());
    await reply("Overwrite the edits.");
    assert.equal(current.text, "keep my edits");

    await click("composer.improvePrompt");
    current = { ...current, projectId: "p2" };
    await act(async () => render());
    await reply("Wrong project.");
    assert.equal(current.text, "keep my edits");

    current = { ...current, sessionId: "s1", latestSeq: 7 };
    await act(async () => render());
    await click("composer.improvePrompt");
    assert.equal(calls.at(-1)!.path, "/api/sessions/s1/assist/suggestion");
    current = { ...current, latestSeq: 8 };
    await reply("Edits, rewritten.", 7);
    assert.equal(current.text, "Edits, rewritten.", "a rewrite depends on the draft, not on later session events");
    await click("settings.widgetspage.undo");
    assert.equal(current.text, "keep my edits");

    current = { ...current, text: "", revision: current.revision + 1 };
    await act(async () => render());
    assert.equal(container.querySelector("button")?.disabled, true);
    await act(async () => {
      events = [
        { id: "e1", sessionId: "s1", seq: 1, time: 1, type: "user/message", data: { text: "Fix the bug." }, v: 1 },
        { id: "e2", sessionId: "s1", seq: 8, time: 2, type: "assistant/message", data: { text: "The retry needs attention." }, v: 1 },
      ] as SessionEvent[];
      for (const notify of listeners) notify();
    });
    assert.equal(container.querySelector("button")?.disabled, false, "completed history refreshes the package without a composer render");
    current = { ...current, text: "keep my edits", revision: current.revision + 1 };
    await act(async () => render());
    await click("composer.improvePrompt");
    await act(async () => root.unmount());
    await reply("Disabled package.", 8);
    assert.deepEqual(replacements, ["Fix the bug.", "Repair the bug.", "fix teh bug", "Edits, rewritten.", "keep my edits"]);
    assert.deepEqual(notices, []);
    assert.equal(listeners.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await dom.happyDOM.abort();
  }
});

type Offer = { sessionId: string; text: string; preferred?: boolean } | null;

/** The composer as Session Assist sees it: the headless next-prompt source the
 * host mounts through `composer.suggestion`, plus the rail button. */
async function composerHarness(sessionId: string) {
  const dom = new Window();
  Object.assign(globalThis, { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
  const calls: Array<{ path: string; body: Record<string, unknown>; resolve(value: Response): void }> = [];
  let settingsResponse: () => Response = () => new Response(JSON.stringify({ idleSeconds: 120, suggestNextPrompt: true }), { status: 200 });
  let settingsRequests = 0;
  fetchHandler = async (input, init) => {
    if (String(input) === "/api/settings/assist") {
      settingsRequests += 1;
      return settingsResponse();
    }
    return new Promise<Response>((resolve) => {
      calls.push({ path: String(input), body: JSON.parse(String(init?.body)), resolve });
    });
  };
  const { act, createElement, Fragment } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: PromptAssist } = await import("../widgets/PromptAssist.tsx");
  const { default: NextPromptSource } = await import("../widgets/NextPromptSource.tsx");
  const { resetNextPrompts } = await import("../widgets/nextPrompt.ts");
  resetNextPrompts();
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  let root = createRoot(container as unknown as HTMLElement);
  const listeners = new Set<() => void>();
  const notices: Array<{ message: string; kind?: string }> = [];
  const state = {
    status: "idle",
    events: [] as SessionEvent[],
    current: { projectId: "p1", sessionId, text: "", revision: 1, latestSeq: 0 } as ComposerDraftSnapshot,
    harnessSuggestion: undefined as string | undefined,
    harnessSuggests: false,
    assist: undefined as { recap: string; suggestion?: string; atSeq: number; generatedAt: number } | undefined,
  };
  const offers: Offer[] = [];
  const replacements: string[] = [];
  const offerSuggestion = (offer: Offer) => { offers.push(offer); };
  const host = {
    sessions: {
      events: () => state.events,
      get: () => ({ status: state.status, assist: state.assist }),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    },
    ui: { locale: { translate: (key: string) => key } },
    errors: {
      friendly: (action: string) => action,
      show: (message: string, _action?: unknown, options?: { kind?: string }) => { notices.push({ message, ...(options?.kind ? { kind: options.kind } : {}) }); },
    },
  } as unknown as WebPackageHost;
  const draft = () => ({
    ...state.current, busy: state.status !== "idle", read: () => ({ ...state.current }),
    replace: (text: string) => { replacements.push(text); state.current = { ...state.current, text }; },
    offerSuggestion,
    ...(state.harnessSuggestion ? { harnessSuggestion: state.harnessSuggestion } : {}),
    harnessSuggests: state.harnessSuggests,
  });
  const element = (withButton: boolean) => createElement(Fragment, null,
    createElement(NextPromptSource, { host, draft: draft() }),
    withButton ? createElement(PromptAssist, { host, draft: draft() }) : null);
  let withButton = true;
  const render = async (button = withButton) => {
    withButton = button;
    await act(async () => root.render(element(button)));
  };
  const remount = async () => {
    await act(async () => root.unmount());
    root = createRoot(container as unknown as HTMLElement);
    await render();
  };
  const notify = async () => { await act(async () => { for (const listener of listeners) listener(); }); await render(); };
  const settle = async (ms = 450) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
  const reply = async (suggestion: string, atSeq: number) => {
    await act(async () => {
      calls.at(-1)!.resolve(new Response(JSON.stringify({ suggestion, atSeq }), { status: 200 }));
    });
  };
  const exchange = (from: number, user: string, assistant: string) => [
    { id: `u${from}`, sessionId, seq: from, time: from, type: "user/message", data: { text: user }, v: 1 },
    { id: `a${from}`, sessionId, seq: from + 1, time: from + 1, type: "assistant/message", data: { text: assistant }, v: 1 },
    { id: `t${from}`, sessionId, seq: from + 2, time: from + 2, type: "turn/stopped", data: { turnId: `t${from}`, reason: "completed" }, v: 1, ignorable: true },
  ] as SessionEvent[];
  const button = () => container.querySelector('button[aria-label="composer.generateNextAction"]') as unknown as { click(): void; disabled: boolean } | null;
  const unmount = async () => { await act(async () => root.unmount()); };
  return {
    dom, act, state, calls, offers, replacements, notices, listeners, render, remount, notify, settle, reply, exchange, button, unmount,
    settingsRequests: () => settingsRequests,
    failSettings: (fail: boolean) => {
      settingsResponse = fail
        ? () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })
        : () => new Response(JSON.stringify({ idleSeconds: 120, suggestNextPrompt: true, suggestionPriority: "harness" }), { status: 200 });
    },
  };
}

test("after a reply the next prompt rides on the host's suggestion chip, like a harness hint", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = delegatingFetch;
  const { rememberAssistSettings } = await import("../widgets/assistSettings.ts");
  rememberAssistSettings({ idleSeconds: 120, suggestNextPrompt: true });
  const ui = await composerHarness("s9");
  const { state, calls, offers, replacements } = ui;
  try {
    state.events = ui.exchange(1, "Fix the retry.", "Added the missing await.");
    await ui.render();
    await ui.settle();
    assert.equal(calls.length, 1, "an idle chat after a reply asks once on its own");
    assert.equal(calls[0]!.path, "/api/sessions/s9/assist/suggestion");
    assert.deepEqual(calls[0]!.body, { draft: "" });
    await ui.reply("Add a regression test for the retry.", 3);
    assert.deepEqual(offers.at(-1), { sessionId: "s9", text: "Add a regression test for the retry." });
    assert.equal(replacements.length, 0, "a suggestion is offered, never written into the draft");

    await ui.render(false);
    await ui.settle();
    assert.deepEqual(offers.at(-1), { sessionId: "s9", text: "Add a regression test for the retry." },
      "the suggestion does not depend on the rail button being shown");
    await ui.render(true);

    await ui.unmount();
    assert.equal(offers.at(-1), null, "unmount (package disable) withdraws the offer");
    await ui.remount();
    await ui.settle();
    assert.equal(calls.length, 1, "a remount reuses the answer instead of paying again");
    assert.deepEqual(offers.at(-1), { sessionId: "s9", text: "Add a regression test for the retry." });

    state.status = "working";
    state.events = [...state.events, ui.exchange(4, "Do it.", "")[0]!];
    await ui.notify();
    assert.equal(offers.at(-1), null, "a new message withdraws the stale suggestion");
    await ui.settle();
    assert.equal(calls.length, 1, "nothing is asked while the agent works");

    state.events = [...state.events, ...ui.exchange(4, "Do it.", "Added the test.").slice(1)];
    state.status = "idle";
    state.harnessSuggestion = "Run the suite";
    await ui.notify();
    await ui.settle();
    assert.equal(calls.length, 1, "the harness's own suggestion wins and costs no model call");

    state.harnessSuggestion = undefined;
    state.current = { ...state.current, text: "my own words", revision: 2 };
    await ui.render();
    await ui.settle();
    assert.equal(calls.length, 1, "a draft in progress is never second-guessed");
    state.current = { ...state.current, text: "", revision: 3 };
    await ui.render();
    await ui.settle();
    assert.equal(calls.length, 2);
    // The server answers for a state this client has not caught up to yet.
    await ui.reply("Commit the fix.", 7);
    assert.deepEqual(offers.at(-1), { sessionId: "s9", text: "Commit the fix." }, "a lagging client still shows the answer");

    state.harnessSuggestion = "Run the suite";
    await ui.render();
    const button = ui.button();
    assert.ok(button);
    await ui.act(async () => { button.click(); });
    assert.deepEqual(calls.at(-1)!.body, { draft: "", regenerate: true }, "the button asks the model again");
    assert.equal(button.disabled, true, "an explicit request shows progress");
    await ui.reply("Open a pull request.", 6);
    assert.deepEqual(offers.at(-1), { sessionId: "s9", text: "Open a pull request.", preferred: true },
      "what the person asked for shows over the harness's hint");
    assert.equal(replacements.length, 0);

    await ui.act(async () => { ui.button()!.click(); });
    await ui.reply("", 6);
    assert.deepEqual(ui.notices.at(-1), { message: "composer.noNextPromptSuggested", kind: "info" },
      "an explicit request with no grounded next step says so");
    state.harnessSuggestion = undefined;

    rememberAssistSettings({ idleSeconds: 120, suggestNextPrompt: false });
    state.events = [...state.events, ...ui.exchange(7, "Thanks.", "Done.")];
    await ui.notify();
    await ui.settle();
    assert.equal(calls.length, 4, "the switch turns automatic suggestions off");

    rememberAssistSettings({ idleSeconds: 120, suggestNextPrompt: true });
    state.assist = { recap: "Added the test.", suggestion: "Tag the release.", atSeq: 100, generatedAt: 1 };
    await ui.notify();
    await ui.settle();
    assert.deepEqual(offers.at(-1), { sessionId: "s9", text: "Tag the release." },
      "the idle recap's suggestion rides on the same chip instead of its own");
    assert.equal(calls.length, 4, "a recap that already suggests costs no extra model call");
    await ui.unmount();
    assert.equal(ui.listeners.size, 0);
  } finally {
    await ui.unmount();
    globalThis.fetch = originalFetch;
    await ui.dom.happyDOM.abort();
  }
});

test("Session Assist first asks despite a harness hint and holds the chip until it answers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = delegatingFetch;
  const { rememberAssistSettings } = await import("../widgets/assistSettings.ts");
  rememberAssistSettings({ idleSeconds: 120, suggestNextPrompt: true, suggestionPriority: "assist" });
  const ui = await composerHarness("s7");
  const { state, calls, offers } = ui;
  try {
    state.events = ui.exchange(1, "Fix the retry.", "Added the missing await.");
    state.harnessSuggestion = "Run the suite";
    state.harnessSuggests = true;
    await ui.render(false);
    await ui.settle();
    assert.equal(calls.length, 1, "no harness grace and no saving: Session Assist asks anyway");
    assert.deepEqual(offers.at(-1), { sessionId: "s7", text: "", preferred: true },
      "the chip is held so the harness hint does not flash up and get replaced");
    await ui.reply("Add a regression test for the retry.", 3);
    assert.deepEqual(offers.at(-1), { sessionId: "s7", text: "Add a regression test for the retry.", preferred: true });

    state.events = [...state.events, ...ui.exchange(4, "Do it.", "Added the test.")];
    await ui.notify();
    await ui.settle();
    assert.equal(calls.length, 2);
    await ui.reply("", 6);
    assert.equal(offers.at(-1), null, "with nothing to say Session Assist gives the chip back to the harness");

    rememberAssistSettings({ idleSeconds: 120, suggestNextPrompt: true, suggestionPriority: "harness" });
    state.events = [...state.events, ...ui.exchange(7, "Thanks.", "Done.")];
    await ui.notify();
    await ui.settle();
    assert.equal(calls.length, 2, "harness first: its hint saves the request again");
  } finally {
    await ui.unmount();
    globalThis.fetch = originalFetch;
    await ui.dom.happyDOM.abort();
  }
});

test("a failed settings load is retried on the next conversation movement", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = delegatingFetch;
  const assistSettingsModule = await import("../widgets/assistSettings.ts");
  const ui = await composerHarness("s5");
  const { state } = ui;
  try {
    // A fresh page: nothing known yet, and the first load fails.
    assistSettingsModule.forgetAssistSettings();
    ui.failSettings(true);
    state.events = ui.exchange(1, "Fix the retry.", "Added the missing await.");
    await ui.render(false);
    await ui.settle(50);
    const failed = ui.settingsRequests();
    assert.ok(failed >= 1, "the source loads the settings itself");
    assert.equal(assistSettingsModule.assistSettings(), null);
    ui.failSettings(false);
    state.events = [...state.events, ...ui.exchange(4, "Do it.", "Added the test.")];
    await ui.notify();
    await ui.settle(50);
    assert.ok(ui.settingsRequests() > failed, "movement asks for the settings again");
    assert.equal(assistSettingsModule.assistSettings()?.suggestNextPrompt, true);
  } finally {
    await ui.unmount();
    globalThis.fetch = originalFetch;
    await ui.dom.happyDOM.abort();
  }
});
