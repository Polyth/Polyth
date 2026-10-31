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
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const path = new URL(String(input), "http://127.0.0.1:4400").pathname;
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
  requests.push({ method, path, body });
  if (path === "/api/tunnel/status") return json(status);
  if (path === "/api/tunnel/devices") return json([device]);
  if (path === "/api/auth/status") return json({ required: true });
  if (path === "/api/tunnel/pairing" && method === "POST") {
    return json({
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
  assert.match(facts, /Required on every browser and phone/);

  await act(async () => { button("Pair phone")!.click(); });
  await flush();
  const pairingPost = requests.find((entry) => entry.path === "/api/tunnel/pairing" && entry.method === "POST");
  assert.deepEqual(pairingPost?.body, {}, "no profile → server default Full access");
  assert.equal(document.querySelector(".pkg-tunnel-qr svg") !== null, true);
  assert.doesNotMatch(document.body.textContent ?? "", /SECRET-PAYLOAD/);
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
