// Every action is its own rail launcher: one `command` capability per action
// with the action's glyph, available only where the action applies, that
// runs in the active project on a press, follows renames in place and leaves
// with its action. A press from a rail floats its result in a card.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { CapabilityDefinition, WebPackageHost } from "@polyth/web-sdk";
import type { ActionRunDto, CustomActionDto } from "../src/actionModel.ts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  CustomEvent: dom.CustomEvent,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

// ---- fake server (installed before any module captures fetch) ----------------------

const action = (id: string, over: Partial<CustomActionDto> = {}): CustomActionDto => ({
  id, name: id, command: "true", icon: "rocket", color: "blue", mode: "background", projectId: null,
  chat: null, createdAt: 1, updatedAt: 1, ...over,
} as unknown as CustomActionDto);

let actions: CustomActionDto[] = [];
let runs: ActionRunDto[] = [];
const runCalls: Array<{ actionId: string; body: Record<string, unknown> }> = [];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

(globalThis as { fetch?: unknown }).fetch = async (input: string, init?: { method?: string; body?: string }) => {
  const url = new URL(String(input), "http://127.0.0.1:4400");
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : {};
  if (url.pathname === "/api/custom-action/actions" && method === "GET") {
    return json({ actions, canManage: true, canRun: true, canChat: true, blocked: null });
  }
  const run = url.pathname.match(/^\/api\/custom-action\/actions\/([^/]+)\/run$/);
  if (run && method === "POST") {
    runCalls.push({ actionId: run[1]!, body });
    const dto = {
      id: `r${runCalls.length}`, actionId: run[1]!, projectId: String(body.projectId), sessionId: (body.sessionId as string) ?? null,
      name: run[1]!, icon: "rocket", color: "blue", mode: "background", status: "running", phase: "command",
      exitCode: null, startedAt: Date.now(), finishedAt: null, chatSessionId: null, chatSkipped: false,
      error: null, outputEnd: 0, truncated: false,
    } as ActionRunDto;
    runs = [dto, ...runs];
    return json({ run: dto, joined: false });
  }
  if (url.pathname === "/api/custom-action/runs") return json({ runs });
  const output = url.pathname.match(/^\/api\/custom-action\/runs\/([^/]+)\/output$/);
  if (output) {
    const dto = runs.find((item) => item.id === output[1]);
    return json({ run: dto, command: "make deploy", start: 0, end: 30, text: "building\r\n\r\n\u001b[32mdeployed v42\u001b[0m\r\n" });
  }
  return json({});
};

const { act, createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { announceCreated, createdNotificationId, installActionLaunchers, actionCapabilityId, railState, setOnRail } = await import("../widgets/railLaunchers.tsx");
const { setActionHost } = await import("../widgets/host.ts");
const { dismissCard, getSnapshot, pollRuns, refresh, resetActionStore } = await import("../widgets/store.ts");
const { default: ResultCards, outputTail, cardFadesOut, resultNotificationId } = await import("../widgets/ResultCards.tsx");
const { notifications, getNotifications } = await import("../../../apps/web/src/notify/store.ts");
const { default: NotificationStack } = await import("../../../apps/web/src/notify/NotificationStack.tsx");
const { createRoot } = await import("react-dom/client");
const { default: AlertDialog } = await import("../../../apps/web/src/components/AlertDialog.tsx");
const { resolveAlert } = await import("../../../apps/web/src/alerts.ts");

// ---- host ----------------------------------------------------------------------------

const capabilities = new Map<string, CapabilityDefinition>();
let notified = 0;
const focused: string[] = [];
const notices: string[] = [];
let state = { activeProjectId: "p1" as string | null, activeSessionId: "s1" as string | null };
const storeListeners = new Set<() => void>();
const host = {
  capabilities: {
    register: (definition: CapabilityDefinition) => {
      capabilities.set(definition.id, definition);
      return () => { if (capabilities.get(definition.id) === definition) capabilities.delete(definition.id); };
    },
    notify: () => { notified += 1; },
  },
  store: {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { storeListeners.add(listener); return () => { storeListeners.delete(listener); }; },
  },
  navigation: { openWorkspacePane: (id: string) => { focused.push(id); return true; } },
  conversation: { openSession: async () => {} },
  errors: { friendly: (text: string) => text, show: (text: string) => { notices.push(text); } },
  notifications,
} as unknown as WebPackageHost;
setActionHost(host);

const placed = new Map<string, boolean>();
(host as unknown as { capabilities: Record<string, unknown> }).capabilities = {
  ...(host as unknown as { capabilities: Record<string, unknown> }).capabilities,
  placement: (id: string) => ({ tier: placed.get(id) ? "more" : "technical", onRail: placed.get(id) === true }),
  place: (id: string, tier: string) => { placed.set(id, tier !== "technical"); },
};

const setProject = (projectId: string | null) => {
  state = { ...state, activeProjectId: projectId };
  for (const listener of storeListeners) listener();
};
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

test("one command launcher per action, with its own mark, scoped to its project", async () => {
  actions = [action("deploy"), action("lint", { projectId: "p2", icon: "bug" })];
  const dispose = installActionLaunchers(host);
  try {
    await refresh();
    assert.deepEqual([...capabilities.keys()].sort(), [actionCapabilityId("deploy"), actionCapabilityId("lint")]);
    const deploy = capabilities.get(actionCapabilityId("deploy"))!;
    assert.equal(deploy.kind, "command");
    assert.equal(deploy.label, "deploy");
    assert.equal(deploy.standardTier, "technical");
    assert.equal(deploy.legacyStandardTier, "more");
    assert.ok(deploy.icon, "the action's glyph is the launcher mark");
    const mark = renderToStaticMarkup(createElement(deploy.icon!, { size: 15, strokeWidth: 1.8 }));
    assert.match(mark, /^<svg[^>]*class="[^"]*ca-rail-mark/, "the glyph SVG itself, so rails size it as their direct svg child");
    assert.doesNotMatch(mark, /ca-rail-mark-badge/, "an idle action shows no dot");

    const lint = capabilities.get(actionCapabilityId("lint"))!;
    assert.equal(deploy.available(), true, "Space-wide action is available everywhere");
    assert.equal(lint.available(), false, "a project action stays off other projects' rails");
    const before = notified;
    setProject("p2");
    assert.ok(notified > before, "a project switch re-asks availability");
    assert.equal(lint.available(), true);
    setProject(null);
    assert.equal(deploy.available(), false, "no project, nothing to run in");
  } finally {
    dispose();
    resetActionStore();
    setProject("p1");
  }
  assert.equal(capabilities.size, 0, "disposal removes every launcher");
});

test("a press runs in the active project and chat; a busy action shows its result card instead", async () => {
  actions = [action("deploy")];
  runs = [];
  runCalls.length = 0;
  const dispose = installActionLaunchers(host);
  try {
    await refresh();
    const deploy = capabilities.get(actionCapabilityId("deploy"))!;
    deploy.open();
    await settle();
    assert.equal(runCalls.length, 1);
    assert.equal(runCalls[0]!.body.projectId, "p1");
    assert.equal(runCalls[0]!.body.sessionId, "s1");
    assert.match(renderToStaticMarkup(createElement(deploy.icon!, {})), /data-tone="busy"/);
    assert.deepEqual(getSnapshot().cards, ["r1"], "the run floats in a result card");

    dismissCard("r1");
    deploy.open();
    await settle();
    assert.equal(runCalls.length, 1, "a second press while running does not start another run");
    assert.deepEqual(getSnapshot().cards, ["r1"], "it brings the running result card back");
    assert.deepEqual(focused, [], "and opens no pane");
  } finally {
    dispose();
    resetActionStore();
    focused.length = 0;
  }
});

test("an action that asks before running runs only after the person agrees", async () => {
  actions = [action("deploy", { confirm: { message: "" }, command: "make deploy\nmake smoke" }), action("ship", { confirm: { message: "Ships to production." } })];
  runs = [];
  runCalls.length = 0;
  const dispose = installActionLaunchers(host);
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  try {
    await refresh();
    await act(async () => { root.render(createElement(AlertDialog)); });
    const deploy = capabilities.get(actionCapabilityId("deploy"))!;
    deploy.open();
    await settle();
    assert.equal(runCalls.length, 0, "nothing runs while the confirmation is open");
    assert.match(document.body.textContent ?? "", /Run “deploy”\?/);
    assert.equal(document.querySelector(".alert-dialog-body p")?.textContent, "This runs:\nmake deploy\nmake smoke", "the default text quotes the command");
    assert.equal(document.querySelector(".alert-confirm")?.textContent, "Run");

    await act(async () => { resolveAlert(false); });
    await settle();
    assert.equal(runCalls.length, 0, "declining runs nothing");
    assert.equal(getSnapshot().launches["deploy@p1"], undefined, "and leaves no launch feedback behind");

    deploy.open();
    await settle();
    await act(async () => { (document.querySelector(".alert-confirm") as HTMLElement).click(); });
    await settle();
    assert.equal(runCalls.length, 1, "agreeing runs it");
    assert.equal(document.querySelector(".alert-dialog-body"), null, "and closes the confirmation");

    deploy.open();
    await settle();
    assert.equal(document.querySelector(".alert-dialog-body"), null, "rejoining the run in progress starts nothing, so it does not ask");
    assert.equal(runCalls.length, 1);

    capabilities.get(actionCapabilityId("ship"))!.open();
    await settle();
    assert.equal(document.querySelector(".alert-dialog-body p")?.textContent, "Ships to production.", "the person's own message replaces the default");
    await act(async () => { resolveAlert(false); });
  } finally {
    await act(async () => { root.unmount(); });
    mount.remove();
    dispose();
    resetActionStore();
  }
});

test("renames replace the launcher in place; a deleted action takes its launcher with it", async () => {
  actions = [action("deploy"), action("lint")];
  const dispose = installActionLaunchers(host);
  try {
    await refresh();
    const first = capabilities.get(actionCapabilityId("deploy"))!;
    actions = [action("deploy", { name: "Ship it" })];
    await refresh();
    const renamed = capabilities.get(actionCapabilityId("deploy"))!;
    assert.notEqual(renamed, first);
    assert.equal(renamed.label, "Ship it");
    assert.equal(renamed.icon, first.icon, "the same mark component, so the rail does not remount it");
    assert.equal(capabilities.has(actionCapabilityId("lint")), false);
  } finally {
    dispose();
    resetActionStore();
  }
});

test("a result notification shows the live run, then how it ended; a failure raises no second notice", async () => {
  actions = [action("deploy")];
  runs = [];
  runCalls.length = 0;
  notices.length = 0;
  const dispose = installActionLaunchers(host);
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  try {
    await refresh();
    await act(async () => { root.render(createElement("div", null, createElement(ResultCards), createElement(NotificationStack))); });
    assert.equal(document.querySelector(".notify-card"), null, "nothing on screen before a press");

    capabilities.get(actionCapabilityId("deploy"))!.open();
    await settle();
    await settle();
    const card = document.querySelector(".notify-card[data-custom-action-run]")!;
    assert.ok(card, "the run is a notification of the host stack");
    assert.equal(card.getAttribute("data-tone"), "running");
    assert.equal(card.getAttribute("data-kind"), "progress");
    assert.match(card.querySelector(".notify-title")!.textContent!, /deploy/);
    assert.match(card.querySelector(".notify-excerpt")!.textContent!, /^building\ndeployed v42$/, "plain last lines, colours and blank lines dropped");
    assert.ok([...card.querySelectorAll("button")].some((button) => /Stop/i.test(button.textContent ?? "")), "a running run can be stopped");
    assert.equal(card.querySelector(".notify-life"), null, "a running result does not count down");

    runs = runs.map((run) => ({ ...run, status: "failed", exitCode: 2, finishedAt: Date.now() }));
    await act(async () => { await pollRuns(); });
    await settle();
    assert.equal(card.getAttribute("data-tone"), "danger");
    assert.equal(card.getAttribute("data-kind"), "error");
    assert.equal(card.getAttribute("role"), "group", "the stack announces it; the card is no live region");
    assert.equal(card.querySelector(".notify-life"), null, "a failure stays until it is closed");
    assert.deepEqual(notices, [], "the notification already says it failed");
    assert.equal(getSnapshot().seen.has("r1"), false);

    await act(async () => { (card.querySelector(".notify-close") as HTMLElement).click(); });
    await settle();
    assert.deepEqual(getSnapshot().cards, [], "closing removes the card");
    assert.equal(getSnapshot().seen.has("r1"), true, "and counts the result as seen");
    assert.equal(document.querySelector(".notify-card"), null);
    assert.equal(getNotifications().items.some((item) => item.id === resultNotificationId("r1")), false);
  } finally {
    await act(async () => { root.unmount(); });
    mount.remove();
    dispose();
    resetActionStore();
  }
});

test("a finished success starts its countdown on the same notification", async () => {
  actions = [action("deploy")];
  runs = [];
  const dispose = installActionLaunchers(host);
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  try {
    await refresh();
    await act(async () => { root.render(createElement("div", null, createElement(ResultCards), createElement(NotificationStack))); });
    capabilities.get(actionCapabilityId("deploy"))!.open();
    await settle();
    await settle();
    runs = runs.map((run) => ({ ...run, status: "succeeded", exitCode: 0, finishedAt: Date.now() }));
    await act(async () => { await pollRuns(); });
    await settle();
    const cards = document.querySelectorAll(".notify-card[data-custom-action-run]");
    assert.equal(cards.length, 1, "updated in place, not a second card");
    assert.equal(cards[0]!.getAttribute("data-kind"), "success");
    assert.ok(cards[0]!.querySelector(".notify-life"), "a success shows its remaining life");
    const record = getNotifications().items.find((item) => item.id === resultNotificationId(runs[0]!.id));
    assert.equal(record?.duration, 6_000);
  } finally {
    await act(async () => { root.unmount(); });
    mount.remove();
    dispose();
    resetActionStore();
  }
});

test("only a finished success fades out by itself; the tail keeps the newest lines", () => {
  const run = (status: string) => ({ status } as unknown as ActionRunDto);
  assert.equal(cardFadesOut(run("succeeded")), true);
  assert.equal(cardFadesOut(run("stopped")), true);
  for (const status of ["running", "failed", "error", "timed-out"]) assert.equal(cardFadesOut(run(status)), false, status);
  assert.equal(outputTail(Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join("\n")), "line 5\nline 6\nline 7\nline 8\nline 9");
  assert.equal(outputTail("progress 10%\rprogress 100%\n"), "progress 100%", "carriage-return progress collapses");
  assert.equal(outputTail("\n  \n"), "");
});

test("a launcher is opt-in: every action waits under Technical and carries its legacy tier", async () => {
  actions = [action("old"), action("fresh")];
  const dispose = installActionLaunchers(host);
  try {
    await refresh();
    for (const id of ["old", "fresh"]) {
      const capability = capabilities.get(actionCapabilityId(id))!;
      assert.equal(capability.standardTier, "technical");
      assert.equal(capability.legacyStandardTier, "more", "projects that already showed it keep it on the right rail");
    }
  } finally {
    dispose();
    resetActionStore();
  }
});

test("Add to rail / Remove from rail go through the host placement seam", () => {
  placed.clear();
  assert.equal(railState(host, "fresh"), false);
  setOnRail(host, "fresh", true);
  assert.equal(placed.get(actionCapabilityId("fresh")), true);
  assert.equal(railState(host, "fresh"), true);
  setOnRail(host, "fresh", false);
  assert.equal(railState(host, "fresh"), false);
  assert.equal(railState({ capabilities: {} } as unknown as WebPackageHost, "fresh"), null, "an older host without the seam offers no entry");
});

test("a new action is confirmed with the one rail step that fits", async () => {
  const { resetNotifications } = await import("../../../apps/web/src/notify/store.ts");
  resetNotifications();
  placed.clear();
  try {
    const find = () => getNotifications().items.find((item) => item.id === createdNotificationId("fresh"));
    announceCreated(host, { id: "fresh", name: "Deploy" }, { placed: true, canPlace: true });
    assert.equal(find()?.kind, "success");
    assert.equal(find()?.title, "Deploy added");
    assert.equal(find()?.body, "On the rail");
    assert.deepEqual(find()?.actions?.map((action) => action.label), ["Remove from rail"]);
    placed.set(actionCapabilityId("fresh"), true);
    void find()!.actions![0]!.run();
    assert.equal(railState(host, "fresh"), false, "undo takes it off the rail");

    announceCreated(host, { id: "fresh", name: "Deploy" }, { placed: false, canPlace: true });
    assert.equal(find()?.body, undefined);
    assert.deepEqual(find()?.actions?.map((action) => action.label), ["Add to rail"]);
    void find()!.actions![0]!.run();
    assert.equal(railState(host, "fresh"), true);

    announceCreated(host, { id: "fresh", name: "Deploy" }, { placed: false, canPlace: false });
    assert.equal(find()?.actions, undefined, "an action for another project offers no rail step");

    resetNotifications();
    announceCreated({ ...host, notifications: undefined } as unknown as WebPackageHost, { id: "fresh", name: "Deploy" }, { placed: true, canPlace: true });
    assert.equal(getNotifications().items.length, 0, "an older host without the stack stays quiet");
  } finally {
    resetNotifications();
    placed.clear();
  }
});

test("on a host without the shared stack a result opens the run in the window instead", async () => {
  actions = [action("deploy")];
  runs = [];
  focused.length = 0;
  const bare = { ...host, notifications: undefined } as unknown as WebPackageHost;
  setActionHost(bare);
  const dispose = installActionLaunchers(bare);
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  try {
    await refresh();
    await act(async () => { root.render(createElement(ResultCards)); });
    capabilities.get(actionCapabilityId("deploy"))!.open();
    await settle();
    await settle();
    const runId = runs[0]!.id;
    assert.equal(getSnapshot().focusRunId, runId, "the run is focused in the Custom actions window");
    assert.deepEqual(focused, ["custom-action"]);
    assert.deepEqual(getSnapshot().cards, [], "no card waits for a stack that is not there");
  } finally {
    await act(async () => { root.unmount(); });
    mount.remove();
    dispose();
    resetActionStore();
    setActionHost(host);
  }
});
