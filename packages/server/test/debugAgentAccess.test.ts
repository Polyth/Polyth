import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../src/index.ts";

const tempData = (): string => mkdtempSync(join(tmpdir(), "polyth-debug-agent-access-"));

async function bootsDebugOverride(
  env: Record<string, string | undefined>,
  hostname = "127.0.0.1",
  port = 4481,
): Promise<void> {
  const before = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    before.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const dataDir = tempData();
  try {
    const runtime = await boot({ port, hostname, dataDir });
    try {
      assert.equal(runtime.setup, true);
    } finally {
      await runtime.shutdown();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("debug agent access permits explicit operator override outside loopback-only local-trusted deployment", async () => {
  await bootsDebugOverride({
    POLYTH_DEBUG_AGENT_ACCESS: "1",
    POLYTH_PUBLIC_ORIGIN: undefined,
    POLYTH_DEPLOYMENT_PROFILE: "local-trusted",
  }, "0.0.0.0", 4481);

  await bootsDebugOverride({
    POLYTH_DEBUG_AGENT_ACCESS: "1",
    POLYTH_PUBLIC_ORIGIN: "https://polyth.example",
    POLYTH_TRUSTED_PROXIES: "127.0.0.1",
    POLYTH_DEPLOYMENT_PROFILE: "local-trusted",
  }, "127.0.0.1", 4482);

  await bootsDebugOverride({
    POLYTH_DEBUG_AGENT_ACCESS: "1",
    POLYTH_PUBLIC_ORIGIN: undefined,
    POLYTH_DEPLOYMENT_PROFILE: "multi-tenant-sandboxed",
  }, "127.0.0.1", 4483);
});


async function rejectsAgentBetaExposure(
  env: Record<string, string | undefined>,
  hostname: string,
  port: number,
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
      () => boot({ port, hostname, dataDir }),
      /POLYTH_AGENT_BETA requires loopback-only local-trusted deployment/,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("agent beta is fail-closed outside loopback-only local-trusted deployment", async () => {
  await rejectsAgentBetaExposure({
    POLYTH_AGENT_BETA: "1",
    POLYTH_PUBLIC_ORIGIN: undefined,
    POLYTH_DEPLOYMENT_PROFILE: "local-trusted",
  }, "0.0.0.0", 4484);

  await rejectsAgentBetaExposure({
    POLYTH_AGENT_BETA: "1",
    POLYTH_PUBLIC_ORIGIN: undefined,
    POLYTH_DEPLOYMENT_PROFILE: "multi-tenant-sandboxed",
  }, "127.0.0.1", 4485);

  await rejectsAgentBetaExposure({
    POLYTH_AGENT_BETA: "1",
    POLYTH_PUBLIC_ORIGIN: "https://polyth.example",
    POLYTH_DEPLOYMENT_PROFILE: "local-trusted",
  }, "127.0.0.1", 4486);
});
