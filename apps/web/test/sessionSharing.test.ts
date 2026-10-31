// Session sharing UI (Spaces §14.3), mounted through real React roots with a
// stubbed server: the Share dialog's audience/people edits and its PUT
// payload (full grant replacement + expectedRevision), the 409 reload, the
// read-only and inherited modes, the navigator marker and manage-only menu
// entries, the view-only composer, `session/removed` and the Space policy
// section. Assertions compare text/attributes only (never DOM nodes).
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionProjection, SessionSharingDto, SpaceSharingPolicyDto } from "@polyth/contracts";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
// A wide desktop shell: no media query matches except fine hover.
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: query.includes("hover: hover") && query.includes("pointer: fine"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Call { url: string; method: string; body?: unknown }
const calls: Call[] = [];
const routes = new Map<string, () => { status: number; body: unknown }>();
const route = (method: string, url: string, reply: () => { status: number; body: unknown }) =>
  routes.set(`${method} ${url}`, reply);
(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: { method?: string; body?: string }) => {
  const method = init?.method ?? "GET";
  calls.push({ url: String(url), method, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
  const reply = routes.get(`${method} ${String(url)}`)?.()
    ?? { status: 200, body: String(url).startsWith("/api/sessions/summaries") ? { sessions: [], revision: 0, complete: true } : [] };
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    statusText: reply.status === 409 ? "Conflict" : "OK",
    headers: new Map(),
    json: async () => reply.body,
    text: async () => JSON.stringify(reply.body),
  };
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const store = await import("../src/store.ts");
const { default: ShareSessionDialog } = await import("../src/components/ShareSessionDialog.tsx");
const { default: SessionList } = await import("../src/components/sidebar/SessionList.tsx");
const { default: Composer } = await import("../src/components/Composer.tsx");
const { default: SharingPolicySection } = await import("../src/components/settings/SharingPolicySection.tsx");
const { handleSessionRemoved } = await import("../src/init.ts");
const { isSyncInbound } = await import("../src/sync.ts");

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;

const session = (over: Partial<SessionProjection>): SessionProjection => ({
  id: "s1", projectId: "p1", title: "Chat", status: "idle",
  createdAt: Date.now() - 60_000, updatedAt: Date.now() - 30_000,
  ...over,
});

const sharingDto = (over: Partial<SessionSharingDto> = {}): SessionSharingDto => ({
  sessionId: "s1",
  visibility: "private",
  inherited: false,
  owner: { userId: "u-me", name: "Me" },
  access: "manage",
  grants: [],
  people: [{ userId: "u-ana", name: "Ana", role: "member" }, { userId: "u-bo", name: "Bo", role: "member" }],
  canShare: true,
  allowedVisibilities: ["private", "restricted", "space"],
  maxGrant: "manage",
  revision: 3,
  ...over,
});

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await settle();
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const bodyText = () => document.body.textContent ?? "";
const buttonByText = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => (button.textContent ?? "").trim() === text);
const click = async (element: Element | null | undefined) => {
  assert.ok(element, "clickable element exists");
  await act(async () => { (element as HTMLElement).click(); });
  await settle();
};

const openShare = (sharing: SessionProjection["sharing"]) => {
  store.activateProject("p1");
  store.setSessions("p1", [session({ id: "s1", ...(sharing ? { sharing } : {}) })]);
  store.openSessionSharing("s1");
};

test("share dialog sends the audience and the full people list with the revision", async () => {
  calls.length = 0;
  route("GET", "/api/sessions/s1/sharing", () => ({ status: 200, body: sharingDto() }));
  route("PUT", "/api/sessions/s1/sharing", () => ({ status: 200, body: sharingDto({ visibility: "restricted", revision: 4 }) }));
  openShare({ visibility: "private", access: "manage", shared: false });
  const view = await mount(createElement(ShareSessionDialog));
  try {
    const radios = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].map((radio) => radio.textContent ?? "");
    assert.equal(radios.length, 3, "every allowed audience is offered");
    assert.match(radios[0]!, /Only you/);
    assert.equal(buttonByText("Save")?.disabled, true, "nothing to save before a change");
    assert.equal(document.querySelector(".session-sharing-add"), null, "a private chat has no people list");

    await click([...document.querySelectorAll('[role="radio"]')].find((radio) => /Specific people/.test(radio.textContent ?? "")));
    assert.equal(document.querySelector('[role="radio"][aria-checked="true"]')?.textContent?.includes("Specific people"), true);
    await click(document.querySelector(".session-sharing-add .picker-chip"));
    await click([...document.querySelectorAll('[role="option"]')].find((option) => /Ana/.test(option.textContent ?? "")));
    assert.match(bodyText(), /Ana/);
    assert.ok(document.querySelector('[aria-label="Remove Ana"]'), "an added person can be removed again");

    await click(buttonByText("Save"));
    const put = calls.find((call) => call.method === "PUT");
    assert.deepEqual(put?.body, {
      visibility: "restricted",
      grants: [{ userId: "u-ana", access: "view" }],
      expectedRevision: 3,
    });
    assert.equal(store.getState().overlay, null, "a saved share closes the dialog");
  } finally {
    await view.unmount();
  }
});

test("an owner with personal MCP servers is told sharing starts the agent without them", async () => {
  calls.length = 0;
  route("GET", "/api/sessions/s1/sharing", () => ({ status: 200, body: sharingDto({ personalMcpDetachedOnShare: true }) }));
  openShare({ visibility: "private", access: "manage", shared: false });
  const view = await mount(createElement(ShareSessionDialog));
  try {
    assert.equal(document.querySelector("[data-sharing-mcp-detached]"), null, "a private chat keeps them; no note");
    await click([...document.querySelectorAll('[role="radio"]')].find((radio) => /Everyone in this Space/.test(radio.textContent ?? "")));
    assert.match(document.querySelector("[data-sharing-mcp-detached]")?.textContent ?? "", /personal MCP servers/);
  } finally {
    await view.unmount();
  }
});

test("a stale revision reloads the sharing and tells the person it changed", async () => {
  calls.length = 0;
  let revision = 3;
  route("GET", "/api/sessions/s1/sharing", () => ({ status: 200, body: sharingDto({ revision }) }));
  route("PUT", "/api/sessions/s1/sharing", () => {
    revision = 5;
    return { status: 409, body: { error: "conflict", message: "stale" } };
  });
  openShare({ visibility: "private", access: "manage", shared: false });
  const view = await mount(createElement(ShareSessionDialog));
  try {
    await click([...document.querySelectorAll('[role="radio"]')].find((radio) => /Everyone in this Space/.test(radio.textContent ?? "")));
    await click(buttonByText("Save"));
    assert.equal(store.getState().overlay, "session-sharing", "the dialog stays open");
    assert.match(bodyText(), /Someone changed who can open this chat/);
    assert.equal(calls.filter((call) => call.method === "GET" && call.url === "/api/sessions/s1/sharing").length, 2);
    assert.equal(document.querySelector('[role="radio"][aria-checked="true"]')?.textContent?.includes("Only you"), true,
      "the reloaded server state replaces the rejected draft");
  } finally {
    await view.unmount();
  }
});

test("without share rights the dialog only shows who has access", async () => {
  route("GET", "/api/sessions/s1/sharing", () => ({ status: 200, body: sharingDto({
    visibility: "space",
    owner: { userId: "u-bo", name: "Bo" },
    access: "collaborate",
    canShare: false,
    maxGrant: null,
    grants: [{ userId: "u-ana", name: "Ana", access: "collaborate" }],
  }) }));
  openShare({ visibility: "space", access: "collaborate", owner: { userId: "u-bo", name: "Bo" }, shared: true });
  const view = await mount(createElement(ShareSessionDialog));
  try {
    assert.equal(document.querySelectorAll('[role="radio"]').length, 0, "no editable audience");
    assert.equal(buttonByText("Save"), undefined);
    assert.ok(buttonByText("Close"));
    const text = bodyText();
    assert.match(text, /Who has access/);
    assert.match(text, /Everyone in this Space/);
    assert.match(text, /Bo/);
    assert.match(text, /Owner/);
    assert.match(text, /Can collaborate/);
    assert.equal(document.querySelector('[aria-label="Remove Ana"]'), null);
  } finally {
    await view.unmount();
  }
});

test("a delegated subagent explains its inherited sharing and opens the parent's", async () => {
  route("GET", "/api/sessions/s1/sharing", () => ({ status: 200, body: sharingDto({ inherited: true, parentSessionId: "parent" }) }));
  route("GET", "/api/sessions/parent/sharing", () => ({ status: 200, body: sharingDto({ sessionId: "parent" }) }));
  openShare({ visibility: "private", inherited: true, access: "manage", shared: false });
  const view = await mount(createElement(ShareSessionDialog));
  try {
    assert.match(bodyText(), /follows the sharing of the chat it was delegated from/);
    assert.equal(document.querySelectorAll('[role="radio"]').length, 0);
    await click(buttonByText("Open the parent chat’s sharing"));
    assert.equal(store.getState().sharingSessionId, "parent");
    assert.equal(document.querySelectorAll('[role="radio"]').length, 3, "the parent's sharing loads in place");
  } finally {
    await view.unmount();
  }
});

test("navigator rows mark shared chats and hide manage-only actions below manage", async () => {
  store.activateProject("p1");
  store.setSessions("p1", [
    session({ id: "mine", title: "Mine private", sharing: { visibility: "private", access: "manage", shared: false } }),
    session({ id: "open", title: "Mine open", sharing: { visibility: "space", access: "manage", shared: true } }),
    session({ id: "theirs", title: "From Bo", sharing: { visibility: "restricted", access: "view", owner: { userId: "u-bo", name: "Bo" }, shared: true } }),
    session({ id: "legacy", title: "Legacy chat" }),
  ]);
  const view = await mount(createElement(SessionList, { projectId: "p1" }));
  const rowOf = (title: string) => [...view.container.querySelectorAll<HTMLElement>(".session-row")]
    .find((row) => (row.textContent ?? "").includes(title))!;
  const menuIds = async (title: string) => {
    await act(async () => { rowOf(title).dispatchEvent(new MouseEventCtor("contextmenu", { bubbles: true, cancelable: true })); });
    const labels = [...document.querySelectorAll('[role^="menuitem"]')].map((item) => (item.textContent ?? "").trim());
    await act(async () => { document.dispatchEvent(new (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    return labels;
  };
  try {
    assert.equal(rowOf("Mine private").querySelector(".session-shared-icon"), null, "no marker on a private own chat");
    assert.equal(rowOf("Mine open").querySelector(".session-shared-icon")?.getAttribute("aria-label"), "Shared with everyone in this Space");
    assert.equal(rowOf("From Bo").querySelector(".session-shared-icon")?.getAttribute("aria-label"), "Shared by Bo");
    assert.equal(rowOf("Legacy chat").querySelector(".session-shared-icon"), null);

    const own = await menuIds("Mine open");
    assert.ok(own.includes("Share…"));
    assert.ok(own.includes("Rename") && own.includes("Delete"));
    const viewer = await menuIds("From Bo");
    assert.ok(viewer.includes("Who has access"));
    assert.equal(viewer.some((label) => ["Rename", "Archive", "Delete", "Share…"].includes(label)), false, viewer.join(", "));
    const legacy = await menuIds("Legacy chat");
    assert.equal(legacy.some((label) => label === "Share…" || label === "Who has access"), false, "no sharing UI without identity");
    assert.ok(legacy.includes("Delete"));
  } finally {
    await view.unmount();
  }
});

test("a view-only reader writes to people only, with a quiet note naming whom to ask", async () => {
  route("GET", "/api/runtime-catalog?sessionId=theirs", () => ({
    status: 200,
    body: { models: [], agents: [], nativeDefault: false, ready: true, discovery: { state: "empty" } },
  }));
  route("GET", "/api/prompt-history?scope=session&limit=40&sessionId=theirs", () => ({ status: 200, body: { prompts: [], beforeSeq: null } }));
  route("GET", "/api/harnesses/default", () => ({ status: 200, body: {} }));
  store.activateProject("p1");
  store.setSessions("p1", [session({
    id: "theirs",
    sharing: { visibility: "restricted", access: "view", owner: { userId: "u-bo", name: "Bo" }, shared: true },
  })]);
  store.activateSession("theirs");
  const view = await mount(createElement(Composer));
  try {
    const note = view.container.querySelector(".composer-view-only");
    assert.ok(note, "the view-only note renders");
    assert.match(note?.textContent ?? "", /You can view this chat/);
    assert.match(note?.textContent ?? "", /Ask Bo if you need the agent/);
    assert.equal(view.container.querySelector(".composer-people-toggle"), null, "no Agent mode to switch to");
    assert.equal(view.container.querySelector(".composer-config-row"), null, "no model or effort controls");
    assert.equal(view.container.querySelector(".composer-people-carry"), null, "carrying to a prompt needs collaborate");
    assert.ok(view.container.querySelector(".composer-people-send"), "the send action addresses people");
  } finally {
    await view.unmount();
    store.activateSession(null);
  }
});

test("session/removed is a recognised message and drops the chat with a calm notice", () => {
  assert.equal(isSyncInbound({ type: "session/removed", sessionId: "gone" }), true);
  assert.equal(isSyncInbound({ type: "session/removed" }), false);
  assert.equal(isSyncInbound({ type: "session/removed", sessionId: "" }), false);

  store.clearUiError();
  store.activateProject("p1");
  store.setSessions("p1", [session({ id: "a" }), session({ id: "b" })]);
  store.activateSession("a");
  handleSessionRemoved("b");
  assert.deepEqual(store.getState().sessions.map((row) => row.id), ["a"]);
  assert.equal(store.getState().activeSessionId, "a", "an unrelated removal keeps the open chat");
  assert.equal(store.getState().uiError, null);

  handleSessionRemoved("a");
  assert.deepEqual(store.getState().sessions.map((row) => row.id), []);
  assert.equal(store.getState().activeSessionId, null, "the open chat is left");
  assert.equal(store.getState().uiError, "That chat is no longer available to you.");
  store.clearUiError();
});

const policy = (over: Partial<SpaceSharingPolicyDto> = {}): SpaceSharingPolicyDto => ({
  defaultVisibility: "private",
  allowSpaceVisibility: true,
  membersMayShare: true,
  maxMemberAccess: "manage",
  revision: 2,
  canEdit: true,
  ...over,
});

test("Space admins edit the sharing policy; each change carries the revision", async () => {
  calls.length = 0;
  route("GET", "/api/sharing/policy", () => ({ status: 200, body: policy() }));
  route("PUT", "/api/sharing/policy", () => ({ status: 200, body: policy({ membersMayShare: false, revision: 3 }) }));
  const view = await mount(createElement(SharingPolicySection));
  try {
    const toggle = [...view.container.querySelectorAll<HTMLElement>('[role="switch"]')]
      .find((item) => item.getAttribute("aria-label") === "Members may share");
    assert.equal(toggle?.getAttribute("aria-checked"), "true");
    await click(toggle);
    assert.deepEqual(calls.find((call) => call.method === "PUT")?.body, { membersMayShare: false, expectedRevision: 2 });
    assert.equal(toggle?.getAttribute("aria-checked"), "false");
  } finally {
    await view.unmount();
  }
});

test("members see the sharing policy read-only, and installs without it see nothing", async () => {
  route("GET", "/api/sharing/policy", () => ({ status: 200, body: policy({ canEdit: false, defaultVisibility: "space" }) }));
  let view = await mount(createElement(SharingPolicySection));
  try {
    assert.equal(view.container.querySelectorAll('[role="switch"]').length, 0, "no editable control");
    const text = view.container.textContent ?? "";
    assert.match(text, /Set by this Space’s admins/);
    assert.match(text, /Everyone in this Space/);
    assert.match(text, /Can manage/);
  } finally {
    await view.unmount();
  }

  route("GET", "/api/sharing/policy", () => ({ status: 404, body: { error: "not-found", message: "no policy" } }));
  view = await mount(createElement(SharingPolicySection));
  try {
    assert.equal(view.container.textContent, "", "a legacy install renders no sharing section");
  } finally {
    await view.unmount();
  }
});
