import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import type { HarnessSnapshot } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);
const { en: enMessages } = await import("../src/i18n/en.ts");
/** The shell's lookup over the package's English catalog. */
const enTranslate = (key: string, values: Record<string, string | number> = {}) =>
  ((enMessages as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_: string, name: string) => String(values[name] ?? `{${name}}`));

/** The accounts panel's lookup, under `harnessruntime.accounts.`. */
const accountsT = (key: string, values?: Record<string, string | number>) => enTranslate(`harnessruntime.accounts.${key}`, values);

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  sessionStorage: dom.sessionStorage,
  requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
  cancelAnimationFrame: () => {},
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Rec = { method: string; path: string; body?: unknown };
const requests: Rec[] = [];
let accountList: unknown;
let personDefault: { harnessId: string | null; usable: boolean } = { harnessId: null, usable: false };
let snapshots: HarnessSnapshot[] = [];

globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input), "http://localhost:3000");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
  requests.push({ method, path: url.pathname, body });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  if (url.pathname === "/api/claude/accounts" && method === "GET") return json(accountList);
  if (url.pathname.startsWith("/api/claude/accounts")) return json({ id: "x" }, method === "POST" ? 201 : 200);
  if (url.pathname === "/api/auth/accounts") return json({ currentAccountId: "usr_owner", accounts: [
    { id: "usr_owner", name: "Owner" }, { id: "u_ann", name: "Ann" }, { id: "u_old", name: "Old", status: "disabled" },
  ] });
  if (url.pathname === "/api/spaces") return json({ spaces: [{ id: "sp_home", name: "Home" }, { id: "sp_work", name: "Work" }], activeSpaceId: "sp_home" });
  if (url.pathname === "/api/harnesses/default") {
    if (method === "PUT") personDefault = { harnessId: (body as { harnessId: string | null }).harnessId, usable: true };
    return json(personDefault);
  }
  if (url.pathname === "/api/harnesses/access") return json({ manage: false, personal: true });
  if (url.pathname === "/api/harnesses/roster") return json(snapshots.map((row) => ({ identity: row.identity, policy: row.policy })));
  if (url.pathname === "/api/harnesses/snapshots") return json(snapshots);
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: HarnessAccounts } = await import("../widgets/HarnessAccounts.tsx");
const { HarnessSettings } = await import("../widgets/runtime.tsx");
const { accessBody, accessProblem, accessSummary, groupAccounts } = await import("../widgets/accountsModel.ts");

const flush = async (rounds = 6) => {
  for (let index = 0; index < rounds; index++) await act(async () => { await Promise.resolve(); });
};
const host = {
  slots: { register: () => () => {}, list: () => [] },
  store: { select: () => "p1", getSnapshot: () => ({ activeProjectId: "p1" } as never), subscribe: () => () => {} },
  errors: { friendly: (_action: string, cause: unknown) => cause instanceof Error ? cause.message : String(cause) },
  navigation: { setOverlay: () => {}, openWorkspacePane: () => {} },
  ui: { Slot: () => null, locale: { get: () => "en", translate: enTranslate } },
} as unknown as WebPackageHost;

const status = { loggedIn: true as const };
const mountAccounts = async () => {
  requests.length = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(HarnessAccounts, { host, accounts: { endpoint: "/api/claude/accounts" } as never, projectId: "p1" })); });
  await flush();
  return { container, unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
};
const buttons = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === text);
const headings = (scope: ParentNode) => [...scope.querySelectorAll("h4")].map((heading) => heading.textContent ?? "");
const typeInto = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new (dom as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
  });
};

test("account rows group into yours, shared and other people's, in server order", () => {
  const rows = [
    { id: "default", harnessId: "claude", name: "", removable: false, usable: true, status },
    { id: "work", harnessId: "claude-work", name: "Work", removable: true, private: true, mine: true, usable: true, status },
    { id: "bob", harnessId: "claude-bob", name: "Bob", removable: true, private: true, usable: false, status },
    { id: "team", harnessId: "claude-team", name: "Team", removable: true, usable: true, status },
  ];
  const groups = groupAccounts(rows);
  assert.deepEqual(groups.mine.map((row) => row.id), ["work"]);
  assert.deepEqual(groups.shared.map((row) => row.id), ["default", "team"]);
  assert.deepEqual(groups.others.map((row) => row.id), ["bob"]);
});

test("access text and request body: everyone is null, selections need a choice", () => {
  const people = [{ id: "u_ann", name: "Ann" }];
  const spaces = [{ id: "sp_work", name: "Work" }];
  assert.equal(accessSummary({}, [], [], accountsT), "Everyone");
  assert.equal(accessSummary({ allowedUserIds: ["u_ann"] }, people, spaces, accountsT), "Ann");
  assert.equal(accessSummary({ allowedUserIds: ["u_ann", "u_bo"], allowedSpaceIds: ["sp_work"] }, people, spaces, accountsT), "2 people · Work");
  assert.equal(accessSummary({ allowedSpaceIds: ["sp_work", "sp_x"] }, people, spaces, accountsT), "Everyone · 2 Spaces");
  assert.deepEqual(accessBody({ people: "everyone", userIds: ["u_ann"], spaces: "everyone", spaceIds: [] }), { allowedUserIds: null, allowedSpaceIds: null });
  assert.deepEqual(accessBody({ people: "selected", userIds: ["u_ann"], spaces: "selected", spaceIds: ["sp_work"] }), { allowedUserIds: ["u_ann"], allowedSpaceIds: ["sp_work"] });
  assert.match(accessProblem({ people: "selected", userIds: [], spaces: "everyone", spaceIds: [] }, accountsT) ?? "", /at least one person/);
  assert.equal(accessProblem({ people: "everyone", userIds: [], spaces: "everyone", spaceIds: [] }, accountsT), null);
});

test("a person with their own accounts sees Your/Shared groups and always adds a private account", async () => {
  accountList = {
    label: "Claude", manageable: true, canAddShared: false, canEditAccess: false,
    accounts: [
      { id: "default", harnessId: "claude", name: "", removable: false, usable: true, status },
      { id: "work", harnessId: "claude-work", name: "Work", removable: true, private: true, mine: true, usable: true, status },
    ],
  };
  const view = await mountAccounts();
  try {
    assert.deepEqual(headings(view.container), ["Your accounts", "Shared accounts"]);
    assert.equal(buttons(view.container, "Shared with others").length, 0, "only the owner chooses shared");
    assert.equal(buttons(view.container, "Access").length, 0);
    assert.match(view.container.textContent ?? "", /every agent still runs as the same system user/);
    await typeInto(view.container.querySelector<HTMLInputElement>('input[aria-label="Account name"]')!, "Home");
    await act(async () => { buttons(view.container, "Add account")[0]!.click(); });
    await flush();
    const post = requests.find((request) => request.method === "POST");
    assert.deepEqual(post?.body, { name: "Home" });
  } finally {
    await view.unmount();
  }
});

test("the owner chooses shared or only-me, sees unusable rows quietly and edits who can use a shared account", async () => {
  accountList = {
    label: "Claude", manageable: true, canAddShared: true, canEditAccess: true,
    accounts: [
      { id: "default", harnessId: "claude", name: "", removable: false, usable: true, status },
      { id: "team", harnessId: "claude-team", name: "Team", removable: true, usable: false, accessEditable: true, allowedUserIds: ["u_ann"], status },
      { id: "bob", harnessId: "claude-bob", name: "Bob", removable: true, private: true, usable: false, status },
    ],
  };
  const view = await mountAccounts();
  try {
    assert.deepEqual(headings(view.container), ["Your accounts", "Shared accounts", "Other people's accounts"]);
    const team = [...view.container.querySelectorAll<HTMLElement>(".pkg-harnesses-accounts-row")].find((row) => row.textContent?.includes("Team"))!;
    assert.equal(team.getAttribute("data-usable"), "false");
    assert.match(team.textContent ?? "", /Not available to you/);
    assert.match(team.textContent ?? "", /Who can use it: Ann/);
    assert.equal(buttons(team, "Sign in again").length, 0, "no sign-in on an account the caller can't use");

    await act(async () => { buttons(view.container, "Only me")[0]!.click(); });
    await typeInto(view.container.querySelector<HTMLInputElement>('input[aria-label="Account name"]')!, "Mine");
    await act(async () => { buttons(view.container, "Add account")[0]!.click(); });
    await flush();
    assert.deepEqual(requests.find((request) => request.method === "POST")?.body, { name: "Mine", private: true });

    await act(async () => { team.querySelector<HTMLButtonElement>('button[aria-label="Access for Team"]')!.click(); });
    await flush();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.match(dialog.textContent ?? "", /Who can use “Team”/);
    // Saved people stay checked; a disabled account is not offered.
    const ann = [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((box) => [box.closest("label")?.textContent?.trim(), box.checked]);
    assert.deepEqual(ann, [["Owner", false], ["Ann", true]]);
    await act(async () => { buttons(dialog, "Only selected")[1]!.click(); });
    assert.equal(buttons(dialog, "Save")[0]!.disabled, true, "an empty Space selection can't be saved");
    await act(async () => { buttons(dialog, "Everyone")[0]!.click(); });
    await act(async () => { buttons(dialog, "Every Space")[0]!.click(); });
    await act(async () => { buttons(dialog, "Save")[0]!.click(); });
    await flush();
    const put = requests.find((request) => request.method === "PUT");
    assert.equal(put?.path, "/api/claude/accounts/team/access");
    assert.deepEqual(put?.body, { allowedUserIds: null, allowedSpaceIds: null });
    assert.equal(document.body.querySelector('[role="dialog"]'), null, "closes after saving");
  } finally {
    await view.unmount();
    document.body.querySelector<HTMLElement>('[role="dialog"]')?.remove();
  }
});

const snapshot = (id: string, name: string, enabled = true): HarnessSnapshot => ({
  identity: { id, name, integration: "native", version: "1" },
  policy: { enabled, priority: 10, autoSelect: true },
  availability: { harnessId: id, state: "ready", installed: true, healthy: true, authenticated: true, checkedAt: 1 },
  context: { spaceId: "sp_home", projectId: "p1", cwd: "/p", revision: "r", fetchedAt: 1 },
} as HarnessSnapshot);

test("My default harness lists usable harnesses that are on, saves the choice and leads the summary", async () => {
  snapshots = [snapshot("claude", "Claude"), snapshot("claude-work", "Claude · Work"), snapshot("codex", "Codex", false)];
  personDefault = { harnessId: null, usable: false };
  requests.length = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(HarnessSettings, { host })); });
  await flush(10);
  try {
    const row = container.querySelector<HTMLElement>('[data-settings-item="harnesses.person-default"]');
    assert.ok(row, "the picker is shown to a signed-in person");
    assert.match(row!.textContent ?? "", /Project default/);
    await act(async () => { row!.querySelector<HTMLButtonElement>("button")!.click(); });
    await flush();
    const options = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.textContent ?? "");
    assert.ok(options.some((text) => text.includes("Claude · Work")), "own private account is offered");
    assert.ok(!options.some((text) => text.includes("Codex")), "a harness turned off here is not offered");
    const work = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes("Claude · Work"))!;
    await act(async () => { work.click(); });
    await flush();
    const put = requests.find((request) => request.method === "PUT" && request.path === "/api/harnesses/default");
    assert.deepEqual(put?.body, { harnessId: "claude-work" });
    assert.match(container.textContent ?? "", /Your new conversations use\s*Claude · Work/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
