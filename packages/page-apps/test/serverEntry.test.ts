import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test, type TestContext } from "node:test";
import type { RouteRequest, SpaceContext } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import registerPackage, { PAGE_APPS_REMOTE_ACCESS } from "../src/serverEntry.ts";
import { APP_LIMITS, type AppView } from "../src/apps.ts";

const ctx = (spaceId: string, userId: string, extra: Record<string, unknown> = {}) =>
  ({ spaceId, userId, role: "member", spaceSlug: spaceId, storageDir: "", ...extra }) as unknown as SpaceContext;

interface Reply {
  handled: boolean;
  status: number;
  body: {
    app: AppView;
    apps: AppView[];
    removed: AppView;
    outcome: string;
    html: string;
    storage: Record<string, string>;
    keys: number;
    error?: string;
  };
}

function fixture(t: TestContext, options: { people?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "page-apps-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = {
    ...(options.people === false ? {} : {
      people: {
        storage: (userId: string, packageId: string) => {
          const base = resolve(root, "people", userId, "packages", packageId);
          mkdirSync(base, { recursive: true });
          return {
            root: base,
            path: (relative: string) => {
              const target = resolve(base, relative);
              if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error("escape");
              return target;
            },
          };
        },
      },
    }),
  } as unknown as ServerPackageHost;
  const pkg = registerPackage(host);
  const call = async (space: SpaceContext, method: string, path: string, body: Record<string, unknown> = {}): Promise<Reply> => {
    let status = 0;
    let payload: unknown;
    const url = new URL(`http://localhost${path}`);
    const handled = await pkg.routes!({
      method,
      path: url.pathname,
      url,
      space,
      body: async () => body,
      json: (code: number, value: unknown) => { status = code; payload = value; },
    } as unknown as RouteRequest);
    return { handled: handled === true, status, body: payload as Reply["body"] };
  };
  const stored = (userId: string, spaceId: string, ...parts: string[]) =>
    join(root, "people", userId, "packages", "page-apps", "spaces", spaceId, ...parts);
  return { call, stored, root };
}

const alice = ctx("space", "alice");
const bob = ctx("space", "bob");
const aliceElsewhere = ctx("other", "alice");
const PAGE = "<h1>Budget</h1><script>polyth.storage.setItem('n','1')</script>";

test("a page is kept as an app with its text, and opens with what it stored", async (t) => {
  const { call, stored } = fixture(t);
  const saved = await call(alice, "POST", "/api/page-apps", { title: "  Budget\n2026 ", html: PAGE, source: { sessionId: "s1", projectId: "p1" } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.outcome, "created");
  const app = saved.body.app;
  assert.equal(app.title, "Budget 2026");
  assert.equal(app.version, 1);
  assert.match(app.id, /^[0-9a-f-]{36}$/);
  assert.match(app.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(app.source, { sessionId: "s1", projectId: "p1" });
  assert.equal(readFileSync(stored("alice", "space", "apps", app.id, "page.html"), "utf8"), PAGE);

  assert.equal((await call(alice, "POST", "/api/page-apps/storage", { id: app.id, set: { a: "1", b: "2" } })).body.keys, 2);
  assert.equal((await call(alice, "POST", "/api/page-apps/storage", { id: app.id, remove: ["a"], set: { c: "3" } })).body.keys, 2);
  const opened = await call(alice, "GET", `/api/page-apps/app?id=${app.id}`);
  assert.equal(opened.status, 200);
  assert.equal(opened.body.html, PAGE);
  assert.deepEqual({ ...opened.body.storage }, { b: "2", c: "3" });
  assert.equal((await call(alice, "POST", "/api/page-apps/storage", { id: app.id, clear: true, set: { z: "9" } })).body.keys, 1);
  assert.deepEqual({ ...(await call(alice, "GET", `/api/page-apps/app?id=${app.id}`)).body.storage }, { z: "9" });

  const list = await call(alice, "GET", "/api/page-apps");
  assert.deepEqual(list.body.apps.map((item) => item.id), [app.id]);
  assert.equal("html" in list.body.apps[0]!, false, "the list carries no pages");
});

test("saving the same page again updates the app instead of making a second one", async (t) => {
  const { call } = fixture(t);
  const source = { sessionId: "s1" };
  const first = (await call(alice, "POST", "/api/page-apps", { title: "Budget", html: "<p>1</p>", source })).body.app;
  const same = await call(alice, "POST", "/api/page-apps", { title: "budget", html: "<p>1</p>", source });
  assert.equal(same.body.outcome, "unchanged");
  assert.equal(same.body.app.version, 1);
  await call(alice, "POST", "/api/page-apps/storage", { id: first.id, set: { kept: "yes" } });
  const next = await call(alice, "POST", "/api/page-apps", { title: "Budget", html: "<p>2</p>", source });
  assert.equal(next.body.outcome, "updated");
  assert.equal(next.body.app.id, first.id);
  assert.equal(next.body.app.version, 2);
  assert.notEqual(next.body.app.hash, first.hash);
  const opened = await call(alice, "GET", `/api/page-apps/app?id=${first.id}`);
  assert.equal(opened.body.html, "<p>2</p>");
  assert.deepEqual({ ...opened.body.storage }, { kept: "yes" }, "a new version keeps the app's data");

  // Another title in the same chat, a project file, and a page with no source are their own apps.
  assert.equal((await call(alice, "POST", "/api/page-apps", { title: "Tracker", html: "<p>2</p>", source })).body.outcome, "created");
  const file = { projectId: "p1", from: "tools/budget.html", sessionId: "s1" };
  assert.equal((await call(alice, "POST", "/api/page-apps", { title: "From a file", html: "<p>f</p>", source: file })).body.outcome, "created");
  assert.equal((await call(alice, "POST", "/api/page-apps", { title: "Renamed in the fence", html: "<p>g</p>", source: { ...file, sessionId: "s9" } })).body.outcome, "updated");
  assert.equal((await call(alice, "POST", "/api/page-apps", { title: "Loose", html: "<p>x</p>" })).body.outcome, "created");
  assert.equal((await call(alice, "POST", "/api/page-apps", { title: "Loose", html: "<p>x</p>" })).body.outcome, "created");
  assert.equal((await call(alice, "GET", "/api/page-apps")).body.apps.length, 5);
});

test("an app belongs to one person in one Space", async (t) => {
  const { call, stored } = fixture(t);
  const app = (await call(alice, "POST", "/api/page-apps", { title: "Budget", html: PAGE })).body.app;
  await call(alice, "POST", "/api/page-apps/storage", { id: app.id, set: { secret: "alice's" } });

  // A known-valid id of someone else's app is as absent as a made-up one.
  const madeUp = "11111111-1111-4111-8111-111111111111";
  for (const stranger of [bob, aliceElsewhere]) {
    assert.deepEqual((await call(stranger, "GET", "/api/page-apps")).body.apps, []);
    for (const id of [app.id, madeUp]) {
      const opened = await call(stranger, "GET", `/api/page-apps/app?id=${id}`);
      assert.equal(opened.status, 404);
      assert.equal(opened.body.error, "not-found");
      assert.equal((await call(stranger, "POST", "/api/page-apps/update", { id, title: "Mine now" })).status, 404);
      assert.equal((await call(stranger, "POST", "/api/page-apps/storage", { id, set: { secret: "overwritten" } })).status, 404);
      assert.equal((await call(stranger, "POST", "/api/page-apps/delete", { id })).status, 404);
    }
  }
  const opened = await call(alice, "GET", `/api/page-apps/app?id=${app.id}`);
  assert.equal(opened.body.app.title, "Budget");
  assert.deepEqual({ ...opened.body.storage }, { secret: "alice's" });
  assert.equal(existsSync(stored("bob", "space", "apps")), false, "a refused request writes nothing");

  // The same source in another person's storage is another app.
  const bobs = await call(bob, "POST", "/api/page-apps", { title: "Budget", html: PAGE, source: { sessionId: "s1" } });
  assert.equal(bobs.body.outcome, "created");
  assert.notEqual(bobs.body.app.id, app.id);
});

test("only a signed-in person keeps apps", async (t) => {
  const { call } = fixture(t);
  for (const space of [ctx("space", "system:polyth-runtime"), ctx("space", ""), ctx("space", "alice", { authority: { kind: "system" } })]) {
    for (const [method, path] of [["GET", "/api/page-apps"], ["POST", "/api/page-apps"], ["POST", "/api/page-apps/storage"]] as const) {
      const reply = await call(space, method, path, { title: "x", html: "<p>x</p>" });
      assert.equal(reply.status, 403, `${method} ${path}`);
    }
  }
  assert.equal((await call(ctx("../escape", "alice"), "GET", "/api/page-apps")).status, 400);
  const noPeople = fixture(t, { people: false });
  assert.equal((await noPeople.call(alice, "GET", "/api/page-apps")).status, 503);
});

test("ids never reach a path unless the server minted them", async (t) => {
  const { call, root } = fixture(t);
  writeFileSync(join(root, "outside.json"), "{}");
  for (const id of ["..", "../../outside", "apps", "", "A1111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111/.."]) {
    assert.equal((await call(alice, "GET", `/api/page-apps/app?id=${encodeURIComponent(id)}`)).status, 404, id);
    assert.equal((await call(alice, "POST", "/api/page-apps/delete", { id })).status, 404, id);
    assert.equal((await call(alice, "POST", "/api/page-apps/storage", { id, set: { a: "1" } })).status, 404, id);
  }
  assert.equal((await call(alice, "POST", "/api/page-apps/delete", { id: 5 as never })).status, 404);
  assert.equal(existsSync(join(root, "outside.json")), true);
});

test("limits: page size, names, storage and the number of apps", async (t) => {
  const { call } = fixture(t);
  assert.equal((await call(alice, "POST", "/api/page-apps", { title: "", html: PAGE })).status, 400);
  assert.equal((await call(alice, "POST", "/api/page-apps", { title: "x".repeat(APP_LIMITS.titleChars + 1), html: PAGE })).status, 400);
  assert.equal((await call(alice, "POST", "/api/page-apps", { title: "Big", html: "   " })).status, 400);
  assert.equal((await call(alice, "POST", "/api/page-apps", { title: "Big", html: "x".repeat(APP_LIMITS.htmlBytes + 1) })).status, 413);
  const app = (await call(alice, "POST", "/api/page-apps", { title: "Budget", html: PAGE })).body.app;

  assert.equal((await call(alice, "POST", "/api/page-apps/storage", { id: app.id, set: { a: 5 } as never })).status, 400);
  assert.equal((await call(alice, "POST", "/api/page-apps/storage", { id: app.id, set: { "": "v" } })).status, 400);
  assert.equal((await call(alice, "POST", "/api/page-apps/storage", { id: app.id, remove: "a" as never })).status, 400);
  // Each value fits, the map as a whole does not: nothing of the request is kept.
  const chunk = "x".repeat(60 * 1024);
  await call(alice, "POST", "/api/page-apps/storage", { id: app.id, set: { a: chunk, b: chunk, c: chunk, d: chunk } });
  const full = await call(alice, "POST", "/api/page-apps/storage", { id: app.id, set: { e: chunk, small: "1" } });
  assert.equal(full.status, 413);
  assert.deepEqual(Object.keys((await call(alice, "GET", `/api/page-apps/app?id=${app.id}`)).body.storage).sort(), ["a", "b", "c", "d"]);

  assert.equal((await call(alice, "POST", "/api/page-apps/update", { id: app.id, title: " Plan " })).body.app.title, "Plan");
  assert.equal((await call(alice, "POST", "/api/page-apps/update", { id: app.id, title: " " })).status, 400);

  for (let index = 1; index < APP_LIMITS.apps; index += 1) {
    assert.equal((await call(alice, "POST", "/api/page-apps", { title: `App ${index}`, html: `<p>${index}</p>` })).status, 200);
  }
  const over = await call(alice, "POST", "/api/page-apps", { title: "One too many", html: "<p>n</p>" });
  assert.equal(over.status, 409);
  assert.equal((await call(alice, "POST", "/api/page-apps/delete", { id: app.id })).body.removed.id, app.id);
  assert.equal((await call(alice, "GET", `/api/page-apps/app?id=${app.id}`)).status, 404);
  assert.equal((await call(alice, "POST", "/api/page-apps", { title: "Room again", html: "<p>n</p>" })).status, 200);
});

test("a damaged record or storage file is not an app's truth", async (t) => {
  const { call, stored } = fixture(t);
  const app = (await call(alice, "POST", "/api/page-apps", { title: "Budget", html: PAGE })).body.app;
  writeFileSync(stored("alice", "space", "apps", app.id, "storage.json"), "{ not json");
  assert.deepEqual({ ...(await call(alice, "GET", `/api/page-apps/app?id=${app.id}`)).body.storage }, {});
  writeFileSync(stored("alice", "space", "apps", app.id, "storage.json"), JSON.stringify({ values: { ok: "1", bad: 5, ["k".repeat(500)]: "x" } }));
  assert.deepEqual({ ...(await call(alice, "GET", `/api/page-apps/app?id=${app.id}`)).body.storage }, { ok: "1" });
  // A record copied under another id does not become that app.
  const other = "22222222-2222-4222-8222-222222222222";
  mkdirSync(stored("alice", "space", "apps", other), { recursive: true });
  writeFileSync(stored("alice", "space", "apps", other, "app.json"), readFileSync(stored("alice", "space", "apps", app.id, "app.json")));
  assert.equal((await call(alice, "GET", `/api/page-apps/app?id=${other}`)).status, 404);
  writeFileSync(stored("alice", "space", "apps", app.id, "app.json"), "{");
  assert.deepEqual((await call(alice, "GET", "/api/page-apps")).body.apps, []);
});

test("routes it does not own are left to others, and paired devices are scoped", async (t) => {
  const { call } = fixture(t);
  assert.equal((await call(alice, "GET", "/api/page-apps-other")).handled, false);
  assert.equal((await call(alice, "GET", "/api/page-apps/unknown")).handled, false);
  assert.equal((await call(alice, "DELETE", "/api/page-apps")).handled, false);
  assert.deepEqual(PAGE_APPS_REMOTE_ACCESS.routeScopes, ["page-apps"]);
  for (const rule of PAGE_APPS_REMOTE_ACCESS.http ?? []) {
    assert.equal(rule.mutation, rule.methods.includes("POST"), rule.path);
    if (rule.mutation) assert.ok((rule.maxBodyBytes ?? 0) > 0 && (rule.maxBodyBytes ?? 0) <= 2 * 1024 * 1024, `${rule.path} is bounded`);
  }
});
