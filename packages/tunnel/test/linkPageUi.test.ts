import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { GRANT_PROFILE_PRESETS, REMOTE_CAPABILITY, REMOTE_CAPABILITY_VALUES, type TunnelDeviceDto, type TunnelStatusDto } from "@polyth/contracts";
import { accessLabel, CAPABILITY_GROUPS, withFullAccess } from "../widgets/permissions.ts";

test("permission groups name every grantable capability exactly once", () => {
  const listed = CAPABILITY_GROUPS.flatMap((group) => group.items.map(([id]) => id));
  assert.equal(new Set(listed).size, listed.length);
  assert.deepEqual(
    [...listed].sort(),
    REMOTE_CAPABILITY_VALUES.filter((value) => value !== REMOTE_CAPABILITY.deviceFullAccess).sort(),
  );
});

test("full access toggles round-trip and presets are named", () => {
  const observe = [...GRANT_PROFILE_PRESETS.observe];
  const full = withFullAccess(observe, true);
  assert.equal(accessLabel(full), "Full access");
  assert.deepEqual(withFullAccess(full, false), observe);
  assert.equal(accessLabel(observe), "Observe");
  assert.equal(accessLabel([REMOTE_CAPABILITY.filesRead]), "Custom");
  assert.equal(accessLabel([...GRANT_PROFILE_PRESETS["full-remote"]]), "Full access");
});

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  location: dom.location,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  getComputedStyle: (elt: Element) => (dom as unknown as { getComputedStyle(el: Element): CSSStyleDeclaration }).getComputedStyle(elt),
  WebSocket: class { addEventListener() {} removeEventListener() {} close() {} },
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const status = {
  enabled: true, available: true, pairingAvailable: true, hostBinaryFound: true, hostProcessReady: true,
  endpointBound: true, ingressReady: true, activePolicy: "direct-preferred", mode: "direct-preferred",
  hostFingerprint: "ab12cd34", fingerprint: "ab12cd34", relayConfigured: false, identityAvailable: true,
  activeConnections: 1, activeDevices: 1, directConnections: 1, relayConnections: 0,
} as TunnelStatusDto;
const device: TunnelDeviceDto = {
  id: "dev-1", label: "Max's iPhone", endpointFingerprint: "ff", createdAt: 1, updatedAt: 1, grantRevision: 1,
  grants: [...GRANT_PROFILE_PRESETS["full-remote"]], online: true, lastTransport: "direct", activeConnectionCount: 1,
};
const requests: Array<{ method: string; path: string; body: unknown }> = [];
let serverName = { name: "", fallback: "studio", editable: true };
// The instance owner's view of teammates; off for everyone else.
let instanceOwner = false;
let issued: Array<TunnelDeviceDto & { accountId: string }> = [];
// Joined servers: empty unless a test fills them in.
let activeSpaceId = "s1";
let joined: { servers: Array<Record<string, unknown>>; spaces: Array<Record<string, unknown>> } = { servers: [], spaces: [] };
let beginFailure: { error: string; message: string } | null = null;
// A one-time invitation ticket: no words, only the host and one confirmation.
let invitation = false;
// Holds confirm open, as the other server's owner does until they approve.
let approval: Promise<void> | null = null;
const otherServer = { connectionId: "c1", label: "Team box", fingerprint: "ab12…cd34", online: true };
const otherSpace = {
  id: "rmt_0123456789abcdef01234567", name: "Design crew", role: "member", memberCount: 3,
  serverLabel: "Team box", connectionId: "c1", online: true,
};
const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const path = new URL(String(input), "http://127.0.0.1:4400").pathname;
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
  requests.push({ method, path, body });
  if (path === "/api/tunnel/status") return json(status);
  if (path === "/api/tunnel/devices") return json([device]);
  if (path === "/api/auth/status") return json({ required: true });
  if (path === "/api/tunnel/server-name") {
    if (method === "PUT") serverName = { ...serverName, name: String((body as { name: string }).name).trim() };
    return json(serverName);
  }
  if (path === "/api/auth/accounts") return json({ currentAccountId: "owner", canManage: instanceOwner, accounts: [] });
  if (path === "/api/spaces") return json({ activeSpaceId });
  if (path === "/api/tunnel/joined") return json(joined);
  if (path === "/api/tunnel/joined/pair/parse") {
    return json({ hostLabel: "Team box", fingerprint: "ab12cd34ef56", expiresAt: new Date(Date.now() + 120_000).toISOString(), invitation });
  }
  if (path === "/api/tunnel/joined/pair/begin") {
    if (beginFailure) return json(beginFailure, 410);
    return json({ attemptId: "a1", safetyPhrase: ["amber", "river", "lantern", "moss"] });
  }
  if (path === "/api/tunnel/joined/pair/confirm") {
    await approval;
    joined = { servers: [otherServer], spaces: [otherSpace] };
    return json({ server: otherServer, spaces: [otherSpace] });
  }
  if (path === "/api/tunnel/joined/c1" && method === "PATCH") {
    return json({ server: { ...otherServer, label: (body as { label: string }).label } });
  }
  if (path === "/api/tunnel/joined/c1" && method === "DELETE") {
    joined = { servers: [], spaces: [] };
    activeSpaceId = "s1";
    return json({ ok: true });
  }
  if (path === "/api/spaces/s1/members") {
    return json([{ userId: "owner", name: "Olena" }, { userId: "sam", name: "Sam Rivers" }]);
  }
  if (path === "/api/tunnel/devices/issued") return json(issued);
  if (path === "/api/tunnel/devices/dev-2/revoke") {
    issued = issued.map((entry) => entry.id === "dev-2" ? { ...entry, revokedAt: 2 } : entry);
  }
  if (path === "/api/tunnel/pairing" && method === "POST") {
    const { forUserId, profile } = (body ?? {}) as { forUserId?: string; profile?: string };
    return json({
      ...(forUserId ? { forUserId, profile } : {}),
      pairing: { id: "p1", expiresAt: new Date(Date.now() + 120_000).toISOString(), safetyPhrase: null, state: "pending" },
      ticket: "t", qrPayload: "polyth://pair?v=1&t=SECRET-PAYLOAD", qrModules: [[true, false], [false, true]],
    });
  }
  if (path === "/api/tunnel/devices/dev-1/grants") return json({ ...device, grants: (body as { grants: string[] }).grants });
  return json({});
};

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

test("Link page pairs with Full access by default and edits permissions on demand", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: LinkPage } = await import("../widgets/LinkPage.tsx");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const flush = async () => { for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); }); };
  const button = (text: string) => [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === text) as HTMLButtonElement | undefined;

  await act(async () => { root.render(createElement(LinkPage)); });
  await flush();
  assert.match(host.textContent ?? "", /Max's iPhone/);
  assert.match(host.textContent ?? "", /Full access/);
  assert.equal(host.querySelector(".pkg-tunnel-groups") === null, true, "permissions stay collapsed by default");
  // The host card carries the server facts that used to live in Access.
  const facts = host.querySelector(".pkg-tunnel-hero")?.textContent ?? "";
  assert.match(facts, /127\.0\.0\.1:4400/);
  assert.match(facts, /Required on every browser and device/);

  await act(async () => { button("Pair device")!.click(); });
  await flush();
  const pairingPost = requests.find((entry) => entry.path === "/api/tunnel/pairing" && entry.method === "POST");
  assert.deepEqual(pairingPost?.body, {}, "no profile → server default Full access");
  assert.equal(document.querySelector(".pkg-tunnel-qr svg") !== null, true);
  assert.doesNotMatch(document.body.textContent ?? "", /SECRET-PAYLOAD/);
  assert.equal(button("Copy pairing link") !== undefined, true, "a computer takes the same invitation as a link");
  await act(async () => { button("Cancel")!.click(); });
  await flush();

  await act(async () => { button("Permissions")!.click(); });
  await flush();
  const toggle = host.querySelector('[role="switch"][aria-label="Full access"]') as HTMLButtonElement;
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  await act(async () => { toggle.click(); });
  await flush();
  const put = requests.find((entry) => entry.method === "PUT");
  assert.equal(put?.path, "/api/tunnel/devices/dev-1/grants");
  assert.equal((put?.body as { grants: string[] }).grants.includes(REMOTE_CAPABILITY.deviceFullAccess), false);
  assert.equal(host.querySelector(".pkg-tunnel-groups") !== null, true, "individual toggles appear once full access is off");

  await act(async () => { root.unmount(); });
});

test("the owner names this server for phones on the Link page", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: LinkPage } = await import("../widgets/LinkPage.tsx");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const flush = async () => { for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); }); };
  const type = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new dom.Event("input", { bubbles: true }) as never);
    });
  };
  requests.length = 0;
  serverName = { name: "", fallback: "studio", editable: true };

  await act(async () => { root.render(createElement(LinkPage)); });
  await flush();
  let field = host.querySelector("input[name='server-name']") as HTMLInputElement;
  assert.equal(field.placeholder, "studio", "until it is named, phones see the host name");
  assert.equal(field.value, "");
  assert.equal(host.querySelector(`label[for="${field.id}"]`)?.textContent, "Name on other devices");

  await type(field, "Home studio");
  assert.equal(requests.some((entry) => entry.method === "PUT"), false, "typing alone saves nothing");
  await act(async () => { field.dispatchEvent(new dom.FocusEvent("focusout", { bubbles: true }) as never); });
  await flush();
  const puts = requests.filter((entry) => entry.method === "PUT" && entry.path === "/api/tunnel/server-name");
  assert.deepEqual(puts.map((entry) => entry.body), [{ name: "Home studio" }]);
  assert.match(host.textContent ?? "", /Saved/);

  await type(field, "Something else");
  await act(async () => { field.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never); });
  assert.equal(field.value, "Home studio", "Escape goes back to the saved name");
  await act(async () => { root.unmount(); });

  serverName = { name: "Home studio", fallback: "studio", editable: false };
  const member = createRoot(host);
  await act(async () => { member.render(createElement(LinkPage)); });
  await flush();
  field = host.querySelector("input[name='server-name']") as HTMLInputElement;
  assert.equal(field === null, true, "only the owner can change it");
  assert.match(host.querySelector(".pkg-tunnel-hero")?.textContent ?? "", /Name on other devicesHome studio/);
  await act(async () => { member.unmount(); });
});

async function mountLinkPage(props: Record<string, unknown> = {}) {
  const { default: LinkPage } = await import("../widgets/LinkPage.tsx");
  return mountComponent(LinkPage as never, props);
}

/** The other servers joined, and joining one: Settings → Spaces mounts it
 *  through `settings.spaces.sections`, with the package's transport. */
async function mountJoinedServers(props: Record<string, unknown> = {}) {
  const { createApiTransport } = await import("@polyth/web-sdk");
  const { createTranslate } = await import("../widgets/i18n.ts");
  const { default: JoinedServers } = await import("../widgets/JoinedServers.tsx");
  const api = createApiTransport({ fetch: (url, init) => fetch(url, { credentials: "include", ...init }) });
  return mountComponent(JoinedServers as never, { api, t: createTranslate(), ...props });
}

async function mountComponent(Component: import("react").ComponentType<Record<string, unknown>>, props: Record<string, unknown>) {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const flush = async () => { for (let i = 0; i < 12; i += 1) await act(async () => { await Promise.resolve(); }); };
  const render = async (next: Record<string, unknown>) => {
    await act(async () => { root.render(createElement(Component, next)); });
    await flush();
  };
  const buttons = () => [...document.querySelectorAll("button")] as unknown as HTMLButtonElement[];
  const button = (text: string) => buttons().find((el) => el.textContent?.trim() === text);
  const click = async (element: Element | null | undefined) => {
    assert.ok(element, "the control to click exists");
    await act(async () => { (element as HTMLElement).click(); });
    await flush();
  };
  const dialog = () => document.querySelector(".pkg-tunnel-dialog");
  const unmount = async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  };
  await render(props);
  return { host, render, button, click, dialog, flush, unmount };
}

const pairingPosts = () => requests
  .filter((entry) => entry.method === "POST" && entry.path === "/api/tunnel/pairing")
  .map((entry) => entry.body);

test("the instance owner pairs a teammate's app with Full access in that person's own rights", async () => {
  instanceOwner = true;
  issued = [];
  requests.length = 0;
  const page = await mountLinkPage();
  await page.click(page.button("Pair device"));
  assert.deepEqual(pairingPosts(), [{}], "Me stays the default");
  assert.ok(page.button("Full access"), "the owner's own device may have Full access");

  await page.click(document.querySelector(".pkg-tunnel-for button"));
  const option = [...document.querySelectorAll('[role="option"]')].find((el) => el.textContent?.includes("Sam Rivers"));
  assert.equal([...document.querySelectorAll('[role="option"]')].some((el) => el.textContent?.includes("Olena")), false, "the owner is Me, not a teammate");
  await page.click(option as unknown as Element);
  assert.deepEqual(pairingPosts().at(-1), { forUserId: "sam", profile: "full-remote" });
  assert.ok(requests.some((entry) => entry.method === "DELETE" && entry.path === "/api/tunnel/pairing/p1"), "the owner's code is withdrawn");
  assert.ok(page.button("Full access"), "full access is Sam's own rights, offered and chosen by default");
  const text = page.dialog()?.textContent ?? "";
  assert.match(text, /act as Sam Rivers, with that person’s permissions/);
  assert.match(text, /You have 2 minutes/);
  assert.ok(page.button("Copy pairing link"));

  await page.click(page.button("Observe"));
  assert.deepEqual(pairingPosts().at(-1), { forUserId: "sam", profile: "observe" });
  await page.click(page.button("Cancel"));
  await page.unmount();
});

test("a pair-for settings target opens the dialog for that teammate once", async () => {
  instanceOwner = true;
  requests.length = 0;
  const settingsTarget = { sectionId: "pair-for", itemId: "sam" };
  const page = await mountLinkPage({ settingsTarget });
  assert.match(page.dialog()?.textContent ?? "", /act as Sam Rivers/);
  assert.deepEqual(pairingPosts(), [{ forUserId: "sam", profile: "full-remote" }]);
  await page.click(page.button("Cancel"));
  await page.render({ settingsTarget });
  assert.equal(page.dialog(), null);
  await page.unmount();
  const again = await mountLinkPage({ settingsTarget });
  assert.equal(again.dialog(), null, "the same target does not reopen after a remount");
  await again.unmount();

  instanceOwner = false;
  requests.length = 0;
  const member = await mountLinkPage({ settingsTarget: { sectionId: "pair-for", itemId: "sam" } });
  assert.equal(member.dialog(), null);
  assert.match(member.host.textContent ?? "", /Only the instance owner can connect a device for another person/);
  assert.deepEqual(pairingPosts(), []);
  await member.click(member.button("Pair device"));
  assert.equal(document.querySelector(".pkg-tunnel-for"), null, "no For choice for anyone else");
  await member.click(member.button("Cancel"));
  await member.unmount();
});

test("devices paired for others are listed by person and can be revoked", async () => {
  const { resolveAlert } = await import("../../../apps/web/src/alerts.ts");
  const { act } = await import("react");
  instanceOwner = true;
  issued = [
    { ...device, id: "dev-2", label: "Sam's laptop", platform: "macos", accountId: "sam" },
    { ...device, id: "dev-3", label: "Old tablet", accountId: "gone" },
  ];
  requests.length = 0;
  const page = await mountLinkPage();
  assert.match(page.host.textContent ?? "", /Devices you connected for others/);
  const row = (label: string) => [...page.host.querySelectorAll("li")].find((el) => el.textContent?.includes(label))!;
  assert.match(row("Sam's laptop").textContent ?? "", /Sam Rivers · macos · Online/);
  assert.match(row("Old tablet").textContent ?? "", /Teammate/);

  await page.click(row("Sam's laptop").querySelector("button"));
  await act(async () => { resolveAlert(true); });
  await page.flush();
  assert.ok(requests.some((entry) => entry.method === "POST" && entry.path === "/api/tunnel/devices/dev-2/revoke"));
  await page.click(row("Sam's laptop").querySelector("button"));
  assert.ok(requests.some((entry) => entry.method === "DELETE" && entry.path === "/api/tunnel/devices/dev-2"), "Forget follows Revoke");
  await page.unmount();
  issued = [];
  instanceOwner = false;
});

const joinedCalls = () => requests
  .filter((entry) => entry.method !== "GET" && entry.path.startsWith("/api/tunnel/joined"))
  .map((entry) => [entry.method, entry.path.slice("/api/tunnel/joined".length), entry.body]);

async function typeInto(input: Element | null, value: string) {
  const { act } = await import("react");
  assert.ok(input, "the field exists");
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as never);
  });
}

const TICKET = "polyth://pair?v=1&t=abc";

test("joining another server compares the safety words, then lists it with its Spaces", async () => {
  joined = { servers: [], spaces: [] };
  let approve!: () => void;
  approval = new Promise<void>((resolve) => { approve = resolve; });
  requests.length = 0;
  const page = await mountJoinedServers();
  assert.match(page.host.textContent ?? "", /Other Polyth servers/);
  assert.equal(page.button("Join")!.disabled, true, "nothing to join yet");

  await typeInto(page.host.querySelector("input[name='pairing-link']"), TICKET);
  await page.click(page.button("Join"));
  const text = () => page.dialog()?.textContent ?? "";
  assert.match(text(), /Join Team box/);
  assert.match(text(), /ab12cd34ef56/);
  assert.match(text(), /amber.*river.*lantern.*moss/);
  assert.match(text(), /shows these same words/);
  assert.deepEqual(joinedCalls(), [
    ["POST", "/pair/parse", { ticket: TICKET }],
    ["POST", "/pair/begin", { ticket: TICKET }],
  ], "nothing is confirmed before the person compares the words");

  await page.click(page.button("Words match"));
  assert.match(text(), /Waiting for the owner of Team box to approve/);
  assert.match(text(), /amber/, "the words stay up while the owner compares them");
  assert.ok(page.button("Cancel"));
  assert.deepEqual(joinedCalls().at(-1), ["POST", "/pair/confirm", { attemptId: "a1" }]);

  approve();
  await page.flush();
  assert.equal(page.dialog(), null);
  assert.match(page.host.textContent ?? "", /You joined Team box.*Space switcher/);
  assert.match(page.host.querySelector(".pkg-tunnel-server")?.textContent ?? "", /Team box.*Design crew.*Online/);
  assert.equal((page.host.querySelector("input[name='pairing-link']") as HTMLInputElement).value, "");

  await page.click(page.button("Rename"));
  await typeInto(page.host.querySelector("input[name='server-label']"), "Studio");
  await page.click(page.button("Save"));
  assert.deepEqual(joinedCalls().at(-1), ["PATCH", "/c1", { label: "Studio" }]);
  assert.match(page.host.querySelector(".pkg-tunnel-server")?.textContent ?? "", /Studio/);
  approval = null;
  joined = { servers: [], spaces: [] };
  await page.unmount();
});

test("an invitation link skips the words and asks for one confirmation", async () => {
  joined = { servers: [], spaces: [] };
  invitation = true;
  let approve!: () => void;
  approval = new Promise<void>((resolve) => { approve = resolve; });
  requests.length = 0;
  const page = await mountJoinedServers();
  const link = "https://polyth.app/join#v=1&t=abc";
  await typeInto(page.host.querySelector("input[name='pairing-link']"), link);
  await page.click(page.button("Join"));
  const text = () => page.dialog()?.textContent ?? "";
  assert.match(text(), /Join Team box/);
  assert.doesNotMatch(text(), /amber|shows these same words/);
  assert.deepEqual(joinedCalls(), [
    ["POST", "/pair/parse", { ticket: TICKET }],
    ["POST", "/pair/begin", { ticket: TICKET }],
  ]);
  assert.equal(page.button("Words match"), undefined);
  const confirm = [...page.dialog()!.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Join") as HTMLButtonElement;
  await page.click(confirm);
  assert.deepEqual(joinedCalls().at(-1), ["POST", "/pair/confirm", { attemptId: "a1" }]);
  approve();
  await page.flush();
  assert.match(page.host.textContent ?? "", /You joined Team box/);
  invitation = false;
  approval = null;
  joined = { servers: [], spaces: [] };
  await page.unmount();
});

test("a refused pairing link shows the server's message", async () => {
  joined = { servers: [], spaces: [] };
  beginFailure = { error: "pairing-expired", message: "That pairing link has expired." };
  requests.length = 0;
  const page = await mountJoinedServers();
  await typeInto(page.host.querySelector("input[name='pairing-link']"), TICKET);
  await page.click(page.button("Join"));
  assert.equal(page.dialog(), null);
  assert.match(page.host.textContent ?? "", /That pairing link has expired\./);
  // The page loaded; it is the join that failed.
  assert.equal(page.host.querySelector(".settings-error-title")?.textContent, "Couldn’t join that server");
  assert.equal(joinedCalls().some(([, path]) => path === "/pair/confirm"), false);
  beginFailure = null;
  await page.unmount();
});

test("cancelling a pairing, or leaving the page, drops the attempt", async () => {
  joined = { servers: [], spaces: [] };
  requests.length = 0;
  const page = await mountJoinedServers();
  await typeInto(page.host.querySelector("input[name='pairing-link']"), TICKET);
  await page.click(page.button("Join"));
  await page.click(page.button("Cancel"));
  assert.equal(page.dialog(), null);
  assert.deepEqual(joinedCalls().at(-1), ["POST", "/pair/cancel", { attemptId: "a1" }]);

  requests.length = 0;
  await page.click(page.button("Join"));
  await page.unmount();
  assert.deepEqual(joinedCalls().at(-1), ["POST", "/pair/cancel", { attemptId: "a1" }]);
});

test("leaving a server asks first, then removes it", async () => {
  const { resolveAlert } = await import("../../../apps/web/src/alerts.ts");
  const { act } = await import("react");
  joined = { servers: [otherServer], spaces: [otherSpace] };
  requests.length = 0;
  const page = await mountJoinedServers();
  const answer = async (value: boolean) => {
    await act(async () => { resolveAlert(value); });
    await page.flush();
  };
  await page.click(page.button("Leave"));
  await answer(false);
  assert.deepEqual(joinedCalls(), [], "declining keeps the server");

  await page.click(page.button("Leave"));
  assert.deepEqual(joinedCalls(), [], "nothing is removed before the answer");
  await answer(true);
  assert.deepEqual(joinedCalls(), [["DELETE", "/c1", undefined]]);
  assert.equal(page.host.querySelector(".pkg-tunnel-server"), null);
  await page.unmount();
});

test("leaving the server whose Space is open says so and reloads", async () => {
  const { resolveAlert } = await import("../../../apps/web/src/alerts.ts");
  const { act } = await import("react");
  joined = { servers: [otherServer], spaces: [otherSpace] };
  activeSpaceId = otherSpace.id;
  let reloads = 0;
  const original = dom.location.reload;
  Object.defineProperty(dom.location, "reload", { value: () => { reloads += 1; }, configurable: true });
  const page = await mountJoinedServers();
  await page.click(page.button("Leave"));
  await act(async () => { resolveAlert(true); });
  await page.flush();
  assert.equal(reloads, 0, "the person is told first");
  await act(async () => { resolveAlert(true); });
  await page.flush();
  assert.equal(reloads, 1);
  Object.defineProperty(dom.location, "reload", { value: original, configurable: true });
  await page.unmount();
});

test("a join settings target focuses the pairing link field once", async () => {
  joined = { servers: [], spaces: [] };
  const settingsTarget = { sectionId: "join" };
  const page = await mountJoinedServers({ settingsTarget });
  const field = () => document.querySelector("input[name='pairing-link']");
  assert.equal(document.activeElement === field(), true);
  await page.unmount();
  const again = await mountJoinedServers({ settingsTarget });
  assert.equal(document.activeElement === field(), false, "a remount does not steal focus again");
  await again.unmount();
});

test("joining moved to Settings → Spaces: the Link page sends an old join link there", async () => {
  joined = { servers: [], spaces: [] };
  const opened: Array<[string, unknown]> = [];
  const host = { navigation: { openSettingsPage: (id: string, target?: unknown) => { opened.push([id, target]); } } };
  const settingsTarget = { sectionId: "join" };
  const page = await mountLinkPage({ host, settingsTarget });
  assert.doesNotMatch(page.host.textContent ?? "", /Other Polyth servers/);
  assert.equal(document.querySelector("input[name='pairing-link']"), null);
  assert.deepEqual(opened, [["spaces", settingsTarget]]);
  await page.unmount();
});

test("no teammates are read in another server's Space", async () => {
  const { loadTeammates } = await import("../widgets/people.ts");
  const read: string[] = [];
  const result = await loadTeammates({
    get: async <T,>(path: string) => {
      read.push(path);
      return (path === "/api/spaces" ? { activeSpaceId: otherSpace.id } : { canManage: true }) as T;
    },
  });
  assert.equal(result, null);
  assert.deepEqual(read, ["/api/auth/accounts", "/api/spaces"]);
});
