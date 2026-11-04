// Settings > Users on a paired phone: mount the real page against a mocked
// server. A full-access device reads accounts; changes need a browser.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1/?settings=users" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  Event: dom.Event,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const owner = { id: "usr_owner", displayName: "Max", login: "max", managed: false, status: "active", revision: 1 };
const member = { id: "usr_olena", displayName: "Olena", login: "olena", managed: false, status: "active", revision: 2 };
let accounts: { status: number; body: unknown } = { status: 200, body: {} };
const json = (status: number, body: unknown) => ({ ok: status < 400, status, statusText: "", headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
(globalThis as { fetch?: unknown }).fetch = async (path: string) => {
  if (path === "/api/auth/status") return json(200, { required: false, authorized: true, scope: "paired-device" });
  if (path === "/api/auth/accounts") return json(accounts.status, accounts.body);
  if (path === "/api/spaces") return json(200, { activeSpaceId: "spc_1", spaces: [{ id: "spc_1", name: "Home", role: "owner" }] });
  if (path === "/api/spaces/spc_1/members") return json(200, [{ userId: "usr_owner", role: "owner" }, { userId: "usr_olena", role: "member" }]);
  return json(404, { error: "not-found" });
};

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: UsersPage } = await import("../src/components/settings/UsersPage.tsx");

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(UsersPage)); });
  await settle();
  return { container, unmount: () => act(async () => { root.unmount(); container.remove(); }) };
}

test("a full-access phone lists the owner's users read-only and points changes to a browser", async () => {
  accounts = {
    status: 200,
    body: {
      currentAccountId: owner.id, canManage: false, readOnly: true, canManageInBrowser: true,
      accounts: [{ ...owner, name: owner.displayName, current: true }, { ...member, name: member.displayName, current: false }],
    },
  };
  const { container, unmount } = await mount();
  const text = container.textContent ?? "";
  assert.doesNotMatch(text, /Users unavailable/);
  assert.match(text, /Max/);
  assert.match(text, /Olena/);
  assert.match(text, /Add or change users in a browser signed in to this server\./);
  assert.match(text, /Change your name, password and passkeys in a browser signed in to this server/);
  // No control that the phone's connection would refuse.
  const buttons = [...container.querySelectorAll("button")].map((button) => button.textContent ?? "");
  assert.equal(buttons.some((label) => /Add user/.test(label)), false, buttons.join(" | "));
  assert.equal(container.querySelector("button.users-self-card"), null);
  assert.ok(container.querySelector("div.users-self-card.is-readonly"));
  assert.equal(container.querySelector("button.user-row"), null);
  await unmount();
});

test("a phone without full access still says it may not view users", async () => {
  accounts = { status: 403, body: { error: "forbidden", message: "not allowed" } };
  const { container, unmount } = await mount();
  assert.match(container.textContent ?? "", /Users unavailable/);
  await unmount();
});
