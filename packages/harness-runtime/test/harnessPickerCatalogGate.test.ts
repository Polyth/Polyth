import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import type { HarnessTransition, SessionEvent } from "@polyth/contracts";
import type { ReactNode } from "react";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  requestAnimationFrame: (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  },
  cancelAnimationFrame: () => {},
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let fetchHandler: typeof fetch = async () => new Response("[]");
globalThis.fetch = ((input, init) => fetchHandler(input, init)) as typeof fetch;

const { act, createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { createRoot } = await import("react-dom/client");
const {
  HarnessTabs,
  HarnessTransitionStatus,
  isVisibleHarnessSwitch,
  transitionStatusMode,
} = await import("../widgets/runtime.tsx");
const { default: harnessWebPackage } = await import("../widgets/index.tsx");
const { invalidateRuntimeCatalogs } = await import("@polyth/models/runtime-catalog");
const { en } = await import("../src/i18n/en.ts");

const snapshot = (id: string, modelID?: string, availability?: Partial<{ state: string; installed: boolean; healthy: boolean; authenticated: boolean }>) => ({
  identity: { id, name: id === "cursor" ? "Cursor" : "Codex" },
  policy: { enabled: true, priority: id === "cursor" ? 20 : 10 },
  availability: {
    state: "ready",
    installed: true,
    healthy: true,
    authenticated: true,
    ...availability,
  },
  ...(modelID ? { catalog: { models: [{ harnessId: id, providerID: id, modelID, name: modelID }] } } : {}),
});

type ShownError = { message: string; action?: { label: string; run(): void | Promise<void> } };

const transition = (patch: Partial<HarnessTransition> = {}): HarnessTransition => ({
  id: "switch-1",
  selection: { mode: "pinned" as const, harnessId: "cursor" },
  targetHarnessId: "cursor",
  timing: "after-turn" as const,
  phase: "requested" as const,
  attempt: 1,
  lastAttemptAt: 1,
  ...patch,
});

test("only a deferred cross-harness request owns a persistent composer status", () => {
  assert.equal(transitionStatusMode(transition(), "codex"), "actionable");
  assert.equal(transitionStatusMode(transition({ targetHarnessId: "codex" }), "codex"), "hidden");
  assert.equal(transitionStatusMode(transition({ timing: "stop-now" }), "codex"), "hidden");
  assert.equal(transitionStatusMode(transition({ phase: "released" }), "codex"), "hidden");
  assert.equal(transitionStatusMode(transition({ phase: "failed" }), "codex"), "actionable");
});

test("same-harness runtime bookkeeping does not render a switch marker", () => {
  assert.equal(isVisibleHarnessSwitch("codex", "codex"), false);
  assert.equal(isVisibleHarnessSwitch("codex", "cursor"), true);
  assert.equal(isVisibleHarnessSwitch("", "cursor"), false);
});

test("native compaction is registered as a full timeline message", async () => {
  type RegisteredSlot = {
    id: string;
    slot: string;
    meta?: Record<string, unknown>;
    render: (props: Record<string, unknown>) => ReactNode;
  };
  const slots: RegisteredSlot[] = [];
  const settingsPages: Array<{ id: string }> = [];
  const host = {
    slots: {
      register: (registration: RegisteredSlot) => {
        slots.push(registration);
        return () => {
          const index = slots.indexOf(registration);
          if (index >= 0) slots.splice(index, 1);
        };
      },
    },
    settings: {
      registerPage: (definition: { id: string }) => {
        const page = { id: definition.id };
        settingsPages.push(page);
        return () => {
          const index = settingsPages.indexOf(page);
          if (index >= 0) settingsPages.splice(index, 1);
        };
      },
      registerItems: () => () => {},
    },
    ui: {
      locale: {
        get: () => "en",
        translate: (key: string) => ({
          "harnessruntime.compaction.ariaLabel": "Context compacted",
          "harnessruntime.compaction.heading": "Context compacted",
          "harnessruntime.compaction.description": "Earlier context was condensed so this conversation can continue.",
        }[key] ?? key),
      },
    },
  } as never;

  const dispose = harnessWebPackage(host)();
  try {
    const registration = slots.find((candidate) =>
      candidate.slot === "session.timeline.event"
      && Array.isArray(candidate.meta?.eventTypes)
      && candidate.meta.eventTypes.includes("session/compacted"));
    assert.ok(registration, "the exported harness package must register a compaction timeline renderer");
    assert.deepEqual(registration.meta?.eventTypes, ["session/compacted"]);

    const event: SessionEvent = {
      id: "compact-1",
      sessionId: "session-1",
      seq: 7,
      time: Date.UTC(2026, 0, 2, 3, 4, 5),
      type: "session/compacted",
      data: { summary: "collapsed-summary-must-not-be-rendered" },
      v: 1,
    };
    const markup = renderToStaticMarkup(registration.render({ event }));
    const rendered = document.createElement("div");
    rendered.innerHTML = markup;
    const marker = rendered.querySelector<HTMLElement>(".pkg-harnesses-compaction-marker");
    const timestamp = rendered.querySelector("time");
    assert.ok(marker, "the registered compaction renderer must render a message surface");
    assert.ok(timestamp, "the registered compaction renderer must render a time element");
    assert.equal(timestamp.getAttribute("datetime"), new Date(event.time).toISOString());
    assert.equal(timestamp.textContent, new Date(event.time).toLocaleTimeString("en", { timeStyle: "short" }));
    assert.equal(marker.getAttribute("data-event-seq"), "7");
    assert.match(rendered.textContent ?? "", /Context compacted/);
    assert.match(rendered.textContent ?? "", /Earlier context was condensed/);
    // The summary mounts only once a reader expands the marker.
    assert.doesNotMatch(rendered.textContent ?? "", /collapsed-summary-must-not-be-rendered/);
  } finally {
    dispose();
  }
  assert.equal(slots.length, 0, "package disposal must unregister every slot contribution");
  assert.equal(settingsPages.length, 0, "package disposal must unregister its settings pages");
});

test("a pending harness choice does not add explanatory copy inside the picker", async () => {
  fetchHandler = async () => new Response(JSON.stringify([snapshot("codex"), snapshot("cursor")]));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host({ value: 0 }), "pending-copy"),
      sessionId: "session-1",
      harnessSelection: { mode: "pinned", harnessId: "codex" },
      pendingHarnessSelection: { mode: "pinned", harnessId: "cursor" },
      onSelectHarness: () => {},
    })); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(container.querySelector(".pkg-harnesses-transition"), null);
    assert.doesNotMatch(container.textContent ?? "", /The model picker follows this route/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("automatic workflow routing does not highlight an arbitrary harness tab", async () => {
  fetchHandler = async () => new Response(JSON.stringify([snapshot("codex"), snapshot("cursor")]));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const KeyboardEventCtor = (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
  const renderAuto = async (projectId: string) => {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host({ value: 0 }), projectId),
      resolvedHarnessId: undefined,
      harnessSelection: { mode: "auto" },
    })); });
    await act(async () => { await Promise.resolve(); });
  };
  try {
    await renderAuto("auto-route");
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('.pkg-harnesses-tablist [role="tab"]')];
    assert.deepEqual(tabs.map((tab) => tab.id.split("-tab-").at(-1)), ["codex", "cursor"],
      "automatic routing renders both loaded enabled harness tabs before selection assertions");
    assert.equal(tabs.length, 2, "automatic routing keeps the complete enabled harness roster rendered");
    const firstEnabled = tabs.find((tab) => !tab.disabled);
    assert.ok(firstEnabled, "the first loaded harness remains enabled");
    assert.equal(firstEnabled, tabs[0], "the first enabled harness is the strip's first keyboard entry");
    assert.equal(firstEnabled.tabIndex, 0, "the first enabled harness remains keyboard-reachable");
    assert.equal(tabs.filter((tab) => tab.tabIndex === 0).length, 1, "the unresolved strip has one keyboard entry point");
    assert.equal(tabs.filter((tab) => tab.getAttribute("aria-selected") === "true").length, 0,
      "Auto routing leaves every rendered harness tab unselected");
    assert.equal(
      container.querySelector<HTMLElement>('.pkg-harnesses-tablist [role="tab"][aria-selected="true"]'),
      null,
      "Auto workflow routing leaves every harness tab unselected until a runtime resolves one",
    );

    await act(async () => {
      tabs[1]!.click();
      await Promise.resolve();
    });
    const selectedAfterClick = container.querySelector<HTMLButtonElement>('.pkg-harnesses-tablist [role="tab"][aria-selected="true"]');
    assert.equal(selectedAfterClick?.id.endsWith("-cursor"), true,
      "Auto routing can explicitly select a rendered harness tab");

    await act(async () => { root.render(null); });
    await renderAuto("auto-route-keyboard");
    const keyboardTabs = [...container.querySelectorAll<HTMLButtonElement>('.pkg-harnesses-tablist [role="tab"]')];
    const keyboardEntry = keyboardTabs.find((tab) => tab.tabIndex === 0);
    assert.equal(keyboardEntry?.id.endsWith("-codex"), true,
      "an unresolved strip enters its first loaded harness through the keyboard");
    await act(async () => {
      keyboardEntry!.dispatchEvent(new KeyboardEventCtor("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    const selectedAfterKeyboardEntry = container.querySelector<HTMLButtonElement>('.pkg-harnesses-tablist [role="tab"][aria-selected="true"]');
    assert.equal(selectedAfterKeyboardEntry?.id.endsWith("-codex"), true, "the keyboard entry can select the first resolved harness explicitly");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

function host(updateCount: { value: number }, shown: ShownError[] = []) {
  return {
    executionDraft: {
      get: () => ({ harnessSelection: { mode: "auto" as const }, harnessSelectionExplicit: false }),
      update: (_projectId: string, value: { harnessSelection: { mode: "pinned"; harnessId: string } }) => {
        updateCount.value++;
        return { ...value, harnessSelectionExplicit: true };
      },
      subscribe: () => () => {},
    },
    errors: {
      friendly: (action: string, cause: unknown) => `${action}: ${cause instanceof Error ? cause.message : String(cause)}`,
      show: (message: string, action?: ShownError["action"]) => shown.push({ message, ...(action ? { action } : {}) }),
    },
    sessions: { upsert: () => {} },
    ui: {
      locale: {
        get: () => "en",
        translate: (key: string, values: Record<string, string | number> = {}) =>
          ((en as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? "")),
      },
    },
  } as never;
}

test("failed harness starts use the host transient error surface", async () => {
  const shown: ShownError[] = [];
  fetchHandler = async () => new Response(JSON.stringify([snapshot("codex"), snapshot("cursor")]));
  const h = host({ value: 0 }, shown);
  const transition = {
    id: "switch-1",
    selection: { mode: "pinned" as const, harnessId: "cursor" },
    targetHarnessId: "cursor",
    timing: "after-turn" as const,
    phase: "failed" as const,
    released: { authorityId: "authority-1", generation: 1, backendSessionId: "native-1" },
    attempt: 1,
    lastAttemptAt: 1,
    error: { stage: "starting-target" as const, message: 'Runtime response was lost for "initialize"' },
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement("div", null,
      createElement(HarnessTransitionStatus, { host: h, sessionId: "session-1", transition }),
      createElement(HarnessTabs, {
        ...props(h, "project-1"),
        sessionId: "session-1",
        harnessSelection: { mode: "pinned", harnessId: "codex" },
        transition,
      }),
    )); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.match(container.textContent ?? "", /Retry Cursor/, "recovery remains available in the model picker");
    assert.deepEqual(shown.map(({ message }) => message), [
      'cursor couldn\'t start: Runtime response was lost for "initialize"',
    ]);
    assert.equal(shown[0]?.action?.label, "Retry");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

const props = (h: ReturnType<typeof host>, projectId: string) => ({
  host: h,
  projectId,
  spaceId: "space-a",
  resolvedHarnessId: "codex",
  projectHarnessDefault: null,
});

const tabProviders = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[role=tab] .provider-logo")].map((logo) => logo.dataset.provider);

test("draft harness selection is synchronous and does not commit a session route", async () => {
  const requests: string[] = [];
  fetchHandler = async (input, init) => {
    const url = new URL(String(input), "http://test");
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    return new Response(JSON.stringify([snapshot("codex"), snapshot("cursor")]));
  };
  const updates = { value: 0 };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host(updates), "session-gate-success"),
      harnessSelection: { mode: "pinned", harnessId: "codex" },
    })); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { container.querySelector<HTMLButtonElement>("[role=tab][id$='-cursor']")?.click(); });
    assert.equal(updates.value, 1);
    assert.equal(requests.some((request) => request.includes("detail=1")), false,
      "the catalog owner, not the tab header, starts metadata discovery after selection rerenders");
    assert.equal(requests.some((request) => request.includes("harnessId=cursor")), false);
    assert.equal(requests.some((request) => request.startsWith("POST /api/harnesses/sessions/")), false);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a controlled no-session picker routes choices to its owner, not the composer draft", async () => {
  fetchHandler = async () => new Response(JSON.stringify([snapshot("codex"), snapshot("cursor")]));
  const updates = { value: 0 };
  const selected: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host(updates), "planned-task"),
      harnessSelection: { mode: "pinned", harnessId: "codex" },
      onSelectHarness: (selection: { mode: "auto" } | { mode: "pinned"; harnessId: string }) => {
        if (selection.mode === "pinned") selected.push(selection.harnessId);
      },
    })); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { container.querySelector<HTMLButtonElement>("[role=tab][id$='-cursor']")?.click(); });
    assert.deepEqual(selected, ["cursor"]);
    assert.equal(updates.value, 0, "the shared composer draft is untouched by a controlled owner");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("active-session tab changes stay local until a message is submitted", async () => {
  const requests: string[] = [];
  fetchHandler = async (input, init) => {
    const url = new URL(String(input), "http://test");
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    return new Response(JSON.stringify([snapshot("codex"), snapshot("cursor")]));
  };
  const updates = { value: 0 };
  const selected: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host(updates), "session-gate"),
      sessionId: "session-1",
      harnessSelection: { mode: "pinned", harnessId: "codex" },
      onSelectHarness: (selection: { mode: "auto" } | { mode: "pinned"; harnessId: string }) => {
        if (selection.mode === "pinned") selected.push(selection.harnessId);
      },
    })); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { container.querySelector<HTMLButtonElement>("[role=tab][id$='-cursor']")?.click(); });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(selected, ["cursor"]);
    assert.equal(requests.some((request) => request.startsWith("POST /api/harnesses/sessions/")), false);
    assert.doesNotMatch(container.textContent ?? "", /Starting Cursor/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("roster tabs stay visible while their availability probes settle", async () => {
  let finishSnapshots!: (value: unknown) => void;
  fetchHandler = async (input) => {
    const url = new URL(String(input), "http://test");
    if (url.pathname === "/api/harnesses/roster") {
      return new Response(JSON.stringify([
        { identity: { id: "codex", name: "Codex", integration: "App Server" }, policy: { enabled: true, priority: 10, autoSelect: true } },
        { identity: { id: "cursor", name: "Cursor", integration: "ACP v1" }, policy: { enabled: true, priority: 20, autoSelect: false } },
      ]));
    }
    return new Response(JSON.stringify(await new Promise((resolve) => { finishSnapshots = resolve; })));
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host({ value: 0 }), "instant-roster"),
      harnessSelection: { mode: "pinned", harnessId: "codex" },
    })); });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(tabProviders(container), ["openai", "cursor"],
      "the enabled roster is visible before slow per-harness probes finish");
  } finally {
    await act(async () => { finishSnapshots([]); });
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a picker whose harness reads never reached Polyth offers a retry instead of a raw toast", { timeout: 20_000 }, async () => {
  const { CONNECTION_RESTORED_EVENT } = await import("@polyth/contracts/transport-retry");
  const shown: ShownError[] = [];
  let linkUp = false;
  fetchHandler = async (input) => {
    // What WKWebView reports when the Polyth Link proxy could not answer.
    if (!linkUp) throw new TypeError("Load failed");
    const url = new URL(String(input), "http://test");
    if (url.pathname === "/api/harnesses/roster") return new Response("[]");
    return new Response(JSON.stringify([snapshot("codex"), snapshot("cursor")]));
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host({ value: 0 }, shown), "link-down"),
      harnessSelection: { mode: "pinned", harnessId: "codex" },
    })); });
    // Let the shared read retry spend its bounded attempts on the dead link.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 4_600)); });
    assert.deepEqual(shown, [], "a lost connection is not toasted as a raw engine message");
    assert.deepEqual(tabProviders(container), []);
    const state = container.querySelector(".pkg-harnesses-picker-retry");
    assert.match(state?.textContent ?? "", /Couldn’t reach Polyth to list harnesses/);
    assert.ok(state?.querySelector("button"), "the empty picker says why and offers Retry");

    linkUp = true;
    await act(async () => {
      window.dispatchEvent(new (dom as unknown as { Event: typeof Event }).Event(CONNECTION_RESTORED_EVENT));
      await Promise.resolve();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.deepEqual(tabProviders(container), ["openai", "cursor"], "a restored connection fills the picker");
    assert.equal(container.querySelector(".pkg-harnesses-picker-retry"), null);
    assert.deepEqual(shown, []);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("only enabled usable harnesses are rendered in the picker", async () => {
  let finishSnapshots!: (value: unknown) => void;
  fetchHandler = async (input) => {
    const url = new URL(String(input), "http://test");
    if (url.pathname === "/api/harnesses/roster") {
      return new Response(JSON.stringify([
        { identity: { id: "codex", name: "Codex", integration: "App Server" }, policy: { enabled: true, priority: 10, autoSelect: true } },
        { identity: { id: "cursor", name: "Cursor", integration: "ACP v1" }, policy: { enabled: true, priority: 20, autoSelect: false } },
        { identity: { id: "grok", name: "Grok", integration: "ACP v1" }, policy: { enabled: true, priority: 25, autoSelect: true } },
        { identity: { id: "claude", name: "Claude", integration: "ACP v1" }, policy: { enabled: false, priority: 30, autoSelect: false } },
        { identity: { id: "gemini", name: "Gemini", integration: "ACP v1" }, policy: { enabled: false, priority: 40, autoSelect: false } },
      ]));
    }
    return new Response(JSON.stringify(await new Promise((resolve) => { finishSnapshots = resolve; })));
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host({ value: 0 }), "snapshot-filter"),
      harnessSelection: { mode: "auto" },
    })); });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(tabProviders(container), ["openai", "cursor", "xai"]);
    await act(async () => {
      finishSnapshots([
        snapshot("codex"),
        snapshot("cursor", undefined, { state: "setup-required", installed: true, healthy: false }),
        { ...snapshot("grok", undefined, { state: "auth-required" }), identity: { id: "grok", name: "Grok" }, policy: { enabled: true, priority: 25 } },
        snapshot("claude", undefined, { state: "not-installed", installed: false, healthy: false }),
        { ...snapshot("gemini"), identity: { id: "gemini", name: "Gemini" }, policy: { enabled: false, priority: 40 } },
      ]);
      await Promise.resolve();
    });
    assert.deepEqual(tabProviders(container), ["openai"],
      "enabled but setup-incomplete or unauthorized harnesses are hidden, not merely disabled; disabled providers stay hidden");
    assert.equal(container.querySelector('[role="tab"][id$="-cursor"]'), null,
      "an unusable harness must not be visible in the picker");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a degraded but installed harness remains manually selectable", async () => {
  fetchHandler = async (input) => {
    const url = new URL(String(input), "http://test");
    if (url.pathname === "/api/harnesses/roster") {
      return new Response(JSON.stringify([
        { identity: { id: "codex", name: "Codex", integration: "App Server" }, policy: { enabled: true, priority: 10, autoSelect: true } },
        { identity: { id: "antigravity", name: "Antigravity", integration: "Gemini" }, policy: { enabled: true, priority: 20, autoSelect: false } },
      ]));
    }
    return new Response(JSON.stringify([
      snapshot("codex"),
      snapshot("antigravity", undefined, { state: "degraded", healthy: true }),
    ]));
  };
  const selected: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host({ value: 0 }), "degraded-manual"),
      harnessSelection: { mode: "pinned", harnessId: "codex" },
      onSelectHarness: (selection: { mode: "auto" } | { mode: "pinned"; harnessId: string }) => {
        if (selection.mode === "pinned") selected.push(selection.harnessId);
      },
    })); });
    await act(async () => { await Promise.resolve(); });
    const target = container.querySelector<HTMLButtonElement>('[role="tab"][id$="-antigravity"]');
    assert.ok(target, "a degraded installed harness remains in the picker");
    assert.equal(target!.disabled, false, "manual selection is not blocked by a transient metadata failure");
    await act(async () => { target!.click(); });
    assert.deepEqual(selected, ["antigravity"]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("an open picker keeps its tabs and selection while invalidated metadata reloads", async () => {
  fetchHandler = async () => new Response(JSON.stringify([snapshot("codex"), snapshot("cursor")]));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const selected = () => [...container.querySelectorAll<HTMLElement>("[role=tab]")]
    .map((tab) => `${tab.id.split("-tab-")[1]}:${tab.getAttribute("aria-selected")}`);
  try {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host({ value: 0 }), "invalidation-hold"),
      harnessSelection: { mode: "pinned", harnessId: "cursor" },
      sessionId: "session-1",
    })); });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(selected(), ["codex:false", "cursor:true"]);

    // A package reconcile or a forced refresh empties the shared caches while
    // the replacement request is still in flight; the harness the user just
    // chose must not lose its highlight until the answer arrives.
    const pending: Array<() => void> = [];
    fetchHandler = async () => new Response(JSON.stringify(await new Promise((resolve) => {
      pending.push(() => resolve([snapshot("codex"), snapshot("cursor")]));
    })));
    await act(async () => { invalidateRuntimeCatalogs(); });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(selected(), ["codex:false", "cursor:true"], "the strip holds its last known rows");
    await act(async () => { pending.forEach((run) => run()); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(selected(), ["codex:false", "cursor:true"]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("reopening the picker reuses cached harness metadata without a loading flash", async () => {
  invalidateRuntimeCatalogs();
  const requests: string[] = [];
  fetchHandler = async (input, init) => {
    const url = new URL(String(input), "http://test");
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    return new Response(JSON.stringify([snapshot("codex"), snapshot("cursor")]));
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host({ value: 0 }), "reopen-cache"),
      harnessSelection: { mode: "pinned", harnessId: "codex" },
    })); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(container.querySelector<HTMLElement>("[aria-busy]")?.getAttribute("aria-busy"), "false");
    assert.ok(requests.length > 0, "the cold picker load should discover its harness metadata");

    await act(async () => { root.render(null); });
    requests.length = 0;
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host({ value: 0 }), "reopen-cache"),
      harnessSelection: { mode: "pinned", harnessId: "codex" },
    })); });

    assert.equal(container.querySelector<HTMLElement>("[aria-busy]")?.getAttribute("aria-busy"), "false");
    assert.equal(requests.length, 0, "reopening a warm picker must not fetch harness metadata");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    invalidateRuntimeCatalogs();
  }
});

test("selected non-executable harness is hidden from the picker", async () => {
  fetchHandler = async (input) => {
    const url = new URL(String(input), "http://test");
    if (url.pathname === "/api/harnesses/roster") {
      return new Response(JSON.stringify([
        { identity: { id: "codex", name: "Codex", integration: "App Server" }, policy: { enabled: true, priority: 10, autoSelect: true } },
        { identity: { id: "cursor", name: "Cursor", integration: "ACP v1" }, policy: { enabled: true, priority: 20, autoSelect: false } },
      ]));
    }
    return new Response(JSON.stringify([
      snapshot("codex"),
      snapshot("cursor", undefined, { state: "setup-required", installed: true, healthy: false }),
    ]));
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host({ value: 0 }), "selected-setup-required"),
      resolvedHarnessId: "cursor",
      harnessSelection: { mode: "pinned", harnessId: "cursor" },
    })); });
    await act(async () => { await Promise.resolve(); });
    assert.deepEqual(tabProviders(container), ["openai"],
      "the resolved but setup-incomplete harness is not rendered");
    assert.equal(container.querySelector('[role="tab"][id$="-cursor"]'), null,
      "an unusable resolved harness must not be visible in the picker");
    const hint = container.querySelector(".pkg-harnesses-picker-state")?.textContent ?? "";
    assert.match(hint, /Choose another harness or open Harnesses in Settings/,
      "a session bound to a hidden harness keeps its recovery path");
    assert.doesNotMatch(container.textContent ?? "", /Cursor/, "the hint does not name the hidden harness");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("the model picker offers no runtime restart for the running harness", async () => {
  fetchHandler = async () => new Response(JSON.stringify([snapshot("codex"), snapshot("cursor")]));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(HarnessTabs, {
      ...props(host({ value: 0 }), "no-restart"),
      sessionId: "session-1",
      harnessSelection: { mode: "pinned", harnessId: "codex" },
    })); });
    await act(async () => { await Promise.resolve(); });
    assert.ok(container.querySelector('[role="tab"][id$="-codex"]'), "the running harness is still offered");
    assert.equal(container.querySelector('button[aria-label="Restart runtime"]'), null, "the picker has no restart control");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
