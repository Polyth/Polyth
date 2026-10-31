import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import type { HarnessSnapshot } from "@polyth/contracts";
import type { NativePluginDto, NativePluginListDto, NativePluginMutationResponseDto } from "@polyth/contracts/capability-installations";
import type { WebPackageHost } from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
  cancelAnimationFrame: () => {},
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Posted = { path: string; body: Record<string, unknown> };
const posts: Posted[] = [];
let list: NativePluginListDto;
let reply: (body: Record<string, unknown>) => Promise<Response> = async () => json(confirmedWith());

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const confirmedWith = (over: Partial<NativePluginMutationResponseDto> = {}): NativePluginMutationResponseDto =>
  ({ outcome: "confirmed", operationId: "op", pendingRestart: false, list, ...over });

globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input), "http://localhost:3000");
  if (url.pathname === "/api/harnesses/fake/plugins" && (init?.method ?? "GET") === "GET") return json(list);
  if (url.pathname === "/api/harnesses/fake/plugins" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    posts.push({ path: `${url.pathname}${url.search}`, body });
    return reply(body);
  }
  return json({ message: "not found" }, 404);
}) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: HarnessPlugins } = await import("../widgets/HarnessPlugins.tsx");

const flush = async (rounds = 8) => {
  for (let index = 0; index < rounds; index++) await act(async () => { await Promise.resolve(); });
};
const buttons = (root: ParentNode, label: string): HTMLButtonElement[] =>
  [...root.querySelectorAll("button")].filter((item) =>
    (item.getAttribute("aria-label") ?? item.querySelector(".ui-btn-label")?.textContent ?? item.textContent)?.trim() === label);
const button = (root: ParentNode, label: string): HTMLButtonElement => {
  const found = buttons(root, label)[0];
  assert.ok(found, `missing button ${label}`);
  return found;
};
const click = async (root: ParentNode, label: string) => {
  const target = button(root, label);
  assert.equal(target.disabled, false, `${label} is disabled`);
  await act(async () => { target.click(); });
  await flush();
};
const typeInto = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = field.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const fieldLabelled = (root: ParentNode, label: string): HTMLInputElement | HTMLTextAreaElement => {
  const labelNode = [...root.querySelectorAll("label")].find((node) => node.querySelector(".settings-field-label")?.textContent?.startsWith(label));
  assert.ok(labelNode, `missing field ${label}`);
  const field = document.getElementById(labelNode.getAttribute("for")!) as HTMLInputElement | HTMLTextAreaElement | null;
  assert.ok(field, `missing control for ${label}`);
  return field;
};

const plugin = (id: string, scope: NativePluginDto["scope"]): NativePluginDto => ({
  harnessId: "fake", id, name: id, source: { kind: "npm", ref: id }, scope, enabled: true,
  evidence: { stage: "discovered", source: "fake" },
});
const listWith = (over: Partial<NativePluginListDto> = {}, supportOver: Partial<NativePluginListDto["support"]> = {}): NativePluginListDto => ({
  harnessId: "fake",
  support: { actions: ["install", "uninstall", "update"], installScopes: ["user", "project"], installHint: "npm:pkg", applies: "next-session", marketplaces: false, ...supportOver },
  plugins: [plugin("shared", "user"), plugin("shared", "project")],
  checkedAt: 1,
  ...over,
});
const alpha = { id: "p1", name: "Alpha", path: "/work/alpha" };
const { en } = await import("../src/i18n/en.ts");
const translate = (key: string, values: Record<string, string | number> = {}) =>
  ((en as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`));
const host = { errors: { friendly: (_action: string, cause: unknown) => String((cause as Error)?.message ?? cause) }, ui: { locale: { translate } } } as unknown as WebPackageHost;
const snapshot = { identity: { name: "Fake" }, context: { remote: false } } as unknown as HarnessSnapshot;

const mount = async (projectId?: string) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(HarnessPlugins, { host, harnessId: "fake", snapshot, projectId })); });
  await flush();
  return { container, unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
};

test("while one plugin action runs every mutating control is disabled and only that one is busy", async () => {
  posts.length = 0;
  list = listWith({ project: alpha });
  let release!: () => void;
  reply = () => new Promise((done) => { release = () => done(json(confirmedWith())); });
  const view = await mount("p1");
  const updates = buttons(view.container, "Update shared");
  assert.equal(updates.length, 2, "user and project rows of the same id");
  await act(async () => { updates[1]!.click(); });
  await flush();
  assert.deepEqual(posts.map((post) => post.body), [{ action: "update", plugin: "shared", scope: "project", confirm: true }]);
  const [userUpdate, projectUpdate] = buttons(view.container, "Update shared");
  assert.equal(projectUpdate!.getAttribute("aria-busy"), "true");
  assert.equal(userUpdate!.getAttribute("aria-busy"), null, "the same id in another scope is not shown as busy");
  for (const control of [userUpdate!, ...buttons(view.container, "Remove shared"), button(view.container, "Check again")]) {
    assert.equal(control.disabled, true, `${control.getAttribute("aria-label") ?? control.textContent} stays disabled`);
  }
  await act(async () => { release(); });
  await flush();
  assert.equal(button(view.container, "Update shared").disabled, false);
  await view.unmount();
});

test("without a project, project scopes are not offered and project rows cannot change", async () => {
  posts.length = 0;
  list = listWith();
  const view = await mount();
  assert.equal(view.container.querySelector(".picker-select .picker-chip"), null, "only user scope remains, so no scope picker");
  assert.match(view.container.textContent ?? "", /Open these settings from a project to install plugins for that project\./);
  assert.equal(buttons(view.container, "Update shared").length, 1, "the project row has no actions");
  await typeInto(fieldLabelled(view.container, "Plugin"), "npm:new");
  await click(view.container, "Review install");
  assert.match(view.container.querySelector('[aria-label="Confirm plugin install"]')?.textContent ?? "", /Install npm:new for user scope\?/);
  await view.unmount();
});

test("the install confirmation names the project for a project install", async () => {
  posts.length = 0;
  list = listWith({ project: alpha });
  reply = async () => json(confirmedWith());
  const view = await mount("p1");
  assert.match(view.container.textContent ?? "", /Only project Alpha \(\/work\/alpha\)|Every project on this machine/);
  const picker = view.container.querySelector<HTMLButtonElement>(".picker-select .picker-chip");
  assert.ok(picker);
  await act(async () => { picker.click(); });
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes("Project"));
  assert.ok(option);
  await act(async () => { option.click(); });
  await flush();
  assert.match(view.container.textContent ?? "", /Only project Alpha \(\/work\/alpha\), shared with the repository/);
  await typeInto(fieldLabelled(view.container, "Plugin"), "npm:new");
  await click(view.container, "Review install");
  assert.match(view.container.querySelector('[aria-label="Confirm plugin install"]')?.textContent ?? "", /Install npm:new for project Alpha \(\/work\/alpha\)\?/);
  await click(view.container, "Install");
  assert.deepEqual(posts.map((post) => [post.path, post.body]), [["/api/harnesses/fake/plugins?projectId=p1", { action: "install", plugin: "npm:new", scope: "project", confirm: true }]]);
  await view.unmount();
});

test("install options are validated inline, sent as an object and never shown in the confirmation", async () => {
  posts.length = 0;
  list = listWith({ plugins: [] }, { installScopes: ["user"], installOptions: true, applies: "runtime-restart" });
  reply = async () => json(confirmedWith({ pendingRestart: true }));
  const view = await mount();
  await typeInto(fieldLabelled(view.container, "Plugin"), "opencode-x");
  const options = fieldLabelled(view.container, "Options (JSON)");
  await typeInto(options, '["sk-secret"]');
  await click(view.container, "Review install");
  assert.match(view.container.textContent ?? "", /Options must be a JSON object/);
  assert.equal(view.container.querySelector('[aria-label="Confirm plugin install"]'), null);
  await typeInto(options, '{"apiKey": "sk-secret"}');
  await click(view.container, "Review install");
  const confirm = view.container.querySelector('[aria-label="Confirm plugin install"]')?.textContent ?? "";
  assert.match(confirm, /with the options you entered/);
  assert.doesNotMatch(confirm, /sk-secret/);
  await click(view.container, "Install");
  assert.deepEqual(posts[0]!.body, { action: "install", plugin: "opencode-x", scope: "user", options: { apiKey: "sk-secret" }, confirm: true });
  assert.match(view.container.textContent ?? "", /Installed opencode-x\. Restart the runtime to apply it\./);
  assert.doesNotMatch(view.container.textContent ?? "", /sk-secret/, "the field is cleared after a confirmed install");
  await view.unmount();
});

test("a pasted opencode.json is previewed, confirmed once and installed one by one until an unknown outcome", async () => {
  posts.length = 0;
  list = listWith({ plugins: [] }, { installScopes: ["user"], installOptions: true });
  reply = async (body) => json(body.plugin === "second" ? { outcome: "unknown", operationId: "op", pendingRestart: false } : confirmedWith());
  const view = await mount();
  await typeInto(fieldLabelled(view.container, "Plugin JSON"), JSON.stringify({ $schema: "x", model: "m", plugin: ["first", ["second", { token: "sk-secret" }], "third"] }));
  await click(view.container, "Preview");
  const preview = view.container.querySelector('[aria-label="Plugins to import"]');
  assert.equal(preview?.querySelectorAll("li").length, 3);
  assert.match(preview?.textContent ?? "", /With options/);
  assert.doesNotMatch(preview?.textContent ?? "", /sk-secret/, "the preview names entries with options but never shows them");
  assert.match(view.container.textContent ?? "", /Other settings are ignored: model\./);
  await click(view.container, "Review import");
  const confirm = view.container.querySelector('[aria-label="Confirm plugin import"]')?.textContent ?? "";
  assert.match(confirm, /Install 3 plugins for user scope\? Their options are included\./);
  assert.doesNotMatch(confirm, /sk-secret/);
  await click(view.container, "Install all");
  assert.deepEqual(posts.map((post) => post.body), [
    { action: "install", plugin: "first", scope: "user", confirm: true },
    { action: "install", plugin: "second", scope: "user", options: { token: "sk-secret" }, confirm: true },
  ], "stops after the unknown outcome; third is never sent");
  const notice = view.container.querySelector(".ui-notice")?.textContent ?? "";
  assert.match(notice, /Installed 1 of 3 plugins\..*Stopped at second because its result is not confirmed; 1 not tried\./s);
  assert.match(notice, /first — Installed\./);
  assert.match(notice, /second — The result is not confirmed/);
  await view.unmount();
});
