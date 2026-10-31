// Settings → Source control → Accounts → "GitHub" (Spaces §14.4): connect
// with a token that is cleared once sent, turn an account on per Space,
// remove it from the row's ⋯ menu.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("../../git/test/tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
  cancelAnimationFrame: () => {},
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Row = { id: string; origin: string; login: string; label: string; enabled: boolean; createdAt: number; updatedAt: number };
const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
let rows: Row[] = [];
let installation = false;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://127.0.0.1:4400");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
  requests.push({ method, path: url.pathname, ...(body ? { body } : {}) });
  const id = /^\/api\/github\/accounts\/([^/]+)/.exec(url.pathname)?.[1];
  if (url.pathname === "/api/github/accounts" && method === "POST") {
    if (body?.token === "bad") return json({ error: "auth-rejected", message: "GitHub rejected this token." }, 400);
    const row = { id: "p-00000000-0000-4000-8000-000000000001", origin: String(body?.origin ?? "https://github.com"), login: "ada", label: String(body?.label ?? "ada"), enabled: true, createdAt: 1, updatedAt: 1 };
    rows = [...rows, row];
    return json({ ok: true, data: row });
  }
  if (id && url.pathname.endsWith("/enabled") && method === "PUT") rows = rows.map((row) => row.id === id ? { ...row, enabled: body?.enabled === true } : row);
  if (id && method === "DELETE") rows = rows.filter((row) => row.id !== id);
  if (url.pathname.startsWith("/api/github/accounts")) return json({ ok: true, data: rows, installation });
  return json({ error: "not-found", message: "unexpected" }, 404);
}) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: GithubAccounts, accountDetail } = await import("../widgets/GithubAccounts.tsx");
const { resolveAlert } = await import("../../../apps/web/src/alerts.ts");

const flush = async (rounds = 8) => {
  for (let index = 0; index < rounds; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const setValue = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
};
const submit = (form: HTMLFormElement) => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(GithubAccounts)); });
  await flush();
  return { container, unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

test("an account row names another server and whether it is on here", () => {
  assert.equal(accountDetail({ origin: "https://ghe.example.com", enabled: false }, "https://github.com"), "ghe.example.com · Off in this Space");
  assert.equal(accountDetail({ origin: "https://github.com", enabled: true }, "https://github.com"), "On in this Space");
});

test("connecting sends the token once and clears it, even when GitHub refuses it", async () => {
  requests.length = 0;
  rows = [];
  installation = true;
  const view = await mount();
  try {
    assert.equal(view.container.querySelector(".settings-section-title")?.textContent, "GitHub");
    assert.match(view.container.textContent ?? "", /No GitHub account yet/);
    assert.match(view.container.textContent ?? "", /server’s own gh sign-in works for you/, "the instance owner learns about the host fallback");
    assert.equal(view.container.querySelector('input[type="password"]'), null, "the empty state offers the form instead of opening it");
    const connect = [...view.container.querySelectorAll("button")].find((button) => button.textContent === "Connect account");
    assert.ok(connect);
    await act(async () => { connect.click(); });
    const token = view.container.querySelector<HTMLInputElement>('input[type="password"]');
    assert.ok(token, "the token field is a password field");
    assert.equal(token.getAttribute("autocomplete"), "off");

    await act(async () => { setValue(token, "bad"); });
    await act(async () => { submit(view.container.querySelector("form")!); });
    await flush();
    assert.equal(token.value, "", "a refused token is not kept in the form");
    assert.match(view.container.querySelector('[role="alert"]')?.textContent ?? "", /rejected this token/);

    const [, label] = [...view.container.querySelectorAll<HTMLInputElement>("form input")];
    await act(async () => { setValue(token, " ghp_secret "); setValue(label!, "Work"); });
    await act(async () => { submit(view.container.querySelector("form")!); });
    await flush();
    const post = requests.filter((row) => row.method === "POST").at(-1);
    assert.deepEqual(post?.body, { token: "ghp_secret", label: "Work" });
    assert.equal(view.container.querySelector('input[type="password"]'), null, "the form closes once an account exists");
    assert.match(view.container.textContent ?? "", /@ada/);
    assert.equal(JSON.stringify(view.container.innerHTML).includes("ghp_secret"), false, "the token never reaches the page");
  } finally {
    await view.unmount();
  }
});

test("an account turns off in this Space and is removed after confirmation", async () => {
  requests.length = 0;
  rows = [{ id: "p-00000000-0000-4000-8000-000000000002", origin: "https://github.com", login: "ada", label: "ada", enabled: true, createdAt: 1, updatedAt: 1 }];
  const view = await mount();
  try {
    const toggle = view.container.querySelector<HTMLElement>('[role="switch"]');
    assert.ok(toggle);
    assert.equal(toggle.getAttribute("aria-label"), "Use @ada in this Space");
    await act(async () => { toggle.click(); });
    await flush();
    assert.deepEqual(requests.find((row) => row.method === "PUT")?.body, { enabled: false });
    assert.match(view.container.textContent ?? "", /Off in this Space/);

    const more = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "More actions for @ada");
    assert.ok(more, "Remove sits behind the row's ⋯ menu");
    await act(async () => { more.click(); });
    await flush(2);
    const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.trim() === "Remove");
    assert.ok(remove);
    await act(async () => { remove.click(); });
    await flush(2);
    await act(async () => { resolveAlert(true); });
    await flush();
    assert.ok(requests.some((row) => row.method === "DELETE" && row.path === "/api/github/accounts/p-00000000-0000-4000-8000-000000000002"));
    assert.doesNotMatch(view.container.textContent ?? "", /@ada/);
  } finally {
    await view.unmount();
  }
});
