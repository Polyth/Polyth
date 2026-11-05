// A request with no runtime or session: Pi's print mode in the caller's directory,
// on exactly this harness's login.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ServerPackageHost } from "@polyth/plugins";
import { createHarnessRegistry } from "@polyth/harness-runtime";
import registerPackage from "../src/serverEntry.ts";

async function fakePi(t: TestContext): Promise<{ log: string; cwd: string }> {
  const dir = await mkdtemp(join(tmpdir(), "polyth-pi-utility-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "pi");
  const log = join(dir, "log.json");
  await writeFile(bin, `#!/bin/sh
printf '{"args":"%s","pwd":"%s"}' "$*" "$PWD" > '${log}'
cat > /dev/null
echo OK
`);
  await chmod(bin, 0o700);
  const previous = process.env.POLYTH_PI_BIN;
  process.env.POLYTH_PI_BIN = bin;
  t.after(() => {
    if (previous === undefined) delete process.env.POLYTH_PI_BIN;
    else process.env.POLYTH_PI_BIN = previous;
  });
  return { log, cwd: dir };
}

test("Pi answers one print-mode request without a session", async (t) => {
  const { log, cwd } = await fakePi(t);
  const registry = createHarnessRegistry();
  const pkg = registerPackage({
    deployment: "local-trusted",
    services: { require: () => registry },
  } as unknown as ServerPackageHost);
  await pkg.onEnable!();
  t.after(() => pkg.onDisable!());
  const result = await registry.get("pi")!.completeUtility!({ cwd, prompt: "Reply with just: OK", model: { providerID: "opencode-go", modelID: "mimo-v2.6-flash" } });
  assert.equal(result.text, "OK");
  const seen = JSON.parse(await readFile(log, "utf8")) as { args: string; pwd: string };
  assert.ok(seen.pwd.endsWith(cwd.split("/").at(-1)!));
  assert.match(seen.args, /mimo-v2\.6-flash/);
  assert.match(seen.args, /--no-tools/);
});
