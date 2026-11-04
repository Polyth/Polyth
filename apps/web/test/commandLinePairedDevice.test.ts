// Settings > Command line on a paired phone: mount the real page against a
// mocked server. A full-access device reads its tokens; changes need a browser.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1/?settings=command-line" });
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

const token = { id: "tok_1", kind: "automation", label: "ci-runner", grants: ["core.sessions.read"], spaceId: null, createdAt: 1, lastUsedAt: null, expiresAt: null, revision: 1 };
let cli: { status: number; body: unknown } = { status: 200, body: {} };
const json = (status: number, body: unknown) => ({ ok: status < 400, status, statusText: "", headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
(globalThis as { fetch?: unknown }).fetch = async (path: string) => {
  if (path === "/api/auth/cli") return json(cli.status, cli.body);
  if (path === "/api/spaces") return json(200, { activeSpaceId: "spc_1", spaces: [{ id: "spc_1", name: "Home", role: "owner" }] });
  return json(404, { error: "not-found" });
};

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: CommandLinePage } = await import("../src/components/settings/CommandLinePage.tsx");

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(CommandLinePage)); });
  await settle();
  return { container, unmount: () => act(async () => { root.unmount(); container.remove(); }) };
}

const profiles = { read: ["core.sessions.read"], control: ["core.sessions.message"] };

test("a full-access phone lists its tokens read-only and points changes to a browser", async () => {
  cli = { status: 200, body: { tokens: [token], profiles, trust: { mode: "off", revision: 0 }, canManageTrust: false, readOnly: true } };
  const { container, unmount } = await mount();
  const text = container.textContent ?? "";
  assert.doesNotMatch(text, /could not be loaded/);
  assert.match(text, /ci-runner/);
  assert.match(text, /in a browser signed in to this server/);
  // No control that the phone's connection would refuse.
  assert.equal(container.querySelector(".cli-token-revoke"), null);
  assert.equal(container.querySelector(".cli-code-form"), null);
  assert.equal(container.querySelector(".cli-create-form"), null);
  assert.equal(container.querySelector(".cli-trust"), null);
  await unmount();
});

test("a signed-in browser keeps every control", async () => {
  cli = { status: 200, body: { tokens: [token], profiles, trust: { mode: "off", revision: 0, userId: "usr_owner" }, canManageTrust: true } };
  const { container, unmount } = await mount();
  assert.doesNotMatch(container.textContent ?? "", /in a browser signed in to this server/);
  assert.ok(container.querySelector(".cli-token-revoke"));
  assert.ok(container.querySelector(".cli-code-form"));
  assert.ok(container.querySelector(".cli-create-form"));
  assert.ok(container.querySelector(".cli-trust"));
  await unmount();
});

test("a phone without full access still says the page could not be loaded", async () => {
  cli = { status: 403, body: { error: "forbidden", message: "not allowed" } };
  const { container, unmount } = await mount();
  assert.match(container.textContent ?? "", /could not be loaded/);
  await unmount();
});
