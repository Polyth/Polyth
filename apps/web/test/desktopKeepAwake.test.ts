// Desktop keep-awake through a fake preload bridge: the renderer reports agent
// activity only when it changes, shows main's blocker state as a status-bar
// segment (off / armed / active), and a click toggles the setting. Shells
// without the activity API get nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MutationObserver: dom.MutationObserver,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { installDesktopKeepAwake, KeepAwakeSegment, agentsWorking } = await import("../src/desktopKeepAwake.tsx");
const { listWidgets } = await import("../src/widgets/catalog.ts");
const { setSessions } = await import("../src/store.ts");
type Bridge = import("../src/desktopBridge.ts").PolythDesktopApi;
type KeepAwakeState = import("../src/desktopBridge.ts").DesktopKeepAwakeState;

const PROJECT = "keep-awake-project";
const session = (id: string, status: string) => ({ id, projectId: PROJECT, title: id, status, createdAt: 1, updatedAt: 1 }) as never;

function fakeBridge(initial: KeepAwakeState) {
  let state = initial;
  const activity: boolean[] = [];
  const settings: Array<Record<string, unknown>> = [];
  let push: ((next: KeepAwakeState) => void) | null = null;
  const api = {
    getKeepAwakeState: async () => state,
    setAgentActivity: async (working: boolean) => {
      activity.push(working);
      state = { ...state, working, active: state.enabled && (state.mode === "always" || working) };
      return state;
    },
    onKeepAwakeState: (listener: (next: KeepAwakeState) => void) => { push = listener; return () => { push = null; }; },
    setSettings: async (patch: Record<string, unknown>) => { settings.push(patch); return {} as never; },
  } as unknown as Bridge;
  return { api, activity, settings, emit: (next: KeepAwakeState) => push?.(next) };
}

const flush = async () => { for (let index = 0; index < 4; index += 1) await act(async () => { await Promise.resolve(); }); };

test("a working session is any session running a turn", () => {
  assert.equal(agentsWorking([{ status: "idle" }, { status: "working" }]), true);
  assert.equal(agentsWorking([{ status: "idle" }, { status: "waiting" }]), false, "waiting on the user is not work");
  assert.equal(agentsWorking([]), false);
});

test("older shells without the activity API install nothing", () => {
  const before = listWidgets().length;
  const uninstall = installDesktopKeepAwake({} as Bridge);
  assert.equal(listWidgets().length, before);
  uninstall();
});

test("activity is reported on change only, and the segment follows main's state", async () => {
  setSessions(PROJECT, [session("a", "idle")]);
  const bridge = fakeBridge({ enabled: true, mode: "working", working: false, active: false });
  const uninstall = installDesktopKeepAwake(bridge.api);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    const widget = listWidgets().find((entry) => entry.id === "desktop.keep-awake");
    assert.ok(widget, "the segment is a status-bar widget");
    assert.deepEqual([...(widget.supportedSlots ?? [])], ["app.statusbar.leading", "app.statusbar.trailing"]);
    await act(async () => root.render(createElement(KeepAwakeSegment, { api: bridge.api })));
    await flush();
    assert.deepEqual(bridge.activity, [false], "the first report says no agent works");
    const button = () => container.querySelector<HTMLButtonElement>(".sb-keep-awake")!;
    assert.equal(button().dataset.state, "armed");
    assert.equal(button().textContent, "", "an idle cup has no words");

    await act(async () => setSessions(PROJECT, [session("a", "working")]));
    await flush();
    await act(async () => setSessions(PROJECT, [session("a", "working"), session("b", "working")]));
    await flush();
    assert.deepEqual(bridge.activity, [false, true], "a second working session is not a new report");
    assert.equal(button().dataset.state, "active");
    assert.equal(button().textContent, "Awake");
    assert.match(button().title, /while an agent works/);

    await act(async () => setSessions(PROJECT, [session("a", "idle"), session("b", "idle")]));
    await flush();
    assert.deepEqual(bridge.activity, [false, true, false]);
    assert.equal(button().dataset.state, "armed");

    await act(async () => bridge.emit({ enabled: false, mode: "working", working: false, active: false }));
    assert.equal(button().dataset.state, "off", "a setting changed elsewhere reaches the segment");
    assert.equal(button().getAttribute("aria-pressed"), "false");
    await act(async () => button().click());
    assert.deepEqual(bridge.settings, [{ keepAwake: true }], "a click turns keep-awake on");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    uninstall();
    setSessions(PROJECT, []);
  }
  assert.equal(listWidgets().some((entry) => entry.id === "desktop.keep-awake"), false, "uninstall removes the segment");
});

test("leaving the page while an agent works withdraws the report", async () => {
  setSessions(PROJECT, [session("a", "working")]);
  const bridge = fakeBridge({ enabled: true, mode: "working", working: false, active: false });
  const uninstall = installDesktopKeepAwake(bridge.api);
  await flush();
  assert.deepEqual(bridge.activity, [true]);
  uninstall();
  await flush();
  assert.deepEqual(bridge.activity, [true, false]);
  setSessions(PROJECT, []);
});
