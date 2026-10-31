import assert from "node:assert/strict";
import { register } from "node:module";
import test, { mock } from "node:test";
import { Window } from "happy-dom";
import type { HarnessSnapshot, HarnessUpdateStatus } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);
const { en: enMessages } = await import("../src/i18n/en.ts");
/** The shell's lookup over the package's English catalog. */
const enTranslate = (key: string, values: Record<string, string | number> = {}) =>
  ((enMessages as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_: string, name: string) => String(values[name] ?? `{${name}}`));

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
  cancelAnimationFrame: () => {},
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Fixture = {
  rows: HarnessSnapshot[];
  /** What a native check (verify=1) answers per harness. */
  verified: Record<string, Partial<HarnessSnapshot["availability"]>>;
  updates: HarnessUpdateStatus[];
  /** What the release check reports once an update ran. */
  afterUpdate?: HarnessUpdateStatus[];
  /** Verify reads wait for this before answering. */
  gate?: Promise<void>;
};
let fixture: Fixture = { rows: [], verified: {}, updates: [] };
const requests: string[] = [];

globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input), "http://localhost:3000");
  const method = init?.method ?? "GET";
  requests.push(`${method} ${url.pathname}${url.search}`);
  const json = (value: unknown) => new Response(JSON.stringify(value));
  if (url.pathname === "/api/harnesses/roster") return json(fixture.rows.map((row) => ({ identity: row.identity, policy: row.policy })));
  if (url.pathname === "/api/harnesses/access") return json({ manage: true });
  if (url.pathname === "/api/harnesses/updates") return json(fixture.updates);
  if (url.pathname === "/api/harnesses/snapshots") {
    const id = url.searchParams.get("harnessId");
    const rows = id ? fixture.rows.filter((row) => row.identity.id === id) : fixture.rows;
    if (url.searchParams.get("verify") === "1") {
      await fixture.gate;
      return json(rows.map((row) => ({ ...row, availability: { ...row.availability, ...fixture.verified[row.identity.id], checkedAt: Date.now() } })));
    }
    return json(rows);
  }
  const update = url.pathname.match(/^\/api\/harnesses\/([^/]+)\/update$/);
  if (update && method === "POST") {
    if (fixture.afterUpdate) fixture.updates = fixture.afterUpdate;
    return json({ ok: true, exitCode: 0, output: "updated" });
  }
  return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
}) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { HarnessSettings } = await import("../widgets/runtime.tsx");
const { UPDATE_OUTCOME_MS } = await import("../widgets/HarnessSettingsPage.tsx");

const flush = async (rounds = 8) => {
  for (let index = 0; index < rounds; index++) await act(async () => { await Promise.resolve(); });
};

const host = (projectId: string): WebPackageHost => ({
  slots: { register: () => () => {}, list: () => [] },
  store: {
    select: () => projectId,
    getSnapshot: () => ({ activeProjectId: projectId } as never),
    subscribe: () => () => {},
  },
  errors: { friendly: (_action: string, cause: unknown) => cause instanceof Error ? cause.message : String(cause) },
  ui: { Slot: () => null, locale: { get: () => "en", translate: enTranslate } },
} as unknown as WebPackageHost);

const row = (id: string, name: string, availability: Partial<HarnessSnapshot["availability"]> = {}, extra: Partial<HarnessSnapshot> = {}): HarnessSnapshot => ({
  identity: { id, name, integration: "test", version: `${id}-cli 1.0.0` },
  policy: { enabled: true, priority: 10, autoSelect: true },
  availability: { harnessId: id, state: "ready", installed: true, healthy: true, authenticated: true, checkedAt: 1, ...availability },
  context: { spaceId: "space-a", projectId: "p", cwd: "/project", revision: "r1", fetchedAt: 1 },
  ...extra,
});
const unknown = { state: "unknown" as const, authenticated: "unknown" as const };

async function mount(projectId: string, next: Fixture) {
  fixture = next;
  requests.length = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(HarnessSettings, { host: host(projectId) })); });
  await flush();
  return { container, unmount: async () => { await act(async () => { root.unmount(); }); container.remove(); } };
}

const summary = (container: HTMLElement) => container.querySelector(".pkg-harnesses-summary")?.textContent?.replace(/\s+/g, " ").trim() ?? "";

test("Settings asks each harness it cannot see into, and only real problems need attention", async () => {
  let open!: () => void;
  const view = await mount("checks-verify", {
    rows: [
      row("claude", "Claude Code"),
      row("codex", "Codex", unknown),
      row("cursor", "Cursor", unknown),
      row("pi", "Pi", { state: "not-installed", installed: false, healthy: false, authenticated: "unknown" }),
      row("antigravity", "Antigravity", unknown, { policy: { enabled: false, priority: 50, autoSelect: false } }),
    ],
    verified: { codex: { state: "ready", authenticated: true }, cursor: { state: "auth-required", authenticated: false } },
    updates: [],
    gate: new Promise<void>((resolve) => { open = resolve; }),
  });
  try {
    assert.match(summary(view.container), /1 ready/);
    assert.match(summary(view.container), /Checking 2/);
    assert.doesNotMatch(summary(view.container), /attention|sign-in/, "an unanswered check is never a warning");
    const checked = requests.filter((request) => request.includes("verify=1"));
    assert.deepEqual(checked.map((request) => new URL(request.split(" ")[1]!, "http://x").searchParams.get("harnessId")).sort(), ["codex", "cursor"],
      "only enabled, installed harnesses whose probe cannot see sign-in are checked");
    open();
    await flush();
    assert.match(summary(view.container), /2 ready/);
    assert.match(summary(view.container), /1 needs sign-in/);
    assert.match(summary(view.container), /1 not installed/);
    assert.match(summary(view.container), /1 off/);
    assert.doesNotMatch(summary(view.container), /Checking/);
    const status = (name: string) => [...view.container.querySelectorAll(".pkg-harnesses-row")]
      .find((element) => element.querySelector("strong")?.textContent === name)?.querySelector(".pkg-harnesses-status")?.textContent;
    assert.equal(status("Codex"), "Ready");
    assert.equal(status("Cursor"), "Sign in required");
    assert.equal(status("Antigravity"), "Not verified", "a harness that is off is not started just to check it");
  } finally {
    await view.unmount();
  }
});

test("Check again probes afresh and then repeats the native checks", async () => {
  const view = await mount("checks-again", {
    rows: [row("codex", "Codex", unknown)],
    verified: { codex: { state: "ready", authenticated: true } },
    updates: [],
  });
  try {
    assert.equal(requests.filter((request) => request.includes("verify=1")).length, 1);
    requests.length = 0;
    const again = [...view.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Check again");
    await act(async () => { again!.click(); });
    await flush();
    const forced = requests.findIndex((request) => request.includes("/api/harnesses/snapshots") && request.includes("force=1"));
    const verified = requests.findIndex((request) => request.includes("verify=1"));
    assert.ok(forced >= 0, "the probe is forced");
    assert.ok(verified > forced, "the native check runs after the forced probe, so the probe cannot erase its answer");
    assert.ok(requests.some((request) => request.startsWith("GET /api/harnesses/updates") && request.includes("force=1")), "releases are looked up again");
  } finally {
    await view.unmount();
  }
});

test("a kept row shows its state, not a false offline warning", async () => {
  const view = await mount("checks-stale", {
    rows: [row("claude", "Claude Code", {}, { stale: true })],
    verified: {},
    updates: [],
  });
  try {
    assert.equal(view.container.querySelector(".pkg-harnesses-status")?.textContent, "Ready");
    assert.match(summary(view.container), /1 ready/);
  } finally {
    await view.unmount();
  }
});

test("a newer release shows on its row and the owner updates from there", async () => {
  const view = await mount("checks-update", {
    rows: [row("codex", "Codex")],
    verified: {},
    updates: [{ harnessId: "codex", installed: "codex-cli 0.160.0", current: "0.160.0", latest: "0.162.1", available: true, checkedAt: Date.now(), canUpdate: true }],
    afterUpdate: [{ harnessId: "codex", installed: "codex-cli 0.162.1", current: "0.162.1", latest: "0.162.1", available: false, checkedAt: Date.now(), canUpdate: true }],
  });
  try {
    assert.match(summary(view.container), /1 update/);
    assert.match(view.container.querySelector(".pkg-harnesses-version")?.textContent ?? "", /0\.160\.0.*0\.162\.1/);
    const update = view.container.querySelector<HTMLButtonElement>('button[aria-label="Update Codex to 0.162.1"]');
    assert.ok(update, "the owner gets an Update action on the row");
    await act(async () => { update!.click(); });
    await flush();
    assert.ok(requests.includes("POST /api/harnesses/codex/update"));
    assert.match(view.container.textContent ?? "", /Codex updated to 0\.162\.1/, "the outcome names the version the server sees now");
    assert.doesNotMatch(summary(view.container), /update/, "nothing newer is left");
  } finally {
    await view.unmount();
  }
});

test("a successful update's notice leaves on its own unless someone is reading it", async () => {
  const view = await mount("checks-update-transient", {
    rows: [row("pi", "Pi")],
    verified: {},
    updates: [{ harnessId: "pi", installed: "0.85.1", current: "0.85.1", latest: "1.2.0", available: true, checkedAt: Date.now(), canUpdate: true }],
    afterUpdate: [{ harnessId: "pi", installed: "1.2.0", current: "1.2.0", latest: "1.2.0", available: false, checkedAt: Date.now(), canUpdate: true }],
  });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const update = view.container.querySelector<HTMLButtonElement>('button[aria-label="Update Pi to 1.2.0"]');
    await act(async () => { update!.click(); });
    await flush();
    const notice = () => [...view.container.querySelectorAll(".ui-notice")].find((node) => /Pi updated to 1\.2\.0/.test(node.textContent ?? ""));
    assert.ok(notice(), "the outcome shows first");
    await act(async () => { notice()!.dispatchEvent(new dom.MouseEvent("mouseover", { bubbles: true }) as unknown as Event); });
    await act(async () => { mock.timers.tick(UPDATE_OUTCOME_MS * 2); });
    assert.ok(notice(), "it stays while the pointer is on it");
    await act(async () => { notice()!.dispatchEvent(new dom.MouseEvent("mouseout", { bubbles: true, relatedTarget: view.container.ownerDocument.body as never }) as unknown as Event); });
    await act(async () => { mock.timers.tick(UPDATE_OUTCOME_MS); });
    await flush();
    assert.equal(notice(), undefined, "then it dismisses itself");
  } finally {
    mock.timers.reset();
    await view.unmount();
  }
});

test("an updater that installs nothing newer says so instead of claiming the target", async () => {
  const view = await mount("checks-update-channel", {
    rows: [row("claude", "Claude Code")],
    verified: {},
    updates: [{ harnessId: "claude", installed: "2.1.292 (Claude Code)", current: "2.1.292", latest: "2.1.300", available: true, checkedAt: Date.now(), canUpdate: true }],
  });
  try {
    const update = view.container.querySelector<HTMLButtonElement>('button[aria-label="Update Claude Code to 2.1.300"]');
    await act(async () => { update!.click(); });
    await flush();
    assert.match(view.container.textContent ?? "", /Claude Code’s updater finished/);
    assert.match(view.container.textContent ?? "", /still sees version 2\.1\.292/);
    assert.doesNotMatch(view.container.textContent ?? "", /updated to 2\.1\.300/);
  } finally {
    await view.unmount();
  }
});

test("someone who may not update sees the newer release without an Update action", async () => {
  const view = await mount("checks-update-member", {
    rows: [row("pi", "Pi")],
    verified: {},
    updates: [{ harnessId: "pi", installed: "0.85.1", current: "0.85.1", latest: "1.2.0", available: true, checkedAt: Date.now(), canUpdate: false }],
  });
  try {
    assert.match(view.container.querySelector(".pkg-harnesses-version")?.textContent ?? "", /1\.2\.0/);
    assert.equal(view.container.querySelector('button[aria-label^="Update Pi"]'), null);
  } finally {
    await view.unmount();
  }
});
