// A request with no runtime and no canonical session, which an Antigravity runtime
// otherwise requires: `agy --print` on this account's private home.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ServerPackageHost } from "@polyth/plugins";
import { createHarnessRegistry } from "@polyth/harness-runtime";
import { createAntigravityPackage } from "../src/serverEntry.ts";

function useEnvironment(t: TestContext, name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("each login answers on its own home, with no session", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-agy-utility-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  await mkdir(home);
  useEnvironment(t, "HOME", home);
  const bin = join(dir, "agy");
  const log = join(dir, "log.json");
  await writeFile(bin, `#!/bin/sh
printf '{"args":"%s","home":"%s"}' "$*" "$HOME" > '${log}'
echo OK
`);
  await chmod(bin, 0o700);
  useEnvironment(t, "POLYTH_ANTIGRAVITY_BIN", bin);
  const storageDir = join(dir, "storage");
  await mkdir(storageDir);
  await writeFile(join(storageDir, "antigravity-accounts.json"), JSON.stringify([{ id: "work", name: "Work" }]));
  const registry = createHarnessRegistry();
  const pkg = createAntigravityPackage({
    storageDir,
    deployment: "local-trusted",
    services: { require: () => registry },
  } as unknown as ServerPackageHost);
  await pkg.onEnable!();
  t.after(() => pkg.onDisable!());
  const cwd = join(dir, "work");
  await mkdir(cwd);
  const model = { providerID: "antigravity", modelID: "gemini-3.8-flash" };

  const account = await registry.get("antigravity-work")!.completeUtility!({ cwd, prompt: "Reply with just: OK", model });
  assert.equal(account.text, "OK");
  let seen = JSON.parse(await readFile(log, "utf8")) as { args: string; home: string };
  assert.equal(seen.home, join(storageDir, "antigravity-accounts", "work"));
  assert.match(seen.args, /--print=Reply with just: OK --output-format text --disable-slash-commands --model gemini-3\.8-flash/);

  await registry.get("antigravity")!.completeUtility!({ cwd, prompt: "Reply with just: OK", model });
  seen = JSON.parse(await readFile(log, "utf8")) as { args: string; home: string };
  assert.equal(seen.home, home);
});
