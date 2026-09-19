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
