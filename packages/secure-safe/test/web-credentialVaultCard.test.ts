// A chat request for a credential: a sibling of the agent's question card
// (docs/dev/ui.md, "Agent request cards"). The value is write-only: it leaves
// the field the moment it is sent and never appears in the card.
// Assert on strings and booleans only; never pass a DOM node to an assert.
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

let access = { canManageSpace: false, personal: false };
const replies: Array<{ path: string; body: unknown }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), "http://localhost").pathname;
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  if (path === "/api/secure-safe/access") return reply(access);
  if (path.startsWith("/api/sessions/") && init?.method === "POST") {
    replies.push({ path, body: JSON.parse(String(init.body)) });
    return reply({ ok: true });
  }
  return reply({ error: "not-found" }, 404);
}) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: CredentialVaultCard } = await import("../widgets/CredentialVaultCard.tsx");

const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); });

function type(input: Element, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, text);
  input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
}

const secret = {
  sessionId: "session/1",
  requestId: "request/1",
  handle: "openrouter-api-key",
  label: "OpenRouter API key",
  purpose: "Check the OpenRouter balance",
  kind: "api_key",
  status: "pending" as const,
  time: 1,
};

async function mount(secrets: unknown[]) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(CredentialVaultCard, { secrets: secrets as never })); });
  await settle();
  return { host, unmount: () => act(async () => root.unmount()) };
}

test("a credential request reads as an agent request card and never shows the value", async () => {
  access = { canManageSpace: false, personal: false };
  replies.length = 0;
  const { host, unmount } = await mount([secret]);
  const card = host.querySelector(".question-card.credential-vault-request")!;
  assert.equal(Boolean(card), true);
  assert.equal(card.querySelector(".question-eyebrow")?.textContent, "Agent needs a key");
  assert.equal(card.querySelector(".credential-vault-title")?.textContent, "OpenRouter API key");
  assert.equal(card.querySelector(".credential-vault-title")?.getAttribute("title"), "openrouter-api-key");
  assert.equal(card.querySelector(".credential-vault-purpose-line")?.textContent, "Check the OpenRouter balance");
  assert.equal(card.querySelector(".credential-vault-note")?.textContent, "The agent won't see the key·only for you");
  assert.equal(card.querySelector(".credential-vault-note .picker-select") === null, true);
  // The handle is only the title's tooltip; there is no label/handle table.
  assert.equal(card.textContent?.includes("openrouter-api-key"), false);

  const input = card.querySelector<HTMLInputElement>(".credential-vault-well input")!;
  const save = card.querySelector<HTMLButtonElement>(".question-actions-end button[type=submit]")!;
  assert.equal(input.type, "password");
  assert.equal(save.disabled, true);
  assert.equal(card.querySelector(".credential-vault-well")?.hasAttribute("data-filled"), false);

  await act(async () => { type(input, "sk-or-one-use"); });
  assert.equal(save.disabled, false);
  assert.equal(card.querySelector(".credential-vault-well")?.getAttribute("data-filled"), "true");

  await act(async () => { save.click(); });
  await settle();
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.path, "/api/sessions/session%2F1/secrets/request%2F1");
  assert.deepEqual(replies[0]!.body, { action: "save", value: "sk-or-one-use" });
  assert.equal(input.value, "");
  assert.equal(host.innerHTML.includes("sk-or-one-use"), false);
  assert.equal(save.textContent, "Submitted");
  await unmount();
  host.remove();
});

test("Reject declines the request without a value", async () => {
  access = { canManageSpace: false, personal: false };
  replies.length = 0;
  const { host, unmount } = await mount([{ ...secret, existing: true }]);
  assert.equal(host.querySelector(".credential-vault-replaces")?.textContent, "replaces the saved one");
  const reject = host.querySelector<HTMLButtonElement>(".question-actions .question-reject")!;
  assert.equal(reject.textContent, "Reject");
  await act(async () => { reject.click(); });
  await settle();
  assert.deepEqual(replies.map((r) => r.body), [{ action: "dismiss" }]);
  await unmount();
  host.remove();
});

test("a Space admin picks the partition inside the sentence; several requests say so", async () => {
  access = { canManageSpace: true, personal: true };
  replies.length = 0;
  const { host, unmount } = await mount([secret, { ...secret, requestId: "request/2", handle: "github-token", label: "GitHub token", purpose: "" }]);
  const cards = host.querySelectorAll(".credential-vault-request");
  assert.equal(cards.length, 2);
  assert.equal(cards[0]!.querySelector(".question-eyebrow")?.textContent, "Agent needs keys");
  assert.equal(cards[0]!.querySelector(".question-progress")?.textContent, "2");
  assert.equal(cards[1]!.querySelector(".credential-vault-purpose-line") === null, true);
  assert.equal(cards[0]!.querySelector(".credential-vault-note .picker-select") !== null, true);

  const input = cards[0]!.querySelector<HTMLInputElement>(".credential-vault-well input")!;
  await act(async () => { type(input, "sk-admin-value"); });
  await act(async () => { cards[0]!.querySelector<HTMLButtonElement>("button[type=submit]")!.click(); });
  await settle();
  assert.deepEqual(replies.map((r) => r.body), [{ action: "save", value: "sk-admin-value", partition: "personal" }]);
  await unmount();
  host.remove();
});
