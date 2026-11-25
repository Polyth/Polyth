import assert from "node:assert/strict";
import { test } from "node:test";
import { withLaunchEnv } from "../src/launchEnv.ts";

const launchEnv = { env: { POLYTH_TOOLS_GRANT_FILE: "/data/grants/a.json" }, pathPrepend: ["/data/bin"] };

test("a local launch gets the variables and the tools directory first on PATH", () => {
  const env = withLaunchEnv({ PATH: "/usr/bin:/bin", HOME: "/home/x" }, { launchEnv }, ":");
  assert.deepEqual(env, { PATH: "/data/bin:/usr/bin:/bin", HOME: "/home/x", POLYTH_TOOLS_GRANT_FILE: "/data/grants/a.json" });
  // Applying twice does not stack the directory.
  assert.equal(withLaunchEnv(env, { launchEnv }, ":").PATH, "/data/bin:/usr/bin:/bin");
});

test("Windows keeps its Path spelling", () => {
  const env = withLaunchEnv({ Path: "C:\\Windows" }, { launchEnv: { env: {}, pathPrepend: ["C:\\polyth\\bin"] } }, ";");
  assert.deepEqual(env, { Path: "C:\\polyth\\bin;C:\\Windows" });
});

test("a remote launch or a context without additions is left alone", () => {
  const base = { PATH: "/usr/bin" };
  assert.equal(withLaunchEnv(base, { launchEnv, remote: true }), base);
  assert.equal(withLaunchEnv(base, {}), base);
  assert.equal(withLaunchEnv(base, undefined), base);
});
