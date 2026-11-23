// Settings → Credential Vault: a short name that is already taken (for
// example saved earlier from a chat request) must say so, not "could not save".
// Assert on strings only; never pass a DOM node to an assert.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });

const existing = {
  id: "e1", handle: "CF_TOKEN", label: "Cloudflare token", purpose: "", kind: "token", scope: "global",
  revision: 1, createdAt: 1, updatedAt: 1,
};
let listed: unknown[] = [];
const posts: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), "http://localhost").pathname;
  const method = init?.method ?? "GET";
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  if (path === "/api/secure-safe/access") return reply({ canManageSpace: true, personal: false });
  if (path === "/api/secure-safe" && method === "GET") return reply(listed);
  if (path === "/api/secure-safe" && method === "POST") {
    posts.push(path);
    listed = [existing]; // saved meanwhile elsewhere
    return reply({ error: "conflict", message: 'a Credential Vault entry with handle "CF_TOKEN" already exists' }, 409);
  }
  return reply({ error: "not-found" }, 404);
}) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: CredentialVaultPage } = await import("../widgets/CredentialVaultPage.tsx");

const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); });

function type(input: Element, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, text);
  input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
}

test("a taken short name explains the conflict and shows the existing entry", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(CredentialVaultPage)));
  await settle();

  const inputs = [...host.querySelectorAll("form.credential-vault-form input")];
  const [label, handle, , secret] = inputs;
  await act(async () => {
    type(label!, "Cloudflare");
    type(handle!, "CF_TOKEN");
    type(secret!, "value-1");
  });
  await act(async () => {
    host.querySelector("form.credential-vault-form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
  });
  await settle();

  assert.equal(posts.length, 1);
  const alert = host.querySelector(".credential-vault-status")?.textContent ?? "";
  assert.match(alert, /CF_TOKEN/);
  assert.match(alert, /already exists/);
  assert.doesNotMatch(alert, /Could not save/);
  assert.equal(host.textContent?.includes("Cloudflare token"), true, "existing entry is listed after the conflict");
  assert.equal((secret as HTMLInputElement).value, "", "the value is still cleared");

  await act(async () => root.unmount());
  host.remove();
});
