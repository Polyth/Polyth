import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeDiagnostics } from "../src/runtimeDiagnostics.ts";
import { runtimeDiagnosticsRoutes } from "../src/routes/runtimeDiagnostics.ts";

const LOCATION = { projectId: "p1", cwd: "/work/p1" };

const missing = (): Error =>
  Object.assign(new Error('OpenCode CLI "opencode" was not found. Searched /usr/bin/opencode.'), {
    code: "unavailable",
    searched: ["/usr/bin/opencode"],
  });

test("a swallowed spawn failure is recorded with its cause and search list", async () => {
  const diagnostics = createRuntimeDiagnostics({ log: () => {} });

  await assert.rejects(
    () => diagnostics.observe("k", LOCATION, async () => { throw missing(); }),
    /was not found/,
  );

  const [report] = diagnostics.list();
  assert.equal(report?.projectId, "p1");
  assert.equal(report?.cwd, "/work/p1");
  assert.equal(report?.code, "unavailable");
  assert.deepEqual(report?.searched, ["/usr/bin/opencode"]);
  assert.equal(report?.attempts, 1);
});

test("one reason is logged once no matter how often the browser retries", async () => {
  const logged: string[] = [];
  const diagnostics = createRuntimeDiagnostics({ log: (message) => logged.push(message) });

  for (let attempt = 0; attempt < 5; attempt++) {
    await diagnostics
      .observe("k", LOCATION, async () => { throw missing(); })
      .catch(() => {});
  }

  assert.equal(logged.length, 1, "a retry loop must not become a log flood");
  assert.match(logged[0]!, /runtime unavailable for p1/);
  assert.equal(diagnostics.latest()?.attempts, 5, "but every attempt is still counted");
});

test("a new reason for the same runtime is logged again", async () => {
  const logged: string[] = [];
  const diagnostics = createRuntimeDiagnostics({ log: (message) => logged.push(message) });

  await diagnostics.observe("k", LOCATION, async () => { throw missing(); }).catch(() => {});
  await diagnostics
    .observe("k", LOCATION, async () => {
      throw Object.assign(new Error("port 4096 is in use"), { code: "port-in-use" });
    })
    .catch(() => {});

  assert.equal(logged.length, 2);
  assert.equal(diagnostics.latest()?.code, "port-in-use");
});

test("recovery clears the report so a working composer shows no stale reason", async () => {
  const logged: string[] = [];
  const diagnostics = createRuntimeDiagnostics({ log: (message) => logged.push(message) });

  await diagnostics.observe("k", LOCATION, async () => { throw missing(); }).catch(() => {});
  assert.equal(await diagnostics.observe("k", LOCATION, async () => "runtime"), "runtime");

  assert.deepEqual(diagnostics.list(), []);
  assert.match(logged.at(-1)!, /recovered for p1 .* after 1 failed attempt$/);
});

test("the route answers ok until a runtime fails, then reports it", async () => {
  const diagnostics = createRuntimeDiagnostics({ log: () => {} });
  const route = runtimeDiagnosticsRoutes(diagnostics);
  const call = async (path: string, method: string) => {
    let captured: { code: number; body: unknown } | undefined;
    const handled = await route({
      path,
      method,
      json: (code, body) => { captured = { code, body }; },
    } as unknown as Parameters<typeof route>[0]);
    return { handled, captured };
  };

  const healthy = await call("/api/runtime/diagnostics", "GET");
  assert.equal(healthy.handled, true);
  assert.deepEqual(healthy.captured, { code: 200, body: { ok: true, runtimes: [] } });

  await diagnostics.observe("k", LOCATION, async () => { throw missing(); }).catch(() => {});
  const failing = await call("/api/runtime/diagnostics", "GET");
  const body = failing.captured?.body as { ok: boolean; runtimes: Array<{ code: string }> };
  assert.equal(body.ok, false);
  assert.equal(body.runtimes[0]?.code, "unavailable");

  assert.equal((await call("/api/runtime/diagnostics", "POST")).handled, false);
  assert.equal((await call("/api/models", "GET")).handled, false);
});
