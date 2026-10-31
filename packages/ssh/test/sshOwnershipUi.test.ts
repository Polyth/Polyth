// Settings → SSH remotes ownership (Spaces §14.6): your servers vs shared
// ones, adding as the instance owner or a member, the personal key upload and
// the instance owner's access editor.
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
  ResizeObserver: dom.ResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
  cancelAnimationFrame: () => {},
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Conn = Record<string, unknown> & { id: string; name: string };
const requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
let list: { items: Conn[]; canAddShared: boolean; canAddPersonal: boolean } = { items: [], canAddShared: false, canAddPersonal: false };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://127.0.0.1:4400");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
  requests.push({ method, path: url.pathname, ...(body ? { body } : {}) });
  if (url.pathname === "/api/projects") return json([]);
  if (url.pathname === "/api/ssh/connections" && method === "GET") return json(list);
  if (url.pathname === "/api/ssh/connections" && method === "POST") {
    const created = { id: body?.owner === "person" ? "u.me.1" : "c.2", name: String(body?.name || body?.host), host: String(body?.host), authMode: body?.owner === "person" ? "identity-file" : "agent", owner: body?.owner, mine: true, editable: true, createdAt: 1, ...(body?.owner === "person" ? { keyUploaded: false } : { allowedUserIds: [], allowedSpaceIds: [] }) };
    list = { ...list, items: [...list.items, created] };
    return json(created);
  }
  const key = /^\/api\/ssh\/connections\/([^/]+)\/key$/.exec(url.pathname);
  if (key && method === "PUT") {
    const conn = list.items.find((item) => item.id === decodeURIComponent(key[1]!))!;
    return json({ ...conn, keyUploaded: true });
  }
  const access = /^\/api\/ssh\/connections\/([^/]+)\/access$/.exec(url.pathname);
  if (access && method === "PUT") {
    const conn = list.items.find((item) => item.id === decodeURIComponent(access[1]!))!;
    return json({ ...conn, ...body });
  }
  if (/\/harnesses$/.test(url.pathname)) return json({ items: [] });
  if (url.pathname === "/api/auth/accounts") return json({ accounts: [{ id: "u_owner", name: "Owner" }, { id: "u_ann", name: "Ann" }] });
  if (url.pathname === "/api/spaces") return json({ spaces: [{ id: "sp_home", name: "Home" }, { id: "sp_work", name: "Work" }], activeSpaceId: "sp_home" });
  return json({ error: "not-found", message: `unexpected ${method} ${url.pathname}` }, 404);
}) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: SshSettings } = await import("../widgets/ssh/SshSettings.tsx");
const model = await import("../widgets/ssh/sshAccess.ts");
const { emptySshForm, formToInput, validateSshForm, connectionSummary } = await import("../widgets/ssh/sshUi.ts");

const flush = async (rounds = 10) => {
  for (let index = 0; index < rounds; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const setValue = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = input instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(input, value);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }) as unknown as Event);
};
const submit = (form: HTMLFormElement) => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
const buttonIn = (root: ParentNode, label: RegExp) =>
  [...root.querySelectorAll("button")].find((button) => label.test(button.textContent ?? "") || label.test(button.getAttribute("aria-label") ?? ""));
async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(SshSettings)); });
  await flush();
  return { container, unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}
const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n";

test("ownership model: groups, owner choices, access summaries and body", () => {
  const groups = model.groupConnections([
    { id: "a", owner: "installation" }, { id: "b", owner: "person" }, { id: "c" },
  ] as never);
  assert.deepEqual(groups.mine.map((row) => row.id), ["b"]);
  assert.deepEqual(groups.shared.map((row) => row.id), ["a", "c"]);
  assert.deepEqual(model.addOwnerChoices({ canAddShared: true, canAddPersonal: true }), ["installation", "person"]);
  assert.deepEqual(model.addOwnerChoices({ canAddShared: false, canAddPersonal: true }), ["person"]);
  assert.deepEqual(model.addOwnerChoices({}), []);
  assert.equal(model.sshAccessSummary({ allowedUserIds: [], allowedSpaceIds: [] }), "Only you");
  assert.equal(model.sshAccessSummary({ allowedUserIds: ["u_ann"], allowedSpaceIds: ["sp_work", "sp_x"] }, [{ id: "u_ann", name: "Ann" }]), "You · Ann · everyone in 2 Spaces");
  assert.deepEqual(model.sshAccessBody({ userIds: ["u", "u"], spaceIds: [] }), { allowedUserIds: ["u"], allowedSpaceIds: [] });
  assert.equal(model.accessEditable({ owner: "installation", allowedUserIds: [], allowedSpaceIds: [] }), true);
  assert.equal(model.accessEditable({ owner: "installation" }), false, "only the instance owner receives allowlists");
  assert.equal(model.accessEditable({ owner: "person", allowedUserIds: [], allowedSpaceIds: [] }), false);
  assert.equal(model.sshKeyProblem(KEY), null);
  assert.match(model.sshKeyProblem("ssh-ed25519 AAAA user@host") ?? "", /doesn't look like a private key/);
  assert.match(model.sshKeyProblem("") ?? "", /Paste a private key/);
});

test("a personal connection sends no auth fields and needs no key path", () => {
  const values = { ...emptySshForm, host: "box.example", authMode: "identity-file" as const, identityFile: "" };
  assert.equal(validateSshForm(values, true), null);
  assert.ok(validateSshForm(values, false), "a shared key-file connection still needs its path");
  const input = formToInput(values, true);
  assert.equal("authMode" in input, false);
  assert.equal("identityFile" in input, false);
  assert.deepEqual(connectionSummary({ authMode: "identity-file", owner: "person", keyUploaded: false }, 0), [], "the row state says the key is missing");
  assert.deepEqual(connectionSummary({ authMode: "identity-file", owner: "person", keyUploaded: true }, 0), ["Your key"]);
});

test("a member who may not add servers sees shared ones quietly, without management actions", async () => {
  requests.length = 0;
  list = { items: [{ id: "c.1", name: "Build box", host: "build.example", authMode: "agent", owner: "installation", mine: false, editable: false, createdAt: 1 }], canAddShared: false, canAddPersonal: false };
  const view = await mount();
  try {
    const text = view.container.textContent ?? "";
    assert.match(text, /Adding servers is not available to you/);
    assert.equal(buttonIn(view.container, /^Add server$/), undefined);
    await act(async () => { view.container.querySelector<HTMLButtonElement>(".ssh-row-main")!.click(); });
    await flush();
    assert.match(view.container.textContent ?? "", /changing it is not available to you/);
    assert.equal(buttonIn(view.container, /^Disconnect$/), undefined);
    const connection = buttonIn(view.container, /^Connection$/);
    await act(async () => { connection!.click(); });
    await flush();
    assert.equal(buttonIn(view.container, /^Edit$/), undefined, "a shared server is edited only by the server owner");
    assert.equal(buttonIn(view.container, /^Delete$/), undefined);
    assert.match(view.container.textContent ?? "", /The server owner/);
  } finally {
    await view.unmount();
  }
});

test("a member adds their own server, uploads its key, and the key leaves the form", async () => {
  requests.length = 0;
  list = { items: [], canAddShared: false, canAddPersonal: true };
  const view = await mount();
  try {
    await act(async () => { buttonIn(view.container, /^Add server$/)!.click(); });
    await flush();
    assert.equal(view.container.querySelector(".ssh-form-owner"), null, "a member has no owner choice to make");
    assert.doesNotMatch(view.container.textContent ?? "", /Private key file/);
    const inputs = [...view.container.querySelectorAll<HTMLInputElement>(".ssh-form input")];
    await act(async () => { setValue(inputs[1]!, "box.example"); });
    await act(async () => { submit(view.container.querySelector<HTMLFormElement>(".ssh-form")!); });
    await flush();
    const post = requests.find((row) => row.method === "POST" && row.path === "/api/ssh/connections");
    assert.deepEqual(post?.body, { host: "box.example", name: "", user: "", owner: "person" });

    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog, "the key dialog opens right after adding");
    const keyInput = dialog.querySelector<HTMLTextAreaElement>("textarea.ssh-key-input");
    assert.ok(keyInput);
    assert.equal(keyInput.getAttribute("autocomplete"), "off");
    await act(async () => { setValue(keyInput, KEY); });
    await act(async () => { buttonIn(dialog, /^Upload key$/)!.click(); });
    await flush();
    const put = requests.find((row) => row.method === "PUT" && row.path === "/api/ssh/connections/u.me.1/key");
    assert.equal(put?.body?.privateKey, KEY);
    assert.equal(document.querySelector("textarea.ssh-key-input"), null, "the dialog closes and drops the key");
    assert.match(view.container.textContent ?? "", /Your uploaded private key/);
    assert.equal(document.body.innerHTML.includes("b3BlbnNzaC1rZXktdjEAAAAA"), false, "the key is not left in the page");
  } finally {
    await view.unmount();
  }
});

test("the instance owner chooses the owner when adding and edits who may use a shared server", async () => {
  requests.length = 0;
  list = { items: [{ id: "c.1", name: "Build box", host: "build.example", authMode: "agent", owner: "installation", mine: true, editable: true, allowedUserIds: [], allowedSpaceIds: [], createdAt: 1 }], canAddShared: true, canAddPersonal: true };
  const view = await mount();
  try {
    assert.match(view.container.textContent ?? "", /Your servers/);
    assert.match(view.container.textContent ?? "", /Shared servers/);
    assert.match(view.container.textContent ?? "", /Only you/);
    await act(async () => { buttonIn(view.container, /^Add server$/)!.click(); });
    await flush();
    assert.ok(view.container.querySelector(".ssh-form-owner"), "the owner picks shared or only me");
    await act(async () => { buttonIn(view.container, /Back|SSH servers/)?.click(); });
    await flush();

    await act(async () => { view.container.querySelector<HTMLButtonElement>(".ssh-row-main")!.click(); });
    await flush();
    await act(async () => { buttonIn(view.container, /^Connection$/)!.click(); });
    await flush();
    await act(async () => { buttonIn(view.container, /^Access for Build box$/)!.click(); });
    await flush();
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    const ann = [...dialog.querySelectorAll("label")].find((label) => /Ann/.test(label.textContent ?? ""));
    assert.ok(ann, "people are listed by name");
    await act(async () => { ann.querySelector("input")!.click(); });
    await act(async () => { buttonIn(dialog, /^Save$/)!.click(); });
    await flush();
    assert.deepEqual(requests.find((row) => row.method === "PUT" && row.path === "/api/ssh/connections/c.1/access")?.body, { allowedUserIds: ["u_ann"], allowedSpaceIds: [] });
    assert.match(view.container.textContent ?? "", /You · Ann/);
  } finally {
    await view.unmount();
  }
});
