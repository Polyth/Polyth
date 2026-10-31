// Settings > Command line: mount the real page against a mocked server.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/?settings=command-line&code=abcd-1234" });
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

const calls: Array<{ path: string; method: string; body: unknown }> = [];
const json = (status: number, body: unknown) => ({ ok: status < 400, status, statusText: "", headers: { get: () => null }, json: async () => body, text: async () => "" });
(globalThis as { fetch?: unknown }).fetch = async (path: string, init?: { method?: string; body?: string }) => {
  const body = init?.body ? JSON.parse(init.body) : undefined;
  calls.push({ path, method: init?.method ?? "GET", body });
  if (path === "/api/auth/status") return json(200, { required: true, authorized: true, scope: "ui-session", state: "ready", csrfToken: "a".repeat(64) });
  if (path === "/api/auth/cli") {
    return json(200, {
      tokens: [{ id: "tok_1", kind: "automation", label: "CI notifier", grants: ["core.sessions.read"], spaceId: null, createdAt: 1, lastUsedAt: null, expiresAt: null, revision: 3 }],
      profiles: { read: ["core.sessions.read"], control: ["core.sessions.read", "core.sessions.message"] },
      trust: { mode: "off", revision: 1 },
      canManageTrust: true,
    });
  }
  if (path === "/api/auth/cli/device/lookup") {
    return json(200, { userCode: body.userCode, label: "alice@laptop", profile: "control", grants: ["core.sessions.read", "core.sessions.message"], clientAddress: "192.168.1.5", createdAt: 1, expiresAt: Date.now() + 60_000 });
  }
  if (path === "/api/auth/cli/device/decide") return json(200, { ok: true });
  return json(404, { error: "not-found" });
};

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: CommandLinePage } = await import("../src/components/settings/CommandLinePage.tsx");

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

test("deep-link code is looked up, shown in plain words, approved, and removed from the URL", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(CommandLinePage)); });
  await settle();

  assert.equal(new URL(window.location.href).searchParams.has("code"), false);
  assert.equal(new URL(window.location.href).searchParams.get("settings"), "command-line");
  const lookup = calls.find((c) => c.path === "/api/auth/cli/device/lookup");
  assert.deepEqual(lookup?.body, { userCode: "ABCD-1234" });

  const text = container.textContent ?? "";
  assert.match(text, /alice@laptop/);
  assert.match(text, /start sessions, send messages, stop turns/);
  assert.match(text, /192\.168\.1\.5/);
  assert.match(text, /CI notifier/);
  assert.match(text, /No-token mode/);
  assert.match(text, /Only this Space|Create automation token/);

  const approve = [...container.querySelectorAll("button")].find((b) => b.textContent === "Approve") as HTMLButtonElement;
  assert.ok(approve);
  await act(async () => { approve.click(); });
  await settle();
  assert.deepEqual(calls.find((c) => c.path === "/api/auth/cli/device/decide")?.body, { userCode: "ABCD-1234", approve: true });
  assert.match(container.textContent ?? "", /The terminal is signed in/);
  await act(async () => { root.unmount(); });
});
