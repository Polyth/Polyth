import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { TaskTrackerTaskDto } from "@polyth/contracts";
import type { WebPackageHost, WidgetPlugin } from "@polyth/web-sdk";
import type { TaskTrackerManagementDto } from "../src/types.ts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return false; },
    }),
  });
}
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: () => undefined,
});
Object.defineProperty(globalThis, "getComputedStyle", {
  configurable: true,
  value: (elt: Element) =>
    (window as unknown as Window).getComputedStyle(elt as never),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("../widgets/api.ts");
const { TaskTrackerManagement } = await import("../widgets/management.tsx");
const { ConnectWizard } = await import("../widgets/connect.tsx");
const { summarizeProgress } = await import("../widgets/overview.tsx");
const { enabledWidgetPlugin, createTaskTrackerInstaller, TASK_TRACKER_WIDGET_PLUGIN } = await import("../widgets/plugin.tsx");
const store = await import("../widgets/store.ts");
const { DEFAULT_TASK_TRACKER_PREFERENCES, mergePreferences } = await import("../src/types.ts");

const settle = async (turns = 3): Promise<void> => {
  for (let index = 0; index < turns; index++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
};

const setControlValue = (control: HTMLInputElement, value: string): void => {
  Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")?.set?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
};

const buttonByText = (root: ParentNode, text: string): HTMLButtonElement | undefined =>
  [...root.querySelectorAll("button")].find((button) => button.textContent?.trim() === text) as HTMLButtonElement | undefined;

const managementState = (overrides: Partial<TaskTrackerManagementDto> = {}): TaskTrackerManagementDto => ({
  preferences: DEFAULT_TASK_TRACKER_PREFERENCES,
  connections: [],
  providers: [
    { provider: "jira", mode: "demo", configured: false, requiredEnv: [], enabled: true, source: "demo" },
    { provider: "trello", mode: "demo", configured: false, requiredEnv: [], enabled: true, source: "demo" },
  ],
  vaultAvailable: true,
  canManage: true,
  ...overrides,
});

async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  await settle();
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("overview progress counts unknown statuses as open work", () => {
  const task = (category: TaskTrackerTaskDto["status"]["category"]) => ({
    status: { id: category, name: category, category },
  }) as TaskTrackerTaskDto;
  const summary = summarizeProgress([task("done"), task("in_progress"), task("unknown"), task("todo")]);
  assert.deepEqual(summary.counts, { todo: 2, in_progress: 1, done: 1 });
  assert.equal(summary.done, 0.25);
  assert.equal(summarizeProgress([]).done, 0);
});

test("widget preferences narrow the registered catalog and the installer follows changes", async () => {
  const narrowed = enabledWidgetPlugin({
    "task-trackers.board": true,
    "task-trackers.linked-task": false,
    "task-trackers.overview": true,
  });
  assert.deepEqual(narrowed.widgets?.map((widget) => widget.id), ["task-trackers.board", "task-trackers.overview"]);

  store.resetManagementForTests();
  const original = api.taskTrackerSettings;
  api.taskTrackerSettings = async () => managementState({
    preferences: mergePreferences(DEFAULT_TASK_TRACKER_PREFERENCES, { widgets: { "task-trackers.overview": false } }),
  });
  const registered: WidgetPlugin[] = [];
  let disposed = 0;
  const host = {
    widgets: { registerPlugin: (plugin: WidgetPlugin) => { registered.push(plugin); return () => { disposed++; }; } },
    ui: { icons: {} },
    errors: { friendly: (action: string) => action },
  } as unknown as WebPackageHost;
  try {
    const dispose = createTaskTrackerInstaller(host)();
    assert.equal(registered[0], TASK_TRACKER_WIDGET_PLUGIN, "the full catalog registers immediately");
    await settle();
    assert.deepEqual(registered.at(-1)?.widgets?.map((widget) => widget.id), ["task-trackers.board", "task-trackers.linked-task"]);
    store.applyManagement(managementState());
    assert.equal(registered.at(-1)?.widgets?.length, 3, "turning a widget back on re-registers it");
    dispose();
    assert.equal(disposed, registered.length);
    store.applyManagement(managementState({
      preferences: mergePreferences(DEFAULT_TASK_TRACKER_PREFERENCES, { widgets: { "task-trackers.board": false } }),
    }));
    assert.equal(disposed, registered.length, "a disposed installer stops following preferences");
  } finally {
    api.taskTrackerSettings = original;
    store.resetManagementForTests();
  }
});

test("management page toggles services, features, and widgets through the settings API", async () => {
  store.resetManagementForTests();
  const originals = { settings: api.taskTrackerSettings, update: api.taskTrackerUpdateSettings };
  const patches: unknown[] = [];
  let current = managementState({
    connections: [{
      provider: "jira",
      method: "api-token",
      account: { name: "Ada Dev", email: "dev@acme.test", site: "https://acme.atlassian.net" },
      connectedAt: Date.now(),
      verifiedAt: Date.now(),
      revision: 1,
    }],
  });
  current.providers[0] = { ...current.providers[0]!, mode: "live", configured: true, source: "connection" };
  api.taskTrackerSettings = async () => current;
  api.taskTrackerUpdateSettings = async (patch) => {
    patches.push(patch);
    current = { ...current, preferences: mergePreferences(current.preferences, patch) };
    return current;
  };
  const view = await mount(createElement(TaskTrackerManagement));
  try {
    const text = view.container.textContent ?? "";
    assert.match(text, /Ada Dev/);
    assert.match(text, /Connected/);
    assert.match(text, /Connect Trello/);
    assert.ok(buttonByText(view.container, "Reconnect"));
    assert.ok(buttonByText(view.container, "Test connection"));

    const trelloSwitch = view.container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Use Trello"]');
    assert.ok(trelloSwitch);
    await act(async () => { trelloSwitch.click(); });
    await settle();
    assert.deepEqual(patches[0], { providers: { trello: false } });
    assert.equal(view.container.querySelector(".tt-service-card.trello .tt-collapse")?.getAttribute("data-open"), "false");

    const switches = [...view.container.querySelectorAll<HTMLButtonElement>('.tt-setting-row [role="switch"]')];
    assert.equal(switches.length, 6, "three features and three widgets");
    await act(async () => { switches[0]!.click(); });
    await settle();
    assert.deepEqual(patches[1], { agentHandoff: false });

    await act(async () => { buttonByText(view.container, "Disconnect")!.click(); });
    assert.match(view.container.textContent ?? "", /Remove the saved credential\?/, "disconnect asks before removing");
    await act(async () => { buttonByText(view.container, "Keep")!.click(); });
    assert.doesNotMatch(view.container.textContent ?? "", /Remove the saved credential\?/);
  } finally {
    await view.unmount();
    api.taskTrackerSettings = originals.settings;
    api.taskTrackerUpdateSettings = originals.update;
    store.resetManagementForTests();
  }
});

test("viewers see management read-only", async () => {
  store.resetManagementForTests();
  const original = api.taskTrackerSettings;
  api.taskTrackerSettings = async () => managementState({ canManage: false, vaultAvailable: false });
  const view = await mount(createElement(TaskTrackerManagement));
  try {
    assert.match(view.container.textContent ?? "", /can view tasks and these settings, but not change them/);
    assert.match(view.container.textContent ?? "", /Credential Vault is off/);
    const switches = [...view.container.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
    assert.ok(switches.length > 0 && switches.every((item) => item.disabled));
    assert.equal(buttonByText(view.container, "Connect Jira"), undefined, "only admins see the shared connect action");
    assert.equal(buttonByText(view.container, "Connect my account"), undefined, "viewers cannot connect accounts");
  } finally {
    await view.unmount();
    api.taskTrackerSettings = original;
    store.resetManagementForTests();
  }
});

test("members connect their own account next to the shared one", async () => {
  store.resetManagementForTests();
  const original = api.taskTrackerSettings;
  const originalDisconnect = api.taskTrackerDisconnect;
  const disconnects: string[] = [];
  const personal = {
    provider: "jira" as const,
    method: "api-token" as const,
    account: { name: "Ada Dev", email: "ada@acme.test", site: "https://acme.atlassian.net" },
    connectedAt: 1,
    verifiedAt: 1,
    revision: 1,
  };
  api.taskTrackerSettings = async () => ({
    ...managementState({ canManage: false }),
    canConnect: true,
    personalConnections: [personal],
  });
  api.taskTrackerDisconnect = async (provider, scope) => {
    disconnects.push(`${provider}:${scope}`);
    return { ...managementState({ canManage: false }), canConnect: true, personalConnections: [] };
  };
  const view = await mount(createElement(TaskTrackerManagement));
  try {
    const text = view.container.textContent ?? "";
    assert.match(text, /Only Space admins change shared settings/);
    assert.match(text, /Your account/);
    assert.match(text, /Ada Dev/);
    assert.equal(buttonByText(view.container, "Connect Jira"), undefined);
    assert.ok(buttonByText(view.container, "Connect my account"), "Trello offers a personal connection");
    const jira = view.container.querySelector('[data-settings-item="task-trackers-jira"] .tt-personal');
    const disconnect = [...(jira?.querySelectorAll("button") ?? [])].find((item) => item.textContent?.trim() === "Disconnect");
    assert.ok(disconnect);
    await act(async () => { (disconnect as HTMLButtonElement).click(); });
    await settle();
    assert.deepEqual(disconnects, ["jira:personal"]);
  } finally {
    await view.unmount();
    api.taskTrackerSettings = original;
    api.taskTrackerDisconnect = originalDisconnect;
    store.resetManagementForTests();
  }
});

test("a personal account toggles per Space and admins set the agent policy", async () => {
  store.resetManagementForTests();
  const originals = {
    settings: api.taskTrackerSettings,
    enabled: api.taskTrackerSetPersonalEnabled,
    policy: api.taskTrackerSetServicePolicy,
  };
  const calls: string[] = [];
  const account = (enabled: boolean) => ({
    id: "jira-1",
    enabled,
    provider: "jira" as const,
    method: "api-token" as const,
    account: { name: "Ada Dev", site: "https://acme.atlassian.net" },
    connectedAt: 1,
    verifiedAt: 1,
    revision: 1,
  });
  const state = (enabled: boolean, agentsMayUseService: boolean) => managementState({
    canConnect: true,
    personalAvailable: true,
    agentsMayUseService,
    personalConnections: [account(enabled)],
  });
  api.taskTrackerSettings = async () => state(false, false);
  api.taskTrackerSetPersonalEnabled = async (id, enabled) => {
    calls.push(`enabled:${id}:${enabled}`);
    return state(enabled, false);
  };
  api.taskTrackerSetServicePolicy = async (value) => {
    calls.push(`policy:${value}`);
    return state(true, value);
  };
  const view = await mount(createElement(TaskTrackerManagement));
  try {
    assert.match(view.container.textContent ?? "", /Off in this Space/);
    const toggle = view.container.querySelector<HTMLButtonElement>('[aria-label="Use Ada Dev in this Space"]');
    assert.equal(toggle?.getAttribute("aria-checked"), "false");
    await act(async () => { toggle!.click(); });
    await settle();
    assert.equal(view.container.querySelector('[aria-label="Use Ada Dev in this Space"]')?.getAttribute("aria-checked"), "true");

    const row = [...view.container.querySelectorAll(".tt-setting-row")]
      .find((item) => /Agents may use the Space account/.test(item.textContent ?? ""));
    const policy = row?.querySelector<HTMLButtonElement>('[role="switch"]');
    assert.equal(policy?.getAttribute("aria-checked"), "false", "off by default");
    await act(async () => { policy!.click(); });
    await settle();
    assert.deepEqual(calls, ["enabled:jira-1:true", "policy:true"]);
  } finally {
    await view.unmount();
    api.taskTrackerSettings = originals.settings;
    api.taskTrackerSetPersonalEnabled = originals.enabled;
    api.taskTrackerSetServicePolicy = originals.policy;
    store.resetManagementForTests();
  }
});

test("Jira wizard normalizes the site, verifies once, and clears the token", async () => {
  store.resetManagementForTests();
  const original = api.taskTrackerConnectJira;
  const calls: Array<{ site: string; email: string; apiToken: string }> = [];
  let reject = true;
  api.taskTrackerConnectJira = async (input) => {
    calls.push(input);
    if (reject) throw new Error("Jira rejected this email and API token");
    return managementState({
      connections: [{
        provider: "jira", method: "api-token",
        account: { name: "Ada Dev", site: "https://acme.atlassian.net" },
        connectedAt: 1, verifiedAt: 1, revision: 1,
      }],
    });
  };
  let closed = false;
  const view = await mount(createElement(ConnectWizard, { provider: "jira", onClose: () => { closed = true; } }));
  try {
    const scope = document.body;
    const site = scope.querySelector<HTMLInputElement>('.tt-wizard input[autocomplete="url"]');
    assert.ok(site);
    assert.equal(buttonByText(scope, "Continue")?.disabled, true);
    await act(async () => { setControlValue(site, "acme"); });
    assert.match(scope.querySelector(".tt-site-preview")?.textContent ?? "", /https:\/\/acme\.atlassian\.net/);
    await act(async () => { buttonByText(scope, "Continue")!.click(); });
    assert.equal(scope.querySelector('.tt-stepper li[aria-current="step"]')?.textContent, "2API token");

    const email = scope.querySelector<HTMLInputElement>('.tt-wizard input[type="email"]')!;
    const token = scope.querySelector<HTMLInputElement>('.tt-wizard input[type="password"]')!;
    await act(async () => {
      setControlValue(email, "dev@acme.test");
      setControlValue(token, "bad-token");
    });
    await act(async () => { buttonByText(scope, "Connect")!.click(); });
    await settle();
    assert.deepEqual(calls[0], { site: "https://acme.atlassian.net", email: "dev@acme.test", apiToken: "bad-token" });
    assert.match(scope.textContent ?? "", /didn’t accept these details/);
    assert.equal(scope.querySelector<HTMLInputElement>('.tt-wizard input[type="password"]')?.value, "", "a failed token is cleared");
    assert.equal(scope.querySelector('.tt-stepper li[aria-current="step"]')?.textContent, "2API token", "failure returns to the token step");

    reject = false;
    await act(async () => { setControlValue(scope.querySelector<HTMLInputElement>('.tt-wizard input[type="password"]')!, "good-token"); });
    await act(async () => { buttonByText(scope, "Connect")!.click(); });
    await settle();
    assert.match(scope.textContent ?? "", /Jira is connected/);
    assert.match(scope.textContent ?? "", /Ada Dev/);
    assert.equal(store.managementSnapshot().data?.connections[0]?.account.name, "Ada Dev", "the shared cache updates");
    await act(async () => { buttonByText(scope, "Done")!.click(); });
    assert.equal(closed, true);
  } finally {
    await view.unmount();
    api.taskTrackerConnectJira = original;
    store.resetManagementForTests();
  }
});
