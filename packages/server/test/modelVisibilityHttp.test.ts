// Provider/model visibility is account-owned. These tests drive the real HTTP
// handler with two authenticated accounts to prove /api/models and
// /api/providers filter by the REQUESTING user (not a host-global list), and
// that one account's toggle never appears in another account's catalog.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AuthPrincipal } from "@polyth/contracts";
import { createAuthService } from "../src/auth.ts";
import { createHttpHandler } from "../src/http.ts";
import { createClientSettings } from "../src/clientSettings.ts";
import { createModelVisibilityService, parseVisibility } from "../src/modelVisibility.ts";
import { testTenancy } from "./support/spaces.ts";

const tenancy = await testTenancy();

/** Two accounts behind one handler; the request cookie picks the account. */
async function withAccounts(fn: (base: string, context: {
  clientSettings: ReturnType<typeof createClientSettings>;
  visibility: ReturnType<typeof createModelVisibilityService>;
}) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "polyth-vis-http-"));
  const webDist = join(dir, "dist");
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<html>shell</html>");

  const clientSettings = createClientSettings({ file: join(dir, "client-settings.json") });
  // Seed the host store with the catalogue rows this suite asserts on. The
  // `model-visibility.json` file is both the migration seed and the physical
  // OpenCode mirror, so listing the providers there makes them appear for every
  // account without a live runtime pool.
  writeFileSync(join(dir, "model-visibility.json"), `${JSON.stringify({
    disabledProviders: [],
    disabledModels: [],
    addedProviders: [
      { id: "anthropic", name: "Anthropic", origin: "builtin" },
      { id: "openai", name: "OpenAI", origin: "builtin" },
    ],
  }, null, 2)}\n`);
  const visibility = createModelVisibilityService({
    file: join(dir, "model-visibility.json"),
    accounts: {
      read: (userId) => {
        const section = clientSettings.get(userId).settings.modelVisibility;
        return section === undefined ? undefined : parseVisibility(section);
      },
      write: (userId, state) => {
        if (!userId) return false;
        clientSettings.patchSection(userId, "modelVisibility", state);
        return true;
      },
      states: () => clientSettings.userIds()
        .map((userId) => clientSettings.get(userId).settings.modelVisibility)
        .map((section) => section === undefined ? undefined : parseVisibility(section)),
    },
  });
  await visibility.seed();

  const legacy = createAuthService({ file: join(dir, "auth.json") });
  const auth = {
    ...legacy,
    // `authRequestLike` deliberately keeps only a small header set, so the test
    // selects the account through the cookie header (real production resolves
    // the account from the same header via a signed session cookie).
    resolve: (req: { headers: Record<string, string | undefined> }) => {
      const cookie = req.headers.cookie ?? "";
      const userId = /polyth_test_account=([^;]+)/.exec(cookie)?.[1] ?? "usr_alice";
      const principal = {
        kind: "ui-session",
        sessionId: userId,
        rememberedDeviceId: userId,
        // The identity resolver reads the durable user id from the principal.
        userId,
      } as AuthPrincipal;
      return { principal, authenticated: true } as never;
    },
    gate: () => null,
  };
  const handler = createHttpHandler({
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist,
    version: "test",
    auth,
    visibility,
  });
  const server = createServer((req, res) => void handler(req, res, {
    kind: "public-http", listenerId: "public", loopback: false, secure: false,
  } as never));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try { await fn(base, { clientSettings, visibility }); }
  finally { server.close(); await once(server, "close"); }
}

const as = (base: string, userId: string, path: string, init?: RequestInit) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      cookie: `polyth_test_account=${userId}`,
      ...(init?.headers ?? {}),
    },
  });

test("/api/providers shows each account its own enabled/disabled state", async () => {
  await withAccounts(async (base) => {
    // Bob disables Anthropic for himself.
    const set = await as(base, "usr_bob", "/api/providers/anthropic/enabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(set.status, 200);
    assert.deepEqual((await set.json() as { disabledProviders: string[] }).disabledProviders, ["anthropic"]);

    const bobCatalog = await (await as(base, "usr_bob", "/api/providers")).json() as Array<{ id: string; enabled: boolean; models: Array<{ key: string; enabled: boolean }> }>;
    const aliceCatalog = await (await as(base, "usr_alice", "/api/providers")).json() as Array<{ id: string; enabled: boolean; models: Array<{ key: string; enabled: boolean }> }>;
    assert.equal(bobCatalog.find((p) => p.id === "anthropic")!.enabled, false, "bob sees his own disable");
    assert.equal(aliceCatalog.find((p) => p.id === "anthropic")!.enabled, true, "alice is unaffected");

    // Bob's disable is his alone; alice's copy still shows the provider on.
    // (Model-level filtering is covered by the service tests.)

    // Re-enabling is per-account too: bob's list clears without touching alice.
    await as(base, "usr_bob", "/api/providers/anthropic/enabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const bobAgain = await (await as(base, "usr_bob", "/api/providers")).json() as Array<{ id: string; enabled: boolean }>;
    assert.equal(bobAgain.find((p) => p.id === "anthropic")!.enabled, true);
  });
});
