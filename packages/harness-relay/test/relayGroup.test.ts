import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import type { WebPackageHost } from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);
/** Both catalogs the Accounts section reads: the package's Relay keys and the
 *  harness-runtime keys that stayed (account list, hand-over divider). */
const { en: relayMessages } = await import("../src/i18n/en.ts");
const { en: runtimeMessages } = await import("../../harness-runtime/src/i18n/en.ts");
const messages: Record<string, string> = { ...(runtimeMessages as Record<string, string>), ...(relayMessages as Record<string, string>) };
const enTranslate = (key: string, values: Record<string, string | number> = {}) =>
  (messages[key] ?? key).replace(/\{(\w+)\}/g, (_: string, name: string) => String(values[name] ?? `{${name}}`));

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
type FamilyView = { family: string; label: string; relayId: string; policy: "prohibited" | "unsupported" | "tolerated"; enabled: boolean; editable: boolean; offered: boolean };
const requests: Rec[] = [];
const now = Date.now();
const member = (harnessId: string, name: string, extra: Record<string, unknown> = {}) => ({ harnessId, name, included: false, state: "skipped", owner: "mine", ...extra });
let relays: unknown;
let families: FamilyView[];
let relayStatus = 200;
let putStatus = 200;
const baseView = () => ({
  id: "claude-relay", family: "claude", label: "Claude Code", limitsAvailable: true,
  settings: { members: ["claude", "claude-iryna"], order: "expire-first", handoverAt: 0.05 },
  members: [
    member("claude", "Claude Code", { included: true, position: 1, state: "now", tightest: { label: "5h", remaining: 0.62, resetsAt: now + 3_600_000 } }),
    member("claude-iryna", "Claude Code · Iryna", { included: true, position: 2, state: "next", tightest: { label: "5h", remaining: 0.9 } }),
    member("claude-max", "Claude Code · Max", { included: true, position: 3, state: "skipped", reason: "signed-out" }),
    member("claude-team", "Claude Code · Team"),
  ],
});
const familyView = (family: string, label: string, policy: FamilyView["policy"]): FamilyView =>
  ({ family, label, relayId: `${family}-relay`, policy, enabled: true, editable: true, offered: true });
type AccountMock = { id: string; harnessId: string; name: string; removable: boolean; usable: boolean; signInCommand?: string; status: { loggedIn: boolean } };
const fourAccounts = (): AccountMock[] => [
  { id: "default", harnessId: "claude", name: "", removable: false, usable: true, status: { loggedIn: true } },
  { id: "iryna", harnessId: "claude-iryna", name: "Iryna", removable: true, usable: true, status: { loggedIn: true } },
  { id: "max", harnessId: "claude-max", name: "Max", removable: true, usable: true, signInCommand: "claude auth login", status: { loggedIn: false } },
  { id: "team", harnessId: "claude-team", name: "Team", removable: true, usable: true, status: { loggedIn: true } },
];
let accounts = fourAccounts();
let manage = true;
// Picker visibility (`enabled`) per harness, as the roster reports it.
let pickerShown: Record<string, boolean> = {};
const rosterRows = () => ["claude", "claude-iryna", "claude-max", "claude-team", "claude-relay", "codex"]
  .map((id, index) => ({ identity: { id }, policy: { enabled: pickerShown[id] ?? true, priority: index + 1 } }));
globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input), "http://localhost:3000");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
  requests.push({ method, path: url.pathname, body });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  if (url.pathname === "/api/claude/accounts") return json({ manageable: true, label: "Claude Code", canAddShared: true, canEditAccess: true, accounts });
  if (url.pathname === "/api/harness-relay/relays" && method === "GET") return relayStatus === 200 ? json({ relays, families }) : new Response("no", { status: relayStatus });
  if (url.pathname === "/api/harness-relay/relays/claude-relay" && method === "PUT") {
    if (putStatus !== 200) return json({ error: "nope" }, putStatus);
    const sent = body as { members: string[]; order: string; handoverAt: number };
    const view = baseView();
    view.settings = sent as never;
    view.members = view.members.map((row) => ({ ...row, included: sent.members.includes(row.harnessId), position: sent.members.indexOf(row.harnessId) + 1 || undefined })) as never;
    return json(view);
  }
  if (url.pathname === "/api/harnesses/access") return json({ manage, personal: true });
  if (url.pathname === "/api/harnesses/preferences" && method === "PUT") {
    if (putStatus !== 200) return json({ error: "nope" }, putStatus);
    const sent = (body as { preferences: Record<string, { enabled: boolean }> }).preferences;
    pickerShown = Object.fromEntries(Object.entries(sent).map(([id, row]) => [id, row.enabled]));
    return json({ ok: true });
  }
  if (url.pathname === "/api/harnesses/roster") return json(rosterRows());
  if (url.pathname === "/api/harnesses/snapshots") return json([]);
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: HarnessAccounts } = await import("../../harness-runtime/widgets/HarnessAccounts.tsx");
const { registerRelayKit } = await import("@polyth/harness-runtime/relay-ui");
const { RelayBadge, RelayCard, RelayReading, useRelay } = await import("../widgets/RelayGroup.tsx");
// Harness-runtime draws the account list and joins a rotating package here.
registerRelayKit({ useRelay, RelayCard, RelayBadge, RelayReading });
const { meterText, moveIncluded, orderedMembers, reasonText, relayAvailable, relayListed, routeMembers, setIncluded } = await import("../widgets/relayModel.ts");
const { pickerPreferences } = await import("../../harness-runtime/widgets/accountsModel.ts");
const { replaceRelayPrefs, getRelayPrefs } = await import("../../harness-runtime/widgets/relayPrefs.ts");

const flush = async (rounds = 8) => { for (let index = 0; index < rounds; index++) await act(async () => { await Promise.resolve(); }); };
const host = {
  slots: { register: () => () => {}, list: () => [] },
  store: { select: () => "p1", getSnapshot: () => ({ activeProjectId: "p1" } as never), subscribe: () => () => {} },
  errors: { friendly: (_action: string, cause: unknown) => cause instanceof Error ? cause.message : String(cause) },
  navigation: { setOverlay: () => {}, openWorkspacePane: () => {}, openSettingsPage: () => {} },
  ui: { Slot: () => null, locale: { get: () => "en", translate: enTranslate } },
} as unknown as WebPackageHost;
const mount = async (family = "claude") => {
  requests.length = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(HarnessAccounts, { host, accounts: { family, endpoint: "/api/claude/accounts" } as never, projectId: "p1" })); });
  await flush();
  return { container, unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
};
const accountRows = (scope: ParentNode) => [...scope.querySelectorAll<HTMLElement>('[data-testid="account-row"]')];
const relaySwitch = (row: HTMLElement) => row.querySelector<HTMLButtonElement>('[data-testid="relay-switch"]');
const pickerSwitch = (row: HTMLElement) => row.querySelector<HTMLButtonElement>('[data-testid="picker-switch"]');
const relayCard = (scope: ParentNode) => scope.querySelector<HTMLElement>("section.pkg-harnesses-relay");
const reset = () => {
  relays = [baseView()];
  families = [familyView("claude", "Claude Code", "tolerated")];
  relayStatus = 200;
  putStatus = 200;
  accounts = fourAccounts();
  manage = true;
  pickerShown = {};
};

test("relay model orders included members first and moves them", () => {
  const rows = orderedMembers(baseView() as never);
  assert.deepEqual(rows.map((row) => row.harnessId), ["claude", "claude-iryna", "claude-max", "claude-team"]);
  assert.deepEqual(moveIncluded(rows, "claude-iryna", -1).map((row) => [row.harnessId, row.position]), [["claude-iryna", 1], ["claude", 2], ["claude-max", 3], ["claude-team", undefined]]);
  assert.equal(moveIncluded(rows, "claude", -1)[0]!.harnessId, "claude", "the first row cannot go up");
  assert.deepEqual(setIncluded(rows, "claude-team", true).map((row) => row.harnessId), ["claude", "claude-iryna", "claude-max", "claude-team"]);
  assert.equal(setIncluded(rows, "claude-iryna", false).find((row) => row.harnessId === "claude-iryna")?.included, false);
  const t = (key: string, values?: Record<string, string | number>) => enTranslate(`harnessrelay.${key}`, values);
  assert.match(meterText(rows[0]!, t, now, "en"), /^5h · 62% left · resets /);
  assert.equal(meterText(rows[3]!, t, now, "en"), "No reading");
  assert.equal(reasonText(rows[2]!, t, now, "en"), "Signed out · skipped");
});

test("relay model: availability and route order", () => {
  const view = baseView();
  assert.equal(relayAvailable(undefined), false);
  assert.equal(relayAvailable({ members: view.members.slice(0, 1) } as never), false, "one account: no Relay to offer");
  assert.equal(relayAvailable(view as never), true);
  const rows = orderedMembers(view as never);
  assert.equal(relayListed(rows), true);
  assert.equal(relayListed(setIncluded(setIncluded(rows, "claude-iryna", false), "claude-max", false)), false, "one member is not listed");
  assert.deepEqual(routeMembers([{ ...rows[2]!, state: "skipped" }, { ...rows[1]!, state: "next" }, { ...rows[0]!, state: "now" }, rows[3]!]).map((row) => row.harnessId), ["claude", "claude-iryna", "claude-max"]);
  assert.deepEqual(pickerPreferences(rosterRows(), "claude-max", false).preferences["claude-max"], { enabled: false, priority: 3 });
  assert.equal(Object.keys(pickerPreferences(rosterRows(), "claude-max", false).preferences).length, 6, "every row is sent back");
});

test("one account list: each row shows its Relay place, reading and switches; the card shows the route", async () => {
  reset();
  const view = await mount();
  try {
    const card = relayCard(view.container)!;
    assert.ok(card, "a Relay card");
    assert.equal(card.getAttribute("data-listed"), "true");
    assert.match(card.textContent ?? "", /On · 3 accounts/);
    assert.deepEqual([...card.querySelectorAll(".pkg-harnesses-relay-route > li")].map((stop) => [stop.querySelector(".pkg-harnesses-relay-stop-name")?.textContent, stop.getAttribute("data-state")]),
      [["Default", "now"], ["Iryna", "next"], ["Max", "skipped"]]);
    assert.equal(view.container.querySelectorAll("ul.pkg-harnesses-accounts-list").length, 1, "one list, not an accounts table and a Relay table");
    const rows = accountRows(view.container);
    assert.equal(rows.length, 4);
    assert.match(rows[0]!.textContent ?? "", /Now/);
    assert.match(rows[0]!.textContent ?? "", /5h · 62% left · resets/);
    assert.match(rows[1]!.textContent ?? "", /Next/);
    assert.doesNotMatch(rows[2]!.textContent ?? "", /Signed out · skipped/, "the account status already says it is signed out");
    assert.ok([...rows[2]!.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Sign in"), "sign-in for a signed-out member");
    assert.deepEqual(rows.map((row) => relaySwitch(row)?.getAttribute("aria-pressed")), ["true", "true", "true", "false"]);
    assert.deepEqual(rows.map((row) => pickerSwitch(row)?.getAttribute("aria-pressed")), ["true", "true", "true", "true"]);
    assert.equal(rows[3]!.getAttribute("data-relay"), "out");
    assert.equal(rows[0]!.querySelector('[draggable="true"]'), null, "no drag while the order is automatic");

    const manual = [...view.container.querySelectorAll<HTMLButtonElement>(".pkg-harnesses-relay-control button")].find((button) => button.textContent === "My order")!;
    await act(async () => { manual.click(); });
    await flush();
    assert.deepEqual(requests.find((request) => request.method === "PUT")?.body, { members: ["claude", "claude-iryna", "claude-max"], order: "manual", handoverAt: 0.05 });

    requests.length = 0;
    const handle = accountRows(view.container)[1]!.querySelector<HTMLElement>(".pkg-harnesses-relay-handle")!;
    assert.equal(handle.getAttribute("draggable"), "true");
    await act(async () => { handle.dispatchEvent(new (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, shiftKey: true, bubbles: true })); });
    await flush();
    assert.deepEqual((requests.find((request) => request.method === "PUT")?.body as { members: string[] }).members, ["claude-iryna", "claude", "claude-max"]);
    assert.deepEqual(accountRows(view.container).map((row) => row.querySelector("strong")?.textContent), ["Iryna", "Default", "Max", "Team"], "My order lists members in their order");

    requests.length = 0;
    const team = accountRows(view.container).find((row) => row.querySelector("strong")?.textContent === "Team")!;
    await act(async () => { relaySwitch(team)!.click(); });
    await flush();
    assert.deepEqual((requests.find((request) => request.method === "PUT")?.body as { members: string[] }).members, ["claude-iryna", "claude", "claude-max", "claude-team"]);
    assert.ok(requests.some((request) => request.path === "/api/harnesses/snapshots"), "the harness catalog is refreshed after a Relay save");

    requests.length = 0;
    const ten = [...view.container.querySelectorAll<HTMLButtonElement>(".pkg-harnesses-relay-control button")].find((button) => button.textContent === "10%")!;
    await act(async () => { ten.click(); });
    await flush();
    assert.equal((requests.find((request) => request.method === "PUT")?.body as { handoverAt: number }).handoverAt, 0.1);
  } finally { await view.unmount(); }
});

test("In picker off keeps a member Relay only; off for a non-member hides it", async () => {
  reset();
  const view = await mount();
  try {
    const max = () => accountRows(view.container).find((row) => row.querySelector("strong")?.textContent === "Max")!;
    await act(async () => { pickerSwitch(max())!.click(); });
    await flush();
    const put = requests.find((request) => request.method === "PUT" && request.path === "/api/harnesses/preferences")!;
    const sent = (put.body as { preferences: Record<string, { enabled: boolean; priority: number }> }).preferences;
    assert.deepEqual(sent["claude-max"], { enabled: false, priority: 3 });
    assert.equal(sent.codex?.enabled, true, "rows outside this family are sent back unchanged");
    assert.equal(pickerSwitch(max())!.getAttribute("aria-pressed"), "false");
    assert.equal(max().getAttribute("data-role"), "relay-only");
    assert.match(max().textContent ?? "", /Relay only/);

    const team = () => accountRows(view.container).find((row) => row.querySelector("strong")?.textContent === "Team")!;
    await act(async () => { pickerSwitch(team())!.click(); });
    await flush();
    assert.equal(team().getAttribute("data-role"), "off");
    assert.match(team().textContent ?? "", /Hidden/);
  } finally { await view.unmount(); }
});

test("without harness management the rows keep their Relay switch but no picker switch", async () => {
  reset(); manage = false;
  const view = await mount();
  try {
    const rows = accountRows(view.container);
    assert.equal(rows.filter((row) => relaySwitch(row)).length, 4);
    assert.equal(rows.filter((row) => pickerSwitch(row)).length, 0);
    assert.equal(requests.some((request) => request.method === "PUT"), false);
  } finally { await view.unmount(); }
});

test("a refused save rolls the switch back and says so", async () => {
  reset(); putStatus = 500;
  const view = await mount();
  try {
    const team = () => accountRows(view.container).find((row) => row.querySelector("strong")?.textContent === "Team")!;
    await act(async () => { relaySwitch(team())!.click(); });
    await flush();
    assert.equal(relaySwitch(team())!.getAttribute("aria-pressed"), "false", "rolled back");
    assert.ok(view.container.querySelector('[role="alert"]'), "a failure notice");
    await act(async () => { pickerSwitch(team())!.click(); });
    await flush();
    assert.equal(pickerSwitch(team())!.getAttribute("aria-pressed"), "true", "picker switch rolled back too");
  } finally { await view.unmount(); putStatus = 200; }
});

test("Relay stays out of sight below two accounts; with two it asks for members; a missing Relay shows nothing", async () => {
  reset();
  // One account the person may use: no card, no switches, a hint to add one.
  accounts = fourAccounts().slice(0, 1);
  const single = baseView(); single.settings.members = ["claude"]; single.members = single.members.slice(0, 1) as never;
  relays = [single];
  let view = await mount();
  try {
    assert.equal(relayCard(view.container), null);
    assert.equal(view.container.querySelector('[data-testid="relay-switch"]'), null);
    assert.match(view.container.textContent ?? "", /Add a second one to rotate between them with Relay/);
  } finally { await view.unmount(); }

  reset();
  const empty = baseView(); empty.settings.members = []; empty.members = empty.members.map((row) => ({ ...row, included: false, position: undefined, state: "skipped" })) as never;
  relays = [empty];
  view = await mount();
  try {
    assert.equal(relayCard(view.container)!.getAttribute("data-listed"), "false");
    assert.match(view.container.querySelector('[data-testid="relay-needs-two"]')?.textContent ?? "", /Add two accounts below to Relay/);
    assert.equal(view.container.querySelector(".pkg-harnesses-relay-route"), null);
  } finally { await view.unmount(); }

  const one = baseView(); one.members = one.members.map((row, index) => ({ ...row, included: index === 0 })) as never;
  relays = [one];
  view = await mount();
  try { assert.match(view.container.querySelector('[data-testid="relay-needs-two"]')?.textContent ?? "", /Add one more account to Relay/); } finally { await view.unmount(); }

  for (const status of [404, 403]) {
    relayStatus = status;
    view = await mount();
    try {
      assert.equal(relayCard(view.container), null);
      assert.equal(view.container.querySelector('[data-testid="relay-switch"]'), null);
    } finally { await view.unmount(); }
  }
  relayStatus = 200;
});

test("the Settings switch writes the preference", async () => {
  reset();
  replaceRelayPrefs({ showHandovers: false });
  const view = await mount();
  try {
    const toggle = view.container.querySelector<HTMLButtonElement>('button[role="switch"][aria-labelledby="pkg-harnesses-relay-show"]')!;
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    await act(async () => { toggle.click(); });
    assert.equal(getRelayPrefs().showHandovers, true);
    assert.equal(requests.some((request) => request.method === "PUT"), false, "a UI preference is never sent to the Relay route");
  } finally { replaceRelayPrefs({ showHandovers: false }); await view.unmount(); }
});

test("a family's Relay card states its vendor policy from the policy keys; no vendor has a bespoke warning", async () => {
  reset();
  const claude = await mount();
  try {
    const notice = claude.container.querySelector('[data-testid="relay-policy-notice"]');
    assert.equal(notice?.getAttribute("data-policy"), "tolerated");
    assert.match(notice?.textContent ?? "", /Several accounts are allowed/);
    assert.match(notice?.textContent ?? "", /Claude Code does not forbid several accounts/, "the body names the vendor");
    assert.equal(claude.container.querySelector('[data-testid="antigravity-relay-warning"]'), null, "no vendor-specific warning branch");
  } finally { await claude.unmount(); }

  relays = [{
    id: "antigravity-relay",
    family: "antigravity",
    label: "Antigravity",
    limitsAvailable: true,
    settings: { members: ["antigravity", "antigravity-work"], order: "expire-first", handoverAt: 0.05 },
    members: [
      member("antigravity", "Antigravity", { included: true, position: 1, state: "now" }),
      member("antigravity-work", "Antigravity · Work", { included: true, position: 2, state: "next" }),
    ],
  }];
  families = [familyView("antigravity", "Antigravity", "unsupported")];
  const view = await mount("antigravity");
  try {
    const notice = view.container.querySelector('[data-testid="relay-policy-notice"]');
    assert.equal(Boolean(notice), true, "the Relay card shows the policy notice");
    assert.equal(notice?.getAttribute("data-policy"), "unsupported");
    assert.match(notice?.textContent ?? "", /Account suspension risk/, "the heading comes from the policy key");
    assert.match(notice?.textContent ?? "", /Relay can get every Antigravity account on this server suspended/, "the body names the vendor");
    assert.equal(view.container.querySelector('[data-testid="antigravity-relay-warning"]'), null, "the old hardcoded warning is gone");
  } finally { await view.unmount(); }
});
