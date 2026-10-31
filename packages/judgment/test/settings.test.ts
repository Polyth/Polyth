import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { JudgmentSettingsSnapshot } from "../src/settings.ts";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, localStorage: dom.localStorage, getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), ResizeObserver: dom.ResizeObserver });
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("../../models/test/tsxHooks.mjs", import.meta.url);
let handleFetch: (path: string, init?: RequestInit) => Promise<Response> = async () => { throw new Error("Unexpected request"); };
globalThis.fetch = (input, init) => handleFetch(String(input), init);
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: JudgmentSettings } = await import("../widgets/JudgmentSettings.tsx");
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
const snapshot = (enabled = true): JudgmentSettingsSnapshot => ({
  revision: 1, global: { enabled }, engineId: "dedicated", engines: [{ id: "dedicated", name: "Dedicated Judgment engine", recommended: true }],
  defaultTarget: { engineId: "dedicated", providerId: "test-provider", modelId: "test-model" },
  providers: [{ provider: { id: "test-provider", name: "Test Provider" }, status: "available", models: [{ providerID: "test-provider", modelID: "test-model", name: "Test Model", connected: true }] }],
  engineSettings: { handles: [{ handle: "KEY", label: "Saved credential" }], secretHandle: "KEY" },
});
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

test("settings discard a stale project load and save canonical config without a session model", async () => {
  let resolveA!: (response: Response) => void;
  const calls: Array<{ path: string; body?: unknown }> = [];
  let state = snapshot(false);
  handleFetch = async (path, init) => {
    calls.push({ path, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (path.includes("projectId=a")) return new Promise((resolve) => { resolveA = resolve; });
    if (init?.method === "PUT") {
      const body = JSON.parse(init.body as string);
      assert.equal(body.level, "global"); assert.equal(body.revision, 1);
      assert.deepEqual(body.config, { enabled: true });
      state = { ...state, revision: 2, global: body.config };
    }
    return json(state);
  };
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(JudgmentSettings, { projectId: "a", openVault() {} })); });
    await act(async () => { root.render(createElement(JudgmentSettings, { projectId: "b", openVault() {} })); });
    await act(async () => { await pause(); });
    await act(async () => { resolveA(json(snapshot(true))); await pause(); });
    const toggle = container.querySelector('[role="switch"]') as HTMLButtonElement;
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    assert.equal(container.textContent?.includes("Dedicated Judgment engine"), true);
    assert.equal(container.querySelectorAll('[aria-label="Judgment engine"]').length, 0, "the only engine is informational");
    await act(async () => { toggle.click(); await pause(); });
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    assert.equal(calls.filter((call) => call.body).length, 1);
    assert.ok(calls.every((call) => call.path.startsWith("/api/judgment/")));
    assert.doesNotMatch(JSON.stringify(calls), /harness|session|apiKey/);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("authentication-required, unsupported, loading and error states are explicit", async () => {
  const state = snapshot();
  state.providers[0]!.status = "authentication-required";
  state.providers.push({ provider: { id: "unsupported", name: "Other Provider" }, status: "unsupported", models: [] });
  state.engineSettings = { handles: [{ handle: "KEY", label: "Saved credential" }] };
  const calls: Array<{ path: string; body?: unknown }> = [];
  handleFetch = async (path, init) => {
    calls.push({ path, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return json(state);
  };
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(JudgmentSettings, { projectId: "a", openVault() {} })); });
    await act(async () => { await pause(); });
    assert.match(container.textContent ?? "", /Needs setup/);
    assert.match(container.textContent ?? "", /Not connected/);
    assert.match(container.textContent ?? "", /Unsupported by this engine/);
    const radios = [...container.querySelectorAll('[role="radiogroup"] input[type="radio"]')] as HTMLInputElement[];
    assert.equal(radios.length, 3, "Automatic plus every reported provider");
    assert.equal(radios[2]!.disabled, true, "an unsupported provider is shown but cannot be chosen");
    const check = [...container.querySelectorAll("button")].find((button) => button.textContent === "Test connection") as HTMLButtonElement;
    assert.equal(check.disabled, true, "nothing can be checked before a credential is connected");
    // The effective provider needs a credential, so its Vault picker is already open.
    const credential = container.querySelector('[aria-label="Test Provider credential"]') as HTMLButtonElement;
    assert.ok(credential);
    await act(async () => { credential.click(); await pause(); });
    const option = [...document.querySelectorAll('[role="option"]')].find((row) => row.textContent?.includes("Saved credential")) as HTMLElement;
    await act(async () => { option.click(); await pause(); });
    assert.deepEqual(calls.at(-1), { path: "/api/judgment/credential?projectId=a", body: { providerId: "test-provider", secretHandle: "KEY" } });
    assert.doesNotMatch(JSON.stringify(calls), /apiKey|secret"/);
    handleFetch = async () => { throw new Error("test transport failure"); };
    await act(async () => { root.render(createElement(JudgmentSettings, { projectId: "b", openVault() {} })); });
    await act(async () => { await pause(); });
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /Could not load/);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("choosing a route clears the model override and Check reports the answering route", async () => {
  let state = snapshot();
  state.global = { enabled: true, modelId: "test-model" };
  state.defaultModels = { "test-provider": "test-model", free: "free-model" };
  state.providers.push({ provider: { id: "free", name: "Free Route" }, status: "available", credential: "none", endpoint: "free.example",
    description: "No key needed.", models: [{ providerID: "free", modelID: "free-model", name: "Free Model", connected: true }] });
  const calls: Array<{ path: string; body?: unknown }> = [];
  handleFetch = async (path, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, body });
    if (path.startsWith("/api/judgment/check")) return json({ ok: true, engineId: "dedicated", providerId: "free", modelId: "free-model-2", durationMs: 412, checkedAt: 1 });
    if (init?.method === "PUT") state = { ...state, global: body.config, revision: state.revision + 1 };
    return json(state);
  };
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(JudgmentSettings, { projectId: "a", openVault() {} })); });
    await act(async () => { await pause(); });
    const free = [...container.querySelectorAll(".judgment-route")].find((row) => row.textContent?.includes("Free Route"))!;
    assert.match(free.textContent ?? "", /Free/);
    assert.equal(free.querySelector('[aria-expanded]'), null, "a keyless route offers no credential control");
    await act(async () => { (free.querySelector('input[type="radio"]') as HTMLInputElement).click(); await pause(); });
    assert.deepEqual(calls.at(-1)!.body, { level: "global", revision: 1, config: { enabled: true, providerId: "free" } });
    assert.match(container.textContent ?? "", /without an account/);
    assert.match(container.querySelector(".judgment-status")?.textContent ?? "", /Free Route.*Free Model · free\.example/);
    const check = [...container.querySelectorAll("button")].find((button) => button.textContent === "Test connection") as HTMLButtonElement;
    await act(async () => { check.click(); await pause(); });
    assert.equal(calls.at(-1)!.path, "/api/judgment/check?projectId=a");
    assert.match(container.querySelector('[role="status"]')?.textContent ?? "", /Answered in 412 ms by free-model-2 via Free Route/);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("automatic model clears only the explicit Judgment model override", async () => {
  let state = snapshot();
  state.global = { enabled: true, providerId: "test-provider", modelId: "test-model" };
  handleFetch = async (_path, init) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(init.body as string);
      assert.deepEqual(body.config, { enabled: true, providerId: "test-provider" });
      state = { ...state, global: body.config, revision: 2 };
    }
    return json(state);
  };
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(JudgmentSettings, { projectId: "a", openVault() {} })); });
    await act(async () => { await pause(); });
    const automatic = [...container.querySelectorAll("button")].find((button) => button.textContent === "Use automatic model")!;
    assert.ok(automatic);
    await act(async () => { automatic.click(); await pause(); });
    assert.equal(state.revision, 2);
    assert.match(container.textContent ?? "", /Automatic · Test Model/);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

const uses = (): NonNullable<JudgmentSettingsSnapshot["uses"]> => [
  { id: "demo.check", packageId: "demo", title: "Completion check", description: "Asks whether the work is done.", effect: "Shows a hint before closing.",
    scope: "demo.check.v1", evidence: "short", defaultEnabled: false, params: [
      { id: "threshold", kind: "probability", label: "Confidence", default: 0.6 },
      { id: "limit", kind: "integer", label: "Limit", min: 1, max: 10, default: 3, unit: "items" },
      { id: "strict", kind: "boolean", label: "Strict", default: false },
      { id: "mode", kind: "choice", label: "Mode", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }], default: "a" },
      { id: "note", kind: "text", label: "Note", maxLength: 20, default: "" },
    ] },
  { id: "demo.review", packageId: "demo", title: "Review verdict", description: "Reads a review.", effect: "Routes it to a person.",
    scope: "demo.review.v1", evidence: "long", defaultEnabled: true, params: [] },
];
const mount = async (state: () => JudgmentSettingsSnapshot, calls: Array<{ path: string; body?: any }>, reply?: (body: any) => Response | undefined) => {
  let current = state();
  handleFetch = async (path, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, body });
    if (init?.method === "PUT") {
      const rejected = reply?.(body);
      if (rejected) return rejected;
      current = { ...current, revision: current.revision + 1, ...(body.level === "global" ? { global: body.config } : { project: body.config }) };
    }
    return json(current);
  };
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(JudgmentSettings, { projectId: "a", openVault() {} })); });
  await act(async () => { await pause(); });
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
};
const card = (container: Element, title: string) => [...container.querySelectorAll(".judgment-use")].find((row) => row.textContent?.includes(title)) as HTMLElement;
const puts = (calls: Array<{ body?: any }>) => calls.filter((call) => call.body);

test("uses render from the snapshot and the switch saves the full config", async () => {
  const calls: Array<{ path: string; body?: any }> = [];
  const { container, unmount } = await mount(() => ({ ...snapshot(), uses: uses() }), calls);
  try {
    const first = card(container, "Completion check"), second = card(container, "Review verdict");
    assert.match(first.textContent ?? "", /Fits local model/);
    assert.match(first.textContent ?? "", /What Polyth does/);
    assert.doesNotMatch(second.textContent ?? "", /local model|hosted model/, "a long-evidence use on a hosted route needs no pill");
    assert.equal(first.querySelector('[role="switch"]')!.getAttribute("aria-checked"), "false", "defaultEnabled is the fallback");
    assert.equal(second.querySelector('[role="switch"]')!.getAttribute("aria-checked"), "true");
    assert.equal(first.querySelector("[aria-expanded]"), null, "options only exist for a use that is on");
    await act(async () => { (first.querySelector('[role="switch"]') as HTMLButtonElement).click(); await pause(); });
    assert.deepEqual(puts(calls).at(-1)!.body, { level: "global", revision: 1, config: { enabled: true, uses: { "demo.check": { enabled: true } } } });
    const toggle = card(container, "Completion check").querySelector("[aria-expanded]") as HTMLButtonElement;
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    await act(async () => { toggle.click(); });
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    const labels = [...card(container, "Completion check").querySelectorAll(".set-row-label")].map((node) => node.textContent);
    assert.deepEqual(labels, ["Confidence", "Limit", "Strict", "Mode", "Note", "Model"]);
    assert.ok(container.querySelector('[aria-label="Completion check: Limit (items)"]'));
    assert.equal(container.querySelectorAll('[aria-label="Completion check: Mode"] button').length, 2, "two options use a segmented control");
  } finally { await unmount(); }
});

test("a long-evidence use warns only when the route it would use runs locally", async () => {
  const calls: Array<{ path: string; body?: any }> = [];
  const local = (): JudgmentSettingsSnapshot => { const base = snapshot(); return { ...base, providers: base.providers.map((entry) => ({ ...entry, local: true })), uses: uses() }; };
  const { container, unmount } = await mount(local, calls);
  try {
    assert.match(card(container, "Review verdict").textContent ?? "", /Needs a hosted model/);
    assert.match(card(container, "Completion check").textContent ?? "", /Fits local model/);
    const toggle = card(container, "Review verdict").querySelector("[aria-expanded]") as HTMLButtonElement;
    assert.equal(toggle.getAttribute("aria-label"), "Review verdict options", "each disclosure names its use");
  } finally { await unmount(); }
});

test("parameter edits are debounced, saved with their kind's value and server errors are shown", async () => {
  const calls: Array<{ path: string; body?: any }> = [];
  let reject = false;
  const { container, unmount } = await mount(() => ({ ...snapshot(), global: { enabled: true, uses: { "demo.check": { enabled: true } } }, uses: uses() }), calls,
    () => reject ? new Response(JSON.stringify({ message: "Invalid value for Completion check: Note" }), { status: 400, headers: { "content-type": "application/json" } }) : undefined);
  try {
    await act(async () => { (card(container, "Completion check").querySelector("[aria-expanded]") as HTMLButtonElement).click(); });
    const note = container.querySelector('input[aria-label="Completion check: Note"]') as HTMLInputElement;
    assert.equal(note.maxLength, 20);
    const setValue = (value: string) => { const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!; setter.call(note, value); note.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event); };
    await act(async () => { setValue("h"); setValue("he"); setValue("hey"); await pause(); });
    assert.equal(puts(calls).length, 0, "typing does not save until it settles");
    assert.equal((container.querySelector('input[aria-label="Completion check: Note"]') as HTMLInputElement), note, "the field keeps its identity");
    await act(async () => { note.dispatchEvent(new dom.FocusEvent("focusout", { bubbles: true }) as unknown as Event); await pause(); });
    assert.equal(puts(calls).length, 1, "blur flushes one save");
    assert.deepEqual(puts(calls)[0]!.body.config.uses["demo.check"], { enabled: true, params: { note: "hey" } });
    const strict = container.querySelector('[role="switch"][aria-label="Completion check: Strict"]') as HTMLButtonElement;
    await act(async () => { strict.click(); await new Promise((resolve) => setTimeout(resolve, 60)); });
    assert.deepEqual(puts(calls).at(-1)!.body.config.uses["demo.check"].params, { note: "hey", strict: true });
    reject = true;
    const beta = [...container.querySelectorAll('[aria-label="Completion check: Mode"] button')].find((button) => button.textContent === "Beta") as HTMLButtonElement;
    await act(async () => { beta.click(); await new Promise((resolve) => setTimeout(resolve, 60)); });
    assert.match(container.querySelector(".judgment-uses-error")?.textContent ?? "", /Invalid value for Completion check: Note/);
  } finally { await unmount(); }
});

test("project level shows inherited versus overridden uses and resets the override", async () => {
  const calls: Array<{ path: string; body?: any }> = [];
  const { container, unmount } = await mount(() => ({ ...snapshot(), global: { enabled: true, uses: { "demo.check": { enabled: true } } },
    project: { uses: { "demo.review": { enabled: false } } }, uses: uses() }), calls);
  try {
    await act(async () => { ([...container.querySelectorAll(".seg button")].find((button) => button.textContent === "This project") as HTMLButtonElement).click(); });
    const inherited = card(container, "Completion check"), overridden = card(container, "Review verdict");
    assert.match(inherited.textContent ?? "", /Same as all projects/);
    assert.equal(inherited.querySelector('[role="switch"]')!.getAttribute("aria-checked"), "true");
    assert.match(overridden.textContent ?? "", /Set for this project/);
    assert.equal(overridden.querySelector('[role="switch"]')!.getAttribute("aria-checked"), "false");
    const reset = [...overridden.querySelectorAll("button")].find((button) => /all projects/.test(button.textContent ?? "")) as HTMLButtonElement;
    await act(async () => { reset.click(); await pause(); });
    assert.deepEqual(puts(calls).at(-1)!.body, { level: "project", revision: 1, config: {} });
    assert.match(card(container, "Review verdict").textContent ?? "", /Same as all projects/);
    assert.equal(card(container, "Review verdict").querySelector('[role="switch"]')!.getAttribute("aria-checked"), "true");
  } finally { await unmount(); }
});

test("uses are disabled while Judgment is off and an empty registry says so", async () => {
  const calls: Array<{ path: string; body?: any }> = [];
  const off = await mount(() => ({ ...snapshot(false), uses: uses() }), calls);
  try {
    assert.match(off.container.textContent ?? "", /Judgment is off, so these features/);
    assert.equal(off.container.querySelector(".judgment-uses")!.hasAttribute("data-off"), true);
    for (const row of off.container.querySelectorAll(".judgment-use [role=\"switch\"]")) assert.equal((row as HTMLButtonElement).disabled, true);
    assert.equal(off.container.querySelector(".judgment-use [aria-expanded]"), null);
  } finally { await off.unmount(); }
  const empty = await mount(() => ({ ...snapshot(), uses: [] }), calls);
  try {
    assert.match(empty.container.textContent ?? "", /Features that can use Judgment appear here when their packages are enabled/);
  } finally { await empty.unmount(); }
});
