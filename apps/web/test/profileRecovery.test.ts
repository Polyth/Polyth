import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AgentProfile } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";

const recoveredProfile: AgentProfile = {
  id: "profile-recovered",
  name: "Recovered profile",
  providerID: "openai",
  modelID: "gpt-recovered",
  features: {},
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

test("a transient profile failure stays unconfirmed and a later refresh recovers", async () => {
  const original = api.listProfiles;
  let attempts = 0;
  api.listProfiles = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new Error("server shutting down"), {
        code: "unavailable",
        status: 503,
      });
    }
    return [recoveredProfile];
  };

  try {
    const profiles = await import("../src/profiles.ts");
    await assert.rejects(profiles.refreshProfiles(), { status: 503 });
    assert.equal(profiles.profilesLoaded(), false);
    assert.deepEqual(profiles.getProfiles(), []);

    assert.deepEqual(await profiles.refreshProfiles(), [recoveredProfile]);
    assert.equal(profiles.profilesLoaded(), true);
    assert.deepEqual(profiles.getProfiles(), [recoveredProfile]);
  } finally {
    api.listProfiles = original;
  }
});

test("successful sync reconnect refreshes the account profile cache", async () => {
  const source = await readFile(new URL("../src/init.ts", import.meta.url), "utf8");
  const reconnect = source.slice(
    source.indexOf("sync.onOpen(() =>"),
    source.indexOf("void initPluginBridge(sync)"),
  );

  assert.match(reconnect, /void refreshProfiles\(\)\.catch\(\(\) => undefined\)/);
});

test("concurrent refreshProfiles calls are deduplicated into a single in-flight request", async () => {
  const original = api.listProfiles;
  let calls = 0;
  api.listProfiles = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return [recoveredProfile];
  };

  try {
    const profiles = await import("../src/profiles.ts");
    const [res1, res2, res3] = await Promise.all([
      profiles.refreshProfiles(),
      profiles.refreshProfiles(),
      profiles.refreshProfiles(),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(res1, [recoveredProfile]);
    assert.deepEqual(res2, [recoveredProfile]);
    assert.deepEqual(res3, [recoveredProfile]);
  } finally {
    api.listProfiles = original;
  }
});

