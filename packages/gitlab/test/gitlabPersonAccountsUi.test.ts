// "Your GitLab accounts" and, for Space admins, "Space GitLab accounts"
// (Spaces §14.4).
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { WebPackageHost } from "@polyth/web-sdk";

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
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://127.0.0.1:4400");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
  requests.push({ method, path: url.pathname, ...(body ? { body } : {}) });
  if (url.pathname === "/api/gitlab/me/accounts" && method === "POST") {
    if (body?.instance === "nope") return json({ ok: false, code: "invalid-input", reason: "GitLab instance URL is invalid" }, 400);
    rows = [...rows, { id: "p-00000000-0000-4000-8000-000000000003", origin: String(body?.instance), login: "ada", label: "ada", enabled: true, createdAt: 1, updatedAt: 1 }];
  }
  if (url.pathname.startsWith("/api/gitlab/me/accounts")) return json({ ok: true, data: rows });
  if (url.pathname === "/api/gitlab/accounts") return json({ ok: true, data: [{ id: "svc", instanceId: "https://gitlab.com", username: "deploy-bot", label: "Deploy", authKind: "pat" }] });
  return json({ ok: false, code: "not-found", reason: "unexpected" }, 404);
}) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { GitlabAccountSettings, GitlabSpaceAccounts, gitlabErrorText } = await import("../widgets/PersonAccounts.tsx");
const { installGitlabAccounts } = await import("../widgets/Accounts.tsx");
const ui = await import("../../../apps/web/src/components/ui/index.ts");

const host = {
  ui: { components: ui, locale: { get: () => "en" } },
  navigation: { openSettingsPage: () => {} },
} as unknown as WebPackageHost;
const flush = async (rounds = 8) => {
  for (let index = 0; index < rounds; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const setValue = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
};
const submit = (form: HTMLFormElement) => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
async function mount(space: boolean) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(space ? GitlabSpaceAccounts : GitlabAccountSettings, { host })); });
  await flush();
  return { container, unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

test("GitLab refusals keep their reason", () => {
  assert.equal(gitlabErrorText(new Error(JSON.stringify({ ok: false, code: "invalid-input", reason: "Enter a GitLab token." }))), "Enter a GitLab token.");
  assert.equal(gitlabErrorText(new Error("plain")), "plain");
});

test("members connect their own GitLab account and never see the Space's", async () => {
  requests.length = 0;
  rows = [];
  const view = await mount(false);
  try {
    const text = view.container.textContent ?? "";
    assert.equal(view.container.querySelector(".settings-section-title")?.textContent, "GitLab");
    assert.doesNotMatch(text, /Space GitLab accounts/);
    assert.equal(requests.some((row) => row.path === "/api/gitlab/accounts"), false, "a member does not read the Space's accounts");
    const connect = [...view.container.querySelectorAll("button")].find((button) => button.textContent === "Connect account");
    assert.ok(connect, "the empty state offers to connect one");
    await act(async () => { connect.click(); });
    const token = view.container.querySelector<HTMLInputElement>('input[type="password"]');
    assert.ok(token);
    const [, , server] = [...view.container.querySelectorAll<HTMLInputElement>("form input")];
    await act(async () => { setValue(token, "glpat-1"); setValue(server!, "nope"); });
    await act(async () => { submit(view.container.querySelector("form")!); });
    await flush();
    assert.equal(token.value, "");
    assert.match(view.container.querySelector('[role="alert"]')?.textContent ?? "", /instance URL is invalid/);

    await act(async () => { setValue(token, "glpat-2"); setValue(server!, ""); });
    await act(async () => { submit(view.container.querySelector("form")!); });
    await flush();
    assert.deepEqual(requests.filter((row) => row.method === "POST").at(-1)?.body, { token: "glpat-2", instance: "https://gitlab.com" });
    assert.match(view.container.textContent ?? "", /@ada/);
  } finally {
    await view.unmount();
  }
});

test("the Space's shared GitLab accounts render on the Space tab, and only for Space admins", async () => {
  const registered: Array<{ slot: string; render: (props: Record<string, unknown>) => unknown }> = [];
  installGitlabAccounts({ ...host, slots: { register: (entry: { slot: string; render: (props: Record<string, unknown>) => unknown }) => { registered.push(entry); return () => {}; } } } as unknown as WebPackageHost);
  const space = registered.find((entry) => entry.slot === "settings.integrations.space");
  assert.ok(space, "GitLab contributes to the Space tab");
  assert.equal(space.render({ spaceAdmin: false }), null, "members get nothing there");
  assert.notEqual(space.render({ spaceAdmin: true }), null);
  assert.ok(registered.some((entry) => entry.slot === "settings.integrations"), "everyone's own accounts stay on the Accounts tab");

  requests.length = 0;
  rows = [];
  const view = await mount(true);
  try {
    assert.match(view.container.textContent ?? "", /Space GitLab accounts/);
    assert.match(view.container.textContent ?? "", /deploy-bot/);
  } finally {
    await view.unmount();
  }
});
