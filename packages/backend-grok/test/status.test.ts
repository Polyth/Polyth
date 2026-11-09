import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { createGrokProfile, parseGrokModelsStatus } from "../src/serverEntry.ts";

test("parseGrokModelsStatus reads the signed-out banner", () => {
  const status = parseGrokModelsStatus({
    stdout: "You are not authenticated.\nDefault model: grok-code-fast-1\nAvailable models:\n  grok-code-fast-1\n",
    stderr: "",
    ok: true,
  });
  assert.deepEqual(status, { loggedIn: false });
});

test("parseGrokModelsStatus reads the API key banner", () => {
  const status = parseGrokModelsStatus({
    stdout: "You are using XAI_API_KEY.\nDefault model: grok-code-fast-1\n",
    stderr: "",
    ok: true,
  });
  assert.deepEqual(status, { loggedIn: true, plan: "API key" });
});

test("parseGrokModelsStatus reports a signed-in login with its email", () => {
  const status = parseGrokModelsStatus({
    stdout: "\n  Signed in as someone@example.com\nDefault model: grok-code-fast-1\n",
    stderr: "",
    ok: true,
  });
  assert.deepEqual(status, { loggedIn: true, email: "someone@example.com" });
});

test("parseGrokModelsStatus keeps a signed-in login without an email", () => {
  const status = parseGrokModelsStatus({
    stdout: "Signed in with browser credentials.\nAvailable models:\n  grok-code-fast-1\n",
    stderr: "",
    ok: true,
  });
  assert.deepEqual(status, { loggedIn: true });
});

test("parseGrokModelsStatus treats a failed run as unknown", () => {
  const status = parseGrokModelsStatus({ stdout: "", stderr: "boom\n", ok: false });
  assert.deepEqual(status, { loggedIn: "unknown" });
});

test("parseGrokModelsStatus treats empty output as unknown", () => {
  const status = parseGrokModelsStatus({ stdout: "  \n", stderr: "", ok: true });
  assert.deepEqual(status, { loggedIn: "unknown" });
});

const posixOnly = { skip: process.platform === "win32" ? "POSIX shell fixture" : false };

let fixtureDir = "";
let fixtureBin = "";
const saved = {
  bin: process.env.POLYTH_GROK_BIN,
  key: process.env.XAI_API_KEY,
  grokHome: process.env.GROK_HOME,
  shellProbe: process.env.POLYTH_HARNESS_SHELL_PROBE,
};

/** Only the per-test credential is restored; the fixture binary and the
 *  disabled login-shell probe stay in place for the remaining tests. */
const restoreXaiKey = () => {
  if (saved.key === undefined) delete process.env.XAI_API_KEY;
  else process.env.XAI_API_KEY = saved.key;
};

const restoreEnv = () => {
  for (const [name, value] of [
    ["POLYTH_GROK_BIN", saved.bin],
    ["XAI_API_KEY", saved.key],
    ["GROK_HOME", saved.grokHome],
    ["POLYTH_HARNESS_SHELL_PROBE", saved.shellProbe],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

before(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "polyth-grok-status-"));
  fixtureBin = resolve(fixtureDir, "grok");
  // A stand-in CLI: `version` answers, `models` mirrors the sign-in fixture.
  await writeFile(fixtureBin, [
    "#!/bin/sh",
    'if [ "$1" = "version" ]; then echo "grok 9.9.9"; exit 0; fi',
    'if [ -n "$XAI_API_KEY" ]; then',
    '  echo "You are using XAI_API_KEY."',
    "else",
    '  echo "You are not authenticated."',
    "fi",
    'echo "Default model: grok-code-fast-1"',
    'echo "Available models:"',
    'echo "  grok-code-fast-1"',
    "exit 0",
    "",
  ].join("\n"), "utf8");
  await chmod(fixtureBin, 0o755);
  // Keep discovery hermetic and fast: no login-shell PATH probe.
  process.env.POLYTH_HARNESS_SHELL_PROBE = "off";
  process.env.POLYTH_GROK_BIN = fixtureBin;
});

after(async () => {
  restoreEnv();
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("the default profile probes the inherited API key as signed in", posixOnly, async () => {
  process.env.XAI_API_KEY = "test-key";
  try {
    const profile = createGrokProfile();
    const result = await profile.probe({} as never);
    assert.equal(result.authenticated, true);
    assert.equal(result.version, "grok 9.9.9");
  } finally {
    restoreXaiKey();
  }
});

test("an account profile ignores a server-wide XAI_API_KEY", posixOnly, async () => {
  process.env.XAI_API_KEY = "test-key";
  const accountDir = await mkdtemp(join(tmpdir(), "polyth-grok-account-"));
  try {
    const profile = createGrokProfile({
      id: "work",
      harnessId: "grok-work",
      name: "Work",
      dir: accountDir,
    });
    assert.equal(profile.env?.GROK_HOME, accountDir);
    assert.equal(profile.env?.XAI_API_KEY, undefined);
    const result = await profile.probe({} as never);
    assert.equal(result.authenticated, false);
    assert.equal(profile.env?.GROK_HOME, accountDir);
    assert.equal(profile.env?.XAI_API_KEY, undefined);
  } finally {
    restoreXaiKey();
    await rm(accountDir, { recursive: true, force: true });
  }
});
