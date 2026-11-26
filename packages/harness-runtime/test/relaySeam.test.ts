// What stayed in harness-runtime when Relay moved to its own package: the
// account store's rotation settings, the registry's pinned-Relay resolution,
// the harness list hiding a Relay a person cannot rotate, the row-order
// helpers and the hand-over divider.
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { Window } from "happy-dom";
import type { AgentRuntime, HarnessContext, HarnessProvider, RouteRequest } from "@polyth/contracts";
import { createHarnessAccountStore } from "@polyth/harness-runtime/accounts";
import { bindPackageServices, createServerServiceRegistry, serverServiceKey, type ServerPackageHost } from "@polyth/plugins";
import { createHarnessRegistry } from "../src/index.ts";
import { harnessRoutes } from "../src/serverEntry.ts";

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

const tempDirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(prefix);
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const provider = (id: string, over: Partial<HarnessProvider> = {}): HarnessProvider => ({
  descriptor: { id, name: id, integration: "test", priority: 10 },
  probe: async () => ({ harnessId: id, installed: true, authenticated: true, healthy: true }),
  createRuntime: async () => ({ dispose: async () => {} } as AgentRuntime),
  ...over,
});
const ctx = (userId = "u1"): HarnessContext => ({ space: { spaceId: "s", userId } as never, spaceId: "s", projectId: "p", cwd: "/tmp", actorUserId: userId });
const request = (method: string, path: string, body: Record<string, unknown>, userId: string, extra: Record<string, unknown> = {}) => {
  let reply: { code: number; body: any } | undefined;
  const space = { spaceId: "s", userId, role: "owner", instanceOwner: true, harnessManager: false, harnessPersonal: false, allowedHarnesses: null, ...extra };
  const url = new URL(`http://polyth.test${path}`);
  return {
    req: {
      method, path: url.pathname, url, space, principal: { kind: "ui-session" },
      body: async () => body, json: (code: number, payload: unknown) => { reply = { code, body: payload }; },
    } as unknown as RouteRequest,
    get reply() { return reply!; },
  };
};

test("store: old array file loads, relays round-trip, removal drops members", async () => {
  const dir = tempDir(join(tmpdir(), "relay-store-"));
  writeFileSync(join(dir, "codex-accounts.json"), JSON.stringify([{ id: "work", name: "Work" }, { id: "relay", name: "Bad" }]));
  const store = createHarnessAccountStore({ storageDir: dir, family: "codex" });
  assert.deepEqual((await store.list()).map((a) => a.id), ["work"]);
  assert.deepEqual(await store.relay("u1"), { members: [], order: "expire-first", handoverAt: 0.05 });
  assert.equal(await store.relayInUse(), false);
  await store.setRelay("u1", { members: ["codex-work", "codex"], order: "manual", handoverAt: 0.1 });
  assert.deepEqual((await store.relay("u1")).members, ["codex-work", "codex"]);
  assert.equal(await store.relayInUse(), true);
  assert.equal((await store.list()).length, 1);
  await store.remove("work", async () => {});
  assert.deepEqual((await store.relay("u1")).members, ["codex"]);
  assert.equal(await store.relayInUse(), false);
  writeFileSync(join(dir, "codex-accounts.json"), JSON.stringify({ accounts: [], relays: { u1: { members: 7, order: "x", handoverAt: 9 }, "bad key!": {} }, extra: 1 }));
  assert.deepEqual(await store.relay("u1"), { members: [], order: "expire-first", handoverAt: 0.05 });
  assert.ok(readFileSync(join(dir, "codex-accounts.json"), "utf8").length > 0);
  const created = await store.add("Fresh", async () => {});
  assert.equal(created.id, "fresh");
});

test("registry redirects a pinned Relay to a member, honours sticky, refusals and exhaustion", async () => {
  const registry = createHarnessRegistry();
  registry.register(provider("codex"));
  registry.register(provider("codex-work"));
  const state = { members: ["codex-work", "codex"] as string[], refused: new Map<string, number>() };
  let listed = true;
  const relay = provider("codex-relay", {
    descriptor: { id: "codex-relay", name: "Codex · Relay", integration: "relay", priority: 1000, autoSelect: false, relay: { family: "codex" } },
    relay: {
      plan: async (_context, sticky) => {
        const now = Date.now();
        const open = state.members.filter((id) => (state.refused.get(id) ?? 0) <= now);
        if (open.length === 0) {
          const times = state.members.flatMap((id) => state.refused.get(id) ?? []);
          return { candidates: [], ...(times.length ? { exhaustedUntil: Math.min(...times) } : {}) };
        }
        return { candidates: sticky && open.includes(sticky) ? [sticky, ...open.filter((id) => id !== sticky)] : open };
      },
      // The provider's own refusal receipt; the default skip is a quarter hour.
      refused: (harnessId, until) => { state.refused.set(harnessId, until ?? Date.now() + 15 * 60_000); },
      listed: async () => listed,
    },
    probe: async () => ({ harnessId: "codex-relay", installed: true, authenticated: "unknown", healthy: true, state: "setup-required" }),
    createRuntime: async () => { throw Object.assign(new Error("no runtime"), { code: "runtime-unavailable" }); },
  });
  registry.register(relay);
  const pinned = { mode: "pinned" as const, harnessId: "codex-relay" };
  assert.equal((await registry.resolve(ctx(), pinned)).descriptor.id, "codex-work");
  assert.equal((await registry.resolve(ctx(), pinned, "codex")).descriptor.id, "codex");
  relay.relay!.refused("codex-work");
  assert.equal((await registry.resolve(ctx(), pinned)).descriptor.id, "codex");
  relay.relay!.refused("codex", Date.parse("2030-01-01T19:00:00Z"));
  relay.relay!.refused("codex-work", Date.parse("2030-01-01T19:00:00Z"));
  await assert.rejects(registry.resolve(ctx(), pinned), (error: Error) => /Codex · Relay/.test(error.message) && /2030-01-01T19:00:00/.test(error.message));
  // Another person has no members.
  state.members = [];
  await assert.rejects(registry.resolve(ctx("u2"), pinned), /Codex · Relay/);
  // The registry asks the Relay whether this actor can rotate at all.
  assert.equal(listed, true);
});

test("the harness list and picker leave out a Relay below two members the caller may use", async () => {
  const dir = tempDir(join(tmpdir(), "relay-list-"));
  const registry = createHarnessRegistry();
  registry.register(provider("codex"));
  const listedFor: Record<string, boolean> = { u1: false };
  const relay = provider("codex-relay", {
    descriptor: { id: "codex-relay", name: "Codex · Relay", integration: "relay", priority: 1000, autoSelect: false, relay: { family: "codex" } },
    relay: {
      plan: async () => ({ candidates: ["codex"] }),
      refused: () => {},
      listed: async (actor) => listedFor[actor.userId] ?? false,
    },
    probe: async () => ({ harnessId: "codex-relay", installed: true, authenticated: true, healthy: true }),
  });
  registry.register(relay);
  const services = createServerServiceRegistry();
  services.provide(serverServiceKey("harnesses"), registry);
  const host = {
    pluginId: "harness-runtime",
    services: bindPackageServices(services, "harness-runtime"),
    spaceStorage: () => ({ root: dir, packageDir: (id: string) => join(dir, "packages", id), path: (relative: string) => join(dir, relative) }),
    forSpace: () => ({ projects: { list: async () => [], get: async () => undefined }, sessions: {} }),
  } as unknown as ServerPackageHost;
  const routes = harnessRoutes(host);
  const call = async (method: string, path: string, userId: string, body: Record<string, unknown> = {}) => {
    const r = request(method, path, body, userId, { deployment: "local-trusted", storageDir: dir });
    assert.equal(await routes(r.req), true);
    return r.reply;
  };
  const ids = async (path: string, userId: string) => {
    const rows = (await call("GET", path, userId)).body as Array<{ id?: string; identity?: { id: string } }>;
    return rows.map((row) => row.identity?.id ?? row.id);
  };
  for (const path of ["/api/harnesses/roster", "/api/harnesses/snapshots", "/api/harnesses"])
    assert.equal((await ids(path, "u1")).includes("codex-relay"), false, `${path}: below two members, no Relay`);

  listedFor.u1 = true;
  for (const path of ["/api/harnesses/roster", "/api/harnesses/snapshots", "/api/harnesses"]) {
    assert.equal((await ids(path, "u1")).includes("codex-relay"), true, `${path}: two members list it for u1`);
    assert.equal((await ids(path, "u2")).includes("codex-relay"), false, `${path}: u2 cannot rotate it`);
  }
  // A chat already pinned to it still reads its exact row.
  assert.deepEqual(await ids("/api/harnesses/snapshots?harnessId=codex-relay", "u2"), ["codex-relay"]);

  // A reorder by someone the Relay is hidden from keeps its name and colour.
  mkdirSync(join(dir, "harnesses"), { recursive: true });
  const prefsPath = join(dir, "harnesses/preferences.json");
  writeFileSync(prefsPath, JSON.stringify({ "codex-relay": { enabled: true, priority: 5, title: "Night shift" } }));
  const saved = await call("PUT", "/api/harnesses/preferences", "u2", { preferences: { codex: { enabled: true, priority: 1 } } });
  assert.equal(saved.code, 200);
  assert.deepEqual(JSON.parse(readFileSync(prefsPath, "utf8"))["codex-relay"], { enabled: true, priority: 5, title: "Night shift" });
});

test("the row order, the account role and the refill time stay with the account list", async () => {
  const { relayRowOrder, accountRole, refillTime } = await import("../widgets/relayModel.ts");
  const rows = [
    { harnessId: "claude", included: true, position: 1, state: "now" },
    { harnessId: "claude-iryna", included: true, position: 2, state: "next" },
    { harnessId: "claude-max", included: true, position: 3, state: "skipped" },
    { harnessId: "claude-team", included: false, state: "skipped" },
  ] as never;
  const list = [{ harnessId: "claude-team" }, { harnessId: "claude-max" }, { harnessId: "claude" }, { harnessId: "claude-iryna" }];
  assert.deepEqual(relayRowOrder(list, rows, false).map((row) => row.harnessId), ["claude-team", "claude-max", "claude", "claude-iryna"], "automatic order: nothing jumps");
  assert.deepEqual(relayRowOrder(list, rows, true).map((row) => row.harnessId), ["claude", "claude-iryna", "claude-max", "claude-team"], "My order: members first, in their order");
  assert.equal(accountRole(true, true), undefined);
  assert.equal(accountRole(true, false), "relay-only");
  assert.equal(accountRole(false, false), "off");
  const now = Date.now();
  assert.match(refillTime(now, now, "en"), /^\d{1,2}:\d{2}/, "today is just the clock");
  assert.match(refillTime(now + 7 * 24 * 3_600_000, now, "en"), /^\w{3} \d{1,2}:\d{2}/, "another day names the day");
});

test("hand-over divider text covers the limit, rate-limited and unavailable causes", async () => {
  const { relayHandover, relayDividerReason } = await import("../widgets/runtime.tsx");
  assert.equal(relayHandover({ relayId: "x", cause: "bogus" }), undefined);
  assert.equal(relayHandover(undefined), undefined);
  const limit = relayHandover({ relayId: "claude-relay", cause: "limit", refillsAt: 5 })!;
  assert.equal(relayDividerReason(limit, "Iryna", "19:00", enTranslate), "Iryna's limit ran out, refills 19:00");
  assert.equal(relayDividerReason(limit, "Iryna", undefined, enTranslate), "Iryna's limit ran out");
  assert.equal(relayDividerReason({ ...limit, cause: "rate-limited" }, "Iryna", "19:00", enTranslate), "Iryna was rate-limited, refills 19:00");
  assert.equal(relayDividerReason({ ...limit, cause: "unavailable" }, "Iryna", undefined, enTranslate), "Iryna is unavailable");
});

const host = {
  slots: { register: () => () => {}, list: () => [] },
  store: { select: () => "p1", getSnapshot: () => ({ activeProjectId: "p1" } as never), subscribe: () => () => {} },
  errors: { friendly: (_action: string, cause: unknown) => cause instanceof Error ? cause.message : String(cause) },
  navigation: { setOverlay: () => {}, openWorkspacePane: () => {}, openSettingsPage: () => {} },
  ui: { Slot: () => null, locale: { get: () => "en", translate: enTranslate } },
} as never;
const markerHtml = async (data: Record<string, unknown>) => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SwitchMarker } = await import("../widgets/runtime.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(SwitchMarker, { host, event: { type: "harness/switched", time: Date.now(), data } as never })); });
  const html = container.innerHTML;
  await act(async () => { root.unmount(); });
  container.remove();
  return html;
};

test("a Relay hand-over divider renders only when the preference is on; ordinary switches are unchanged", async () => {
  const { replaceRelayPrefs, getRelayPrefs } = await import("../widgets/relayPrefs.ts");
  const relaySwitch = { from: "claude-iryna", to: "claude-max", relay: { relayId: "claude-relay", cause: "limit", refillsAt: Date.now() + 3_600_000 } };
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
