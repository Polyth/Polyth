import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../src/index.ts";

const tempData = (): string => mkdtempSync(join(tmpdir(), "polyth-debug-agent-access-"));

async function rejectsDebugBoot(
  t: test.TestContext,
  env: Record<string, string | undefined>,
  hostname = "127.0.0.1",
): Promise<void> {
  const before = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    before.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const dataDir = tempData();
  try {
    await assert.rejects(
      () => boot({ port: 4400, hostname, dataDir }),
      {
        code: "invalid-input",
        message: /POLYTH_DEBUG_AGENT_ACCESS requires a loopback-only local-trusted deployment/,
      },
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  t.assert.ok(true);
}

test("debug agent access refuses wildcard/public/hosted exposure before opening runtime", async t => {
  await rejectsDebugBoot(t, {
    POLYTH_DEBUG_AGENT_ACCESS: "1",
    POLYTH_PUBLIC_ORIGIN: undefined,
    POLYTH_DEPLOYMENT_PROFILE: "local-trusted",
  }, "0.0.0.0");

  await rejectsDebugBoot(t, {
    POLYTH_DEBUG_AGENT_ACCESS: "1",
    POLYTH_PUBLIC_ORIGIN: "https://polyth.example",
    POLYTH_DEPLOYMENT_PROFILE: "local-trusted",
  });

  await rejectsDebugBoot(t, {
    POLYTH_DEBUG_AGENT_ACCESS: "1",
    POLYTH_PUBLIC_ORIGIN: undefined,
    POLYTH_DEPLOYMENT_PROFILE: "multi-tenant-sandboxed",
  });
});
