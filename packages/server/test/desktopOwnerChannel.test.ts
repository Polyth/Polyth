import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../src/index.ts";
import { createCanonicalSecurity } from "../src/canonicalSecurity.ts";

// The password-less ("just me") first run exists only for Polyth Desktop and
// only in-process: a host that does not ask for the channel never gets it, and
// a password-less installation can never be published at a public origin.

const withEnv = async (env: Record<string, string | undefined>, work: () => Promise<void>): Promise<void> => {
  const before = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    before.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { await work(); }
  finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};
const loopbackOnly = { POLYTH_PUBLIC_ORIGIN: undefined, POLYTH_AGENT_BETA: undefined, POLYTH_DEBUG_AGENT_ACCESS: undefined };

test("only a Desktop host gets the password-less first run, and it finishes setup in-process", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "polyth-desktop-channel-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  await withEnv(loopbackOnly, async () => {
    const server = await boot({ port: 4487, hostname: "127.0.0.1", dataDir });
    try {
      assert.equal(server.setup, true);
      assert.equal("completeLocalSetup" in server, false, "a plain host has no password-less setup");
    } finally {
      await server.shutdown();
    }
    const desktop = await boot({ port: 4487, hostname: "127.0.0.1", dataDir, desktopOwnerChannel: true });
    try {
      assert.ok("completeLocalSetup" in desktop && typeof desktop.completeLocalSetup === "function");
      // Not an HTTP route: the setup server knows nothing about it.
      const status = await fetch("http://127.0.0.1:4487/api/auth/setup/local", {
        method: "POST", headers: { origin: "http://127.0.0.1:4487", "content-type": "application/json" }, body: "{}",
      });
      assert.notEqual(status.status, 200);
      desktop.completeLocalSetup({ name: "Ida" });
    } finally {
      await desktop.shutdown();
    }
  });
  const security = createCanonicalSecurity({ dataDir, origin: "http://127.0.0.1:4487", localOnly: true });
  try {
    assert.equal(security.control.installation().state, "ready");
    assert.equal(security.identity.accessMode(), "local");
  } finally {
    security.close();
  }
});

test("a password-less installation is never published at a public origin", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "polyth-desktop-public-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const security = createCanonicalSecurity({ dataDir, origin: "http://127.0.0.1:4488", localOnly: true });
  security.identity.setup.completeLocal({ name: "Ida" });
  security.close();
  await withEnv({ ...loopbackOnly, POLYTH_PUBLIC_ORIGIN: "https://polyth.example", POLYTH_TRUSTED_PROXIES: "127.0.0.1" }, async () => {
    await assert.rejects(() => boot({ port: 4488, hostname: "127.0.0.1", dataDir }), { code: "owner-credential-required" });
  });
});

test("a server behind a public origin never offers the password-less first run", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "polyth-desktop-public-setup-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  await withEnv({ ...loopbackOnly, POLYTH_PUBLIC_ORIGIN: "https://polyth.example", POLYTH_TRUSTED_PROXIES: "127.0.0.1" }, async () => {
    const server = await boot({ port: 4489, hostname: "127.0.0.1", dataDir, desktopOwnerChannel: true });
    try {
      assert.equal(server.setup, true);
      assert.equal("completeLocalSetup" in server, false);
    } finally {
      await server.shutdown();
    }
  });
});
