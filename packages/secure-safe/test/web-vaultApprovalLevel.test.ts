// Settings → Credential Vault: the per-key approval level for agent runs.
// A new key offers the four levels with "Full access only" preselected, the
// create body carries it, an edit sends it only when it changed, and the list
// shows the current level. Assert on strings only; never pass a DOM node to an
// assert.
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

const fullEntry = {
  id: "e1", handle: "CF_TOKEN", label: "Cloudflare token", purpose: "DNS updates", kind: "token", scope: "global",
  approval: "full", revision: 1, createdAt: 1, updatedAt: 1,
};
const alwaysEntry = {
  id: "e2", handle: "PAYMENTS_KEY", label: "Payments key", purpose: "", kind: "token", scope: "global",
  approval: "always", revision: 1, createdAt: 1, updatedAt: 1,
};
let listed: unknown[] = [fullEntry, alwaysEntry];
const created: Array<Record<string, unknown>> = [];
const patched: Array<{ id: string; body: Record<string, unknown> }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), "http://localhost").pathname;
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  if (path === "/api/secure-safe/access") return reply({ canManageSpace: true, personal: false });
  if (path === "/api/secure-safe" && method === "GET") return reply(listed);
  if (path === "/api/secure-safe" && method === "POST") {
    created.push(body);
    const entry = { id: "e3", revision: 1, createdAt: 2, updatedAt: 2, kind: "token", scope: "global", ...body } as Record<string, unknown>;
    listed = [...listed, entry];
    return reply(entry);
  }
  if (path.startsWith("/api/secure-safe/") && method === "PATCH") {
    const id = decodeURIComponent(path.slice("/api/secure-safe/".length));
    patched.push({ id, body });
    return reply({ ...(listed as Array<Record<string, unknown>>).find((entry) => entry.id === id), ...body });
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

function buttons(host: Element): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("button")];
}

function approvalTrigger(host: Element): HTMLButtonElement {
  const trigger = host.querySelector<HTMLButtonElement>("form.credential-vault-form .picker-select .picker-chip");
  assert.ok(trigger, "the form uses the shared Select for the approval level");
  return trigger;
}

async function chooseLevel(host: Element, label: string) {
  await act(async () => { approvalTrigger(host).click(); await Promise.resolve(); });
  const option = [...document.querySelectorAll<HTMLElement>(".picker-item")]
    .find((item) => item.textContent?.includes(label));
  assert.ok(option, `the picker lists ${label}`);
  await act(async () => { option.click(); await Promise.resolve(); });
}

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(CredentialVaultPage)));
  await settle();
  return { host, root, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

test("a new key offers the four levels with Full access only preselected", async () => {
  const page = await mount();
  try {
    assert.match(approvalTrigger(page.host).textContent ?? "", /Full access only/);
    await act(async () => { approvalTrigger(page.host).click(); await Promise.resolve(); });
    const options = [...document.querySelectorAll<HTMLElement>(".picker-item")].map((item) => item.textContent ?? "");
    for (const label of ["Fully safe", "Safe with Auto-approve", "Full access only", "Always ask"]) {
      assert.ok(options.some((text) => text.includes(label)), `the picker lists ${label}: ${options.join(" | ")}`);
    }
    // The one-line description of each level is shown with it.
    assert.ok(options.some((text) => text.includes("Every use asks, even under Full access.")), "levels carry their description");
  } finally {
    await page.unmount();
  }
});

test("saving a new key sends the chosen approval level", async () => {
  const page = await mount();
  try {
    const inputs = [...page.host.querySelectorAll("form.credential-vault-form input")];
    const [label, handle, , secret] = inputs;
    await act(async () => {
      type(label!, "Stripe key");
      type(handle!, "STRIPE_KEY");
      type(secret!, "value-1");
    });
    await chooseLevel(page.host, "Safe with Auto-approve");
    await act(async () => {
      page.host.querySelector("form.credential-vault-form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    });
    await settle();

    assert.equal(created.length, 1);
    assert.equal(created[0]!.approval, "auto");
    assert.equal(created[0]!.handle, "STRIPE_KEY");
    assert.equal("value" in created[0]!, true);
  } finally {
    await page.unmount();
  }
});

test("the list shows each key's level", async () => {
  const page = await mount();
  try {
    const levels = [...page.host.querySelectorAll(".credential-vault-approval")].map((node) => node.textContent ?? "");
    assert.deepEqual(levels.slice(0, 2), ["Full access only", "Always ask"]);
  } finally {
    await page.unmount();
  }
});

test("an edit sends approval only when the level changed", async () => {
  const page = await mount();
  try {
    const edit = buttons(page.host).find((button) => button.textContent === "Edit");
    assert.ok(edit, "the entry row offers Edit");
    await act(async () => { edit.click(); await Promise.resolve(); });
    await settle();

    // Saving without touching the level keeps the patch free of approval.
    await act(async () => {
      page.host.querySelector("form.credential-vault-form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    });
    await settle();
    assert.equal(patched.length, 1);
    assert.equal("approval" in patched[0]!.body, false, "unchanged level is not sent");

    const editAgain = buttons(page.host).find((button) => button.textContent === "Edit");
    assert.ok(editAgain);
    await act(async () => { editAgain.click(); await Promise.resolve(); });
    await settle();
    await chooseLevel(page.host, "Always ask");
    await act(async () => {
      page.host.querySelector("form.credential-vault-form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    });
    await settle();

    assert.equal(patched.length, 2);
    assert.equal(patched[1]!.id, "e1");
    assert.deepEqual(patched[1]!.body, { handle: "CF_TOKEN", label: "Cloudflare token", purpose: "DNS updates", approval: "always" });
  } finally {
    await page.unmount();
  }
});
