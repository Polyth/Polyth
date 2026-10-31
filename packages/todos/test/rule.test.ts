import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type { RouteRequest, SpaceContext } from "@polyth/contracts";
import {
  SERVER_BEHAVIOR_SECTIONS,
  createServerServiceRegistry,
  type ServerBehaviorSectionRegistry,
  type ServerPackageHost,
} from "@polyth/plugins";
import {
  DEFAULT_TODO_RULE,
  TODO_RULE_MAX_CHARS,
  parseTodoRuleSettings,
  todoRuleSection,
} from "../src/rule.ts";
import registerPackage, { TODO_RULE_SETTINGS_PATH } from "../src/serverEntry.ts";
import { createTodoRuleSettingsStore } from "../src/settingsStore.ts";

const scratchDir = (t: TestContext): string => {
  const base = resolve(import.meta.dirname, "../../../.scratch/todos-tests");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("rule settings parse strictly and default to an off, non-empty rule", () => {
  assert.deepEqual(parseTodoRuleSettings(undefined), { enabled: false, text: DEFAULT_TODO_RULE });
  assert.deepEqual(parseTodoRuleSettings({ enabled: true, text: "  Use todos.\r\nAlways.  " }), {
    enabled: true,
    text: "Use todos.\nAlways.",
  });
  assert.equal(parseTodoRuleSettings({ enabled: true, text: "   " }).text, DEFAULT_TODO_RULE);
  assert.throws(() => parseTodoRuleSettings({ enabled: "yes" }), { code: "invalid-input" });
  assert.throws(() => parseTodoRuleSettings({ text: 5 }), { code: "invalid-input" });
  assert.throws(() => parseTodoRuleSettings([]), { code: "invalid-input" });
  assert.throws(() => parseTodoRuleSettings({ text: "x".repeat(TODO_RULE_MAX_CHARS + 1) }), { code: "invalid-input" });
});

test("the section is empty when off and headed when on", () => {
  assert.equal(todoRuleSection({ enabled: false, text: "x" }), "");
  assert.equal(todoRuleSection({ enabled: true, text: "Keep a list." }), "## Todo discipline (mandatory)\n\nKeep a list.");
  assert.match(todoRuleSection({ enabled: true, text: "" }), /TodoWrite/);
});

test("the global store is revisioned, conflict-checked and survives reload", (t) => {
  const dir = scratchDir(t);
  const store = createTodoRuleSettingsStore(dir);
  assert.equal(store.read().revision, 0);
  const saved = store.save({ enabled: true, text: "Rule" }, 0);
  assert.deepEqual(saved, { revision: 1, settings: { enabled: true, text: "Rule" } });
  assert.deepEqual(store.save({ enabled: true, text: "Rule" }, 1), saved, "unchanged save is a no-op");
  assert.throws(() => store.save({ enabled: false }, 0), { code: "conflict" });
  assert.throws(() => store.save({ enabled: false }, -1), { code: "invalid-input" });
  const file = join(dir, "packages/todos/rule.json");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).revision, 1);
  assert.deepEqual(createTodoRuleSettingsStore(dir).read(), saved);
  writeFileSync(file, JSON.stringify({ version: 99, revision: 1, settings: {} }));
  assert.throws(() => createTodoRuleSettingsStore(dir).read(), { code: "storage-unavailable" });
});

function harness(t: TestContext, options: { withSections?: boolean } = {}) {
  const dir = scratchDir(t);
  const services = createServerServiceRegistry();
  const sections = new Map<string, () => string>();
  let changes = 0;
  if (options.withSections !== false) {
    services.provide(SERVER_BEHAVIOR_SECTIONS, {
      register(id, section) {
        if (sections.has(id)) throw Object.assign(new Error("dup"), { code: "conflict" });
        sections.set(id, section);
        return { dispose: () => { sections.delete(id); } };
      },
      async changed() { changes += 1; },
    } satisfies ServerBehaviorSectionRegistry);
  }
  const host = { storageDir: dir, services } as unknown as ServerPackageHost;
  const pkg = registerPackage(host);
  const call = async (method: string, payload?: unknown, owner = true) => {
    let status = 0;
    let body: unknown;
    const handled = await pkg.routes!({
      path: TODO_RULE_SETTINGS_PATH,
      method,
      body: async () => payload,
      json: (code: number, value: unknown) => { status = code; body = value; },
      space: { spaceId: "s", ...(owner ? { instanceOwner: true } : { instanceOwner: false }) } as unknown as SpaceContext,
      principal: { kind: "ui-session" },
    } as unknown as RouteRequest);
    return { handled, status, body: body as Record<string, unknown> };
  };
  return { pkg, sections, call, changes: () => changes, dir };
}

test("enable registers the section; saving re-projects behavior; disable removes it", async (t) => {
  const h = harness(t);
  await h.pkg.onEnable!();
  assert.equal(h.sections.get("todos")?.(), "", "off by default contributes nothing");
  assert.equal(h.changes(), 0, "enabling with the rule off does not re-project");

  const saved = await h.call("PUT", { settings: { enabled: true, text: "Always keep todos." }, expectedRevision: 0 });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { revision: 1, settings: { enabled: true, text: "Always keep todos." }, active: true });
  assert.equal(h.changes(), 1);
  assert.equal(h.sections.get("todos")?.(), "## Todo discipline (mandatory)\n\nAlways keep todos.");

  const same = await h.call("PUT", { settings: { enabled: true, text: "Always keep todos." }, expectedRevision: 1 });
  assert.equal(same.status, 200);
  assert.equal(h.changes(), 1, "a no-op save does not re-project");

  const stale = await h.call("PUT", { settings: { enabled: false }, expectedRevision: 0 });
  assert.equal(stale.status, 409);

  await h.pkg.onDisable!();
  assert.equal(h.sections.has("todos"), false);
  assert.equal(h.changes(), 2, "disabling an active rule re-projects behavior");
  assert.equal((await h.call("GET")).body.active, false);

  await h.pkg.onEnable!();
  assert.equal(h.changes(), 3, "re-enabling a saved active rule re-projects");
});

test("only the instance owner may change the global rule", async (t) => {
  const h = harness(t);
  await h.pkg.onEnable!();
  const denied = await h.call("PUT", { settings: { enabled: true }, expectedRevision: 0 }, false);
  assert.equal(denied.status, 403);
  assert.equal(h.changes(), 0);
  const read = await h.call("GET", undefined, false);
  assert.equal(read.status, 200);
  assert.equal((read.body.settings as { enabled: boolean }).enabled, false);
  const invalid = await h.call("PUT", { settings: { enabled: "on" }, expectedRevision: 0 });
  assert.equal(invalid.status, 400);
  assert.equal((await h.call("DELETE")).handled, false);
});

test("a host without behavior sections still serves settings", async (t) => {
  const h = harness(t, { withSections: false });
  await h.pkg.onEnable!();
  const saved = await h.call("PUT", { settings: { enabled: true }, expectedRevision: 0 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.active, false);
  await h.pkg.onDisable!();
});
