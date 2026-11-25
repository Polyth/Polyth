import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import type { WebPackageHost } from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);
const { en: enMessages } = await import("../src/i18n/en.ts");
const enTranslate = (key: string, values: Record<string, string | number> = {}) =>
  ((enMessages as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_: string, name: string) => String(values[name] ?? `{${name}}`));

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
const now = Date.now();
const member = (harnessId: string, name: string, extra: Record<string, unknown> = {}) => ({ harnessId, name, included: false, state: "skipped", owner: "mine", ...extra });
let relays: unknown;
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
globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input), "http://localhost:3000");
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
  requests.push({ method, path: url.pathname, body });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  if (url.pathname === "/api/claude/accounts") return json({
    manageable: true, label: "Claude Code", canAddShared: true, canEditAccess: true,
    accounts: [
      { id: "default", harnessId: "claude", name: "", removable: false, usable: true, status: { loggedIn: true } },
      { id: "max", harnessId: "claude-max", name: "Max", removable: true, usable: true, signInCommand: "claude auth login", status: { loggedIn: false } },
    ],
  });
  if (url.pathname === "/api/harnesses/relays" && method === "GET") return relayStatus === 200 ? json({ relays }) : new Response("no", { status: relayStatus });
  if (url.pathname === "/api/harnesses/relays/claude-relay" && method === "PUT") {
    if (putStatus !== 200) return json({ error: "nope" }, putStatus);
    const sent = body as { members: string[]; order: string; handoverAt: number };
    const view = baseView();
    view.settings = sent as never;
    view.members = view.members.map((row) => ({ ...row, included: sent.members.includes(row.harnessId), position: sent.members.indexOf(row.harnessId) + 1 || undefined })) as never;
    return json(view);
  }
  if (url.pathname === "/api/harnesses/roster" || url.pathname === "/api/harnesses/snapshots") return json([]);
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: HarnessAccounts } = await import("../widgets/HarnessAccounts.tsx");
const { moveIncluded, setIncluded, orderedMembers, meterText, reasonText } = await import("../widgets/relayModel.ts");
const { relayHandover, relayDividerReason, SwitchMarker } = await import("../widgets/runtime.tsx");
const { replaceRelayPrefs, getRelayPrefs } = await import("../widgets/relayPrefs.ts");

const flush = async (rounds = 8) => { for (let index = 0; index < rounds; index++) await act(async () => { await Promise.resolve(); }); };
const host = {
  slots: { register: () => () => {}, list: () => [] },
  store: { select: () => "p1", getSnapshot: () => ({ activeProjectId: "p1" } as never), subscribe: () => () => {} },
  errors: { friendly: (_action: string, cause: unknown) => cause instanceof Error ? cause.message : String(cause) },
  navigation: { setOverlay: () => {}, openWorkspacePane: () => {}, openSettingsPage: () => {} },
  ui: { Slot: () => null, locale: { get: () => "en", translate: enTranslate } },
} as unknown as WebPackageHost;
const mount = async () => {
  requests.length = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(HarnessAccounts, { host, accounts: { family: "claude", endpoint: "/api/claude/accounts" } as never, projectId: "p1" })); });
  await flush();
  return { container, unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
};
const relayRows = (scope: ParentNode) => [...scope.querySelectorAll<HTMLElement>('[data-testid="relay-row"]')];

test("relay model orders included members first and moves them", () => {
  const rows = orderedMembers(baseView() as never);
  assert.deepEqual(rows.map((row) => row.harnessId), ["claude", "claude-iryna", "claude-max", "claude-team"]);
  assert.deepEqual(moveIncluded(rows, "claude-iryna", -1).map((row) => [row.harnessId, row.position]), [["claude-iryna", 1], ["claude", 2], ["claude-max", 3], ["claude-team", undefined]]);
  assert.equal(moveIncluded(rows, "claude", -1)[0]!.harnessId, "claude", "the first row cannot go up");
  assert.deepEqual(setIncluded(rows, "claude-team", true).map((row) => row.harnessId), ["claude", "claude-iryna", "claude-max", "claude-team"]);
  assert.equal(setIncluded(rows, "claude-iryna", false).find((row) => row.harnessId === "claude-iryna")?.included, false);
  const t = (key: string, values?: Record<string, string | number>) => enTranslate(`harnessruntime.relay.${key}`, values);
  assert.match(meterText(rows[0]!, t, now, "en"), /^5h · 62% left · resets /);
  assert.equal(meterText(rows[3]!, t, now, "en"), "No reading");
  assert.equal(reasonText(rows[2]!, t, now, "en"), "Signed out · skipped");
});

test("the Relay group renders members with state, meter and a sign-in action, saves a reorder and an order change", async () => {
  relays = [baseView()]; relayStatus = 200; putStatus = 200;
  const view = await mount();
  try {
    const heads = [...view.container.querySelectorAll("h4")].map((heading) => heading.textContent ?? "");
    assert.ok(heads.some((text) => text.startsWith("Relay")), "a Relay group");
    const rows = relayRows(view.container);
    assert.equal(rows.length, 4);
    assert.match(rows[0]!.textContent ?? "", /Now/);
    assert.match(rows[0]!.textContent ?? "", /5h · 62% left · resets/);
    assert.match(rows[1]!.textContent ?? "", /Next/);
    assert.match(rows[2]!.textContent ?? "", /Signed out · skipped/);
    assert.ok([...rows[2]!.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Sign in"), "sign-in for a signed-out member");
    assert.equal(rows[3]!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, false);
    assert.equal(rows[0]!.querySelector('[draggable="true"]'), null, "no drag while the order is automatic");

    const manual = [...view.container.querySelectorAll<HTMLButtonElement>(".pkg-harnesses-relay-control button")].find((button) => button.textContent === "My order")!;
    await act(async () => { manual.click(); });
    await flush();
    assert.deepEqual(requests.find((request) => request.method === "PUT")?.body, { members: ["claude", "claude-iryna", "claude-max"], order: "manual", handoverAt: 0.05 });

    requests.length = 0;
    const handle = relayRows(view.container)[1]!.querySelector<HTMLElement>(".pkg-harnesses-relay-handle")!;
    assert.equal(handle.getAttribute("draggable"), "true");
    await act(async () => { handle.dispatchEvent(new (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, shiftKey: true, bubbles: true })); });
    await flush();
    assert.deepEqual((requests.find((request) => request.method === "PUT")?.body as { members: string[] }).members, ["claude-iryna", "claude", "claude-max"]);

    requests.length = 0;
    await act(async () => { relayRows(view.container)[3]!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    await flush();
    assert.deepEqual((requests.find((request) => request.method === "PUT")?.body as { members: string[] }).members, ["claude-iryna", "claude", "claude-max", "claude-team"]);

    requests.length = 0;
    const ten = [...view.container.querySelectorAll<HTMLButtonElement>(".pkg-harnesses-relay-control button")].find((button) => button.textContent === "10%")!;
    await act(async () => { ten.click(); });
    await flush();
    assert.equal((requests.find((request) => request.method === "PUT")?.body as { handoverAt: number }).handoverAt, 0.1);
  } finally { await view.unmount(); }
});

test("a refused save rolls the group back and says so", async () => {
  relays = [baseView()]; relayStatus = 200; putStatus = 500;
  const view = await mount();
  try {
    await act(async () => { relayRows(view.container)[3]!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    await flush();
    assert.equal(relayRows(view.container)[3]!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, false, "rolled back");
    assert.ok(view.container.querySelector('[role="alert"]'), "a failure notice");
  } finally { await view.unmount(); putStatus = 200; }
});

test("empty and single-member Relays show their hint; a missing Relay shows no group", async () => {
  const empty = baseView(); empty.settings.members = []; empty.members = empty.members.map((row) => ({ ...row, included: false, position: undefined, state: "skipped" })) as never;
  relays = [empty];
  let view = await mount();
  try { assert.match(view.container.textContent ?? "", /Add accounts to Relay/); } finally { await view.unmount(); }
  const one = baseView(); one.members = one.members.map((row, index) => ({ ...row, included: index === 0 })) as never;
  relays = [one];
  view = await mount();
  try { assert.ok(view.container.querySelector('[data-testid="relay-needs-two"]')); } finally { await view.unmount(); }
  for (const status of [404, 403]) {
    relayStatus = status;
    view = await mount();
    try { assert.equal([...view.container.querySelectorAll("h4")].some((heading) => heading.textContent?.startsWith("Relay")), false); } finally { await view.unmount(); }
  }
  relayStatus = 200;
});

test("hand-over divider text covers the limit, rate-limited and unavailable causes", () => {
  assert.equal(relayHandover({ relayId: "x", cause: "bogus" }), undefined);
  assert.equal(relayHandover(undefined), undefined);
  const limit = relayHandover({ relayId: "claude-relay", cause: "limit", refillsAt: 5 })!;
  assert.equal(relayDividerReason(limit, "Iryna", "19:00", enTranslate), "Iryna's limit ran out, refills 19:00");
  assert.equal(relayDividerReason(limit, "Iryna", undefined, enTranslate), "Iryna's limit ran out");
  assert.equal(relayDividerReason({ ...limit, cause: "rate-limited" }, "Iryna", "19:00", enTranslate), "Iryna was rate-limited, refills 19:00");
  assert.equal(relayDividerReason({ ...limit, cause: "unavailable" }, "Iryna", undefined, enTranslate), "Iryna is unavailable");
});

const markerHtml = async (data: Record<string, unknown>) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(SwitchMarker, { host, event: { type: "harness/switched", time: now, data } as never })); });
  const html = container.innerHTML;
  await act(async () => { root.unmount(); });
  container.remove();
  return html;
};

test("a Relay hand-over divider renders only when the preference is on; ordinary switches are unchanged", async () => {
  const relaySwitch = { from: "claude-iryna", to: "claude-max", relay: { relayId: "claude-relay", cause: "limit", refillsAt: now + 3_600_000 } };
  const plainSwitch = { from: "claude", to: "codex" };
  replaceRelayPrefs(undefined);
  assert.equal(getRelayPrefs().showHandovers, false, "default off");
  assert.equal(await markerHtml(relaySwitch), "", "off: nothing at all");
  assert.match(await markerHtml(plainSwitch), /pkg-harnesses-switch-marker/, "ordinary switch still shows");
  replaceRelayPrefs({ showHandovers: true });
  const shown = await markerHtml(relaySwitch);
  assert.match(shown, /Relay moved this chat to/);
  assert.match(shown, /context sent again without cache/);
  assert.match(await markerHtml(plainSwitch), /pkg-harnesses-switch-marker/);
  replaceRelayPrefs({ showHandovers: false });
});

test("the Settings switch writes the preference", async () => {
  relays = [baseView()]; relayStatus = 200; putStatus = 200;
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
