// The HTTP surface against a fake host: who sees and changes which account, how a
// source finds its harness, and what a request runs on.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogModel } from "../src/models.ts";
import registerPackage, { routeOfSource } from "../src/serverEntry.ts";
import type { LimitWindowsState, SourceView } from "../src/types.ts";
import type { LimitSource, LimitWindow } from "../src/windows.ts";

const HOUR = 60 * 60_000;

/** The fake answers by the name in the service key, like the real registry. */
const keyName = (key: unknown): string => String((key as { id: string }).id).replace("polyth.service.", "");

const windows = (): LimitWindow[] => [{ id: "5h", label: "5h", used: 0, limit: 100, unit: "percent", periodMs: 5 * HOUR }];

const source = (providerId: string, family?: string): LimitSource => ({
  providerId,
  windows: windows(),
  fetchedAt: Date.now(),
  stale: false,
  ...(family ? { account: { family, harnessId: providerId, label: providerId } } : {}),
});

const CATALOG: CatalogModel[] = [
  { harnessId: "claude", providerID: "anthropic", modelID: "opus", name: "Opus" },
  { harnessId: "claude", providerID: "anthropic", modelID: "haiku", name: "Haiku" },
  { harnessId: "claude-mine", providerID: "anthropic", modelID: "haiku", name: "Haiku" },
  { harnessId: "claude-other", providerID: "anthropic", modelID: "haiku", name: "Haiku" },
  { harnessId: "opencode", providerID: "opencode-go", modelID: "mimo-v2.6-flash", name: "MiMo Flash" },
  { harnessId: "opencode", providerID: "opencode-go", modelID: "mimo-v2.6-pro", name: "MiMo Pro" },
  { harnessId: "pi", providerID: "opencode-go", modelID: "mimo-v2.6-flash", name: "MiMo Flash" },
];

interface Harness {
  descriptor: { id: string; name: string; accountOwnerUserId?: string; accountLabel?: string };
  completeUtility?: (request: { cwd: string; prompt: string; model?: { modelID: string } }) => Promise<unknown>;
}

function setup(t: test.TestContext, options: { deployment?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "limit-windows-routes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const utility: Array<{ harnessId: string; cwd: string; modelID?: string; prompt: string }> = [];
  const smallModel: Array<{ cwd: string; modelID?: string; purpose?: string }> = [];
  const harness = (id: string, patch: Partial<Harness["descriptor"]> = {}, direct = true): Harness => ({
    descriptor: { id, name: id, ...patch },
    ...(direct ? { completeUtility: async (request) => { utility.push({ harnessId: id, cwd: request.cwd, prompt: request.prompt, ...(request.model ? { modelID: request.model.modelID } : {}) }); return { text: "OK" }; } } : {}),
  });
  const harnesses = new Map<string, Harness>([
    ["claude", harness("claude")],
    ["claude-mine", harness("claude-mine", { accountOwnerUserId: "alice", accountLabel: "Mine" })],
    ["claude-other", harness("claude-other", { accountOwnerUserId: "bob", accountLabel: "Other" })],
    ["opencode", harness("opencode", {}, false)],
  ]);
  const sources = [source("claude"), source("claude-mine", "claude"), source("claude-other", "claude"), source("opencode-go")];
  const services = new Map<string, unknown>([
    ["usage-limits", {
      snapshots: () => sources,
      refresh: async (id: string) => {
        const found = sources.find((row) => row.providerId === id)!;
        found.fetchedAt = Date.now();
        return found;
      },
    }],
    ["harnesses", { get: (id: string) => harnesses.get(id) }],
    ["runtime.catalog", { models: async () => CATALOG }],
  ]);
  const host = {
    pluginId: "limit-windows",
    storageDir: dir,
    deployment: options.deployment ?? "local-trusted",
    services: { get: (key: unknown) => services.get(keyName(key)) },
    systemSpaceContext: (spaceId: string) => ({ spaceId, userId: "system:polyth" }),
    forSpace: () => ({ projects: { list: async () => [{ id: "remote", path: "/remote", remote: { kind: "ssh" } }, { id: "local", path: "/work" }] } }),
    runtimes: { forProject: async (projectId: string, cwd: string, harnessId: string) => ({ projectId, cwd, harnessId }) },
    smallModelComplete: async (_runtime: unknown, request: { cwd: string; model?: { modelID: string }; purpose?: string }) => {
      smallModel.push({ cwd: request.cwd, ...(request.model ? { modelID: request.model.modelID } : {}), ...(request.purpose ? { purpose: request.purpose } : {}) });
      return { text: "OK" };
    },
  };
  return { host, utility, smallModel, sources, harnesses };
}

const person = (userId: string, marks: Record<string, unknown> = {}) => ({
  space: { spaceId: "space-a", userId, instanceOwner: false, ...marks },
  principal: { kind: "ui-session", userId },
});
const OWNER = person("owner", { instanceOwner: true });
const ALICE = person("alice");
const CAROL = person("carol", { allowedHarnesses: [] });

async function call(pkg: { routes?: (request: never) => Promise<boolean> }, who: ReturnType<typeof person>, method: string, path: string, input?: unknown) {
  let status = 0;
  let payload: unknown;
  const url = new URL(`http://localhost${path}`);
  const handled = await pkg.routes!({
    ...who,
    path: url.pathname,
    url,
    method,
    json: (code: number, value: unknown) => { status = code; payload = value; },
    body: async () => input ?? {},
  } as never);
  return { handled, status, payload };
}

const planBody = { mode: "reset", times: [], days: [], lead: 0, rolling: false, timeZone: "UTC" };

test("a private login is seen and changed only by its owner, not even by the instance owner", async (t) => {
  const { host } = setup(t);
  const pkg = registerPackage(host as never);
  const ids = async (who: ReturnType<typeof person>) => ((await call(pkg, who, "GET", "/api/limit-windows/state")).payload as LimitWindowsState).sources.map((row) => row.id);
  assert.deepEqual(await ids(OWNER), ["claude", "opencode-go"]);
  assert.deepEqual(await ids(ALICE), ["claude", "claude-mine"]);
  assert.equal((await call(pkg, OWNER, "PUT", "/api/limit-windows/plans/claude-mine", planBody)).status, 404);
  assert.equal((await call(pkg, ALICE, "PUT", "/api/limit-windows/plans/claude-other", planBody)).status, 404);
  assert.equal((await call(pkg, ALICE, "PUT", "/api/limit-windows/plans/claude-mine", planBody)).status, 200);
});

test("a shared account is changed by a manager; others at most read it", async (t) => {
  const { host } = setup(t);
  const pkg = registerPackage(host as never);
  const state = (await call(pkg, ALICE, "GET", "/api/limit-windows/state")).payload as LimitWindowsState;
  assert.equal(state.sources.find((row) => row.id === "claude")?.access, "view");
  assert.equal((await call(pkg, ALICE, "PUT", "/api/limit-windows/plans/claude", planBody)).status, 403);
  assert.equal((await call(pkg, ALICE, "POST", "/api/limit-windows/plans/claude/start", { meterId: "all" })).status, 403);
  assert.equal((await call(pkg, OWNER, "PUT", "/api/limit-windows/plans/claude", planBody)).status, 200);
  const manager = person("dana", { harnessManager: true });
  assert.equal((await call(pkg, manager, "PUT", "/api/limit-windows/plans/claude", planBody)).status, 200);
});

test("someone an account is not allowed for gets no sign of it", async (t) => {
  const { host } = setup(t);
  const pkg = registerPackage(host as never);
  const state = (await call(pkg, CAROL, "GET", "/api/limit-windows/state")).payload as LimitWindowsState;
  assert.deepEqual(state.sources, []);
  assert.equal((await call(pkg, CAROL, "PUT", "/api/limit-windows/plans/claude", planBody)).status, 404);
});

test("a saved plan comes back with its forecast; a bad one is refused", async (t) => {
  const { host } = setup(t);
  const pkg = registerPackage(host as never);
  const bad = await call(pkg, OWNER, "PUT", "/api/limit-windows/plans/claude", { ...planBody, mode: "sometimes" });
  assert.equal(bad.status, 400);
  const saved = await call(pkg, OWNER, "PUT", "/api/limit-windows/plans/claude", { ...planBody, mode: "hour", times: ["09:00"], lead: 1 });
  assert.equal(saved.status, 200);
  const view = saved.payload as SourceView;
  assert.equal(view.saved, true);
  assert.equal(view.plan.lead, 1);
  assert.equal(view.meters[0]!.model?.modelID, "haiku");
  assert.deepEqual(view.meters[0]!.options.map((row) => row.modelID), ["haiku", "opus"]);
  assert.ok(view.meters[0]!.planned.length > 0);
  assert.equal(view.meters[0]!.next?.reason === "lead" || view.meters[0]!.next?.reason === "hour", true);
});

test("an unsaved account shows off, in the caller's time zone", async (t) => {
  const { host } = setup(t);
  const pkg = registerPackage(host as never);
  const state = (await call(pkg, OWNER, "GET", "/api/limit-windows/state?timeZone=Europe/Kyiv")).payload as LimitWindowsState;
  const claude = state.sources.find((row) => row.id === "claude")!;
  assert.equal(claude.saved, false);
  assert.equal(claude.plan.mode, "off");
  assert.equal(claude.plan.timeZone, "Europe/Kyiv");
  assert.deepEqual(claude.meters[0]!.planned, []);
});

test("Start now runs the harness's own CLI in an empty directory, on that account", async (t) => {
  const { host, utility } = setup(t);
  const pkg = registerPackage(host as never);
  const done = await call(pkg, ALICE, "POST", "/api/limit-windows/plans/claude-mine/start", { meterId: "all" });
  assert.equal(done.status, 200);
  assert.equal(utility.length, 1);
  assert.equal(utility[0]!.harnessId, "claude-mine");
  assert.equal(utility[0]!.modelID, "haiku");
  assert.equal(utility[0]!.cwd, join(host.storageDir, "packages", "limit-windows", "start"));
});

test("a harness that serves a workspace answers in a local project, on the lowest-cost turn", async (t) => {
  const { host, smallModel } = setup(t);
  const pkg = registerPackage(host as never);
  const done = await call(pkg, OWNER, "POST", "/api/limit-windows/plans/opencode-go/start", { meterId: "all" });
  assert.equal(done.status, 200);
  assert.deepEqual(smallModel, [{ cwd: "/work", modelID: "mimo-v2.6-flash", purpose: "minimal" }]);
});

test("a hosted deployment does not touch host logins", async (t) => {
  const { host, utility } = setup(t, { deployment: "hosted-saas" });
  const pkg = registerPackage(host as never);
  const state = await call(pkg, OWNER, "GET", "/api/limit-windows/state");
  assert.deepEqual((state.payload as LimitWindowsState).available, false);
  assert.deepEqual((state.payload as LimitWindowsState).sources, []);
  assert.equal((await call(pkg, OWNER, "POST", "/api/limit-windows/plans/claude/start", { meterId: "all" })).status, 403);
  assert.equal(utility.length, 0);
});

test("other paths are not this package's", async (t) => {
  const { host } = setup(t);
  const pkg = registerPackage(host as never);
  assert.equal((await call(pkg, OWNER, "GET", "/api/usage/limits")).handled, false);
});

const REGISTERED = new Set(["claude", "codex", "antigravity", "antigravity-work", "opencode", "pi"]);
const registered = (id: string) => REGISTERED.has(id);

test("a source runs on its own harness", () => {
  assert.equal(routeOfSource(source("claude"), CATALOG, registered)?.harnessId, "claude");
  const route = routeOfSource(source("antigravity-work", "antigravity"), [{ harnessId: "antigravity-work", providerID: "antigravity", modelID: "gemini-3.8-flash", name: "Flash" }], registered);
  assert.equal(route?.harnessId, "antigravity-work");
  assert.equal(route?.models.length, 1);
});

test("a source without a harness of its own runs where its provider is listed, OpenCode first", () => {
  const route = routeOfSource(source("opencode-go"), CATALOG, registered);
  assert.equal(route?.harnessId, "opencode");
  assert.deepEqual(route?.models.map((row) => row.modelID), ["mimo-v2.6-flash", "mimo-v2.6-pro"]);
  const onlyPi = routeOfSource(source("opencode-go"), CATALOG.filter((row) => row.harnessId === "pi"), registered);
  assert.equal(onlyPi?.harnessId, "pi");
});

test("Claude and Codex reach OpenCode through their providers when their own harness is absent", () => {
  const only = (id: string) => id === "opencode";
  const models: CatalogModel[] = [
    { harnessId: "opencode", providerID: "anthropic", modelID: "claude-haiku", name: "Haiku" },
    { harnessId: "opencode", providerID: "openai", modelID: "gpt-mini", name: "Mini" },
  ];
  assert.deepEqual(routeOfSource(source("claude"), models, only)?.models.map((row) => row.modelID), ["claude-haiku"]);
  assert.deepEqual(routeOfSource(source("codex"), models, only)?.models.map((row) => row.modelID), ["gpt-mini"]);
});

test("an extra account never falls through to another login", () => {
  const models: CatalogModel[] = [{ harnessId: "opencode", providerID: "anthropic", modelID: "claude-haiku", name: "Haiku" }];
  assert.equal(routeOfSource(source("claude-gone", "claude"), models, registered), undefined);
});

test("nothing lists the provider: no route", () => {
  assert.equal(routeOfSource(source("zai"), CATALOG, registered), undefined);
});

