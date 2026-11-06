// A request with no runtime or native thread: one ephemeral `codex exec` in the
// caller's directory, on exactly this harness's login.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createCodexProvider } from "../src/serverEntry.ts";

async function fakeCodex(t: TestContext): Promise<{ log: string; cwd: string }> {
  const dir = await mkdtemp(join(tmpdir(), "polyth-codex-utility-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "codex");
  const log = join(dir, "log.json");
  await writeFile(bin, `#!/bin/sh
printf '{"args":"%s","home":"%s"}' "$*" "$CODEX_HOME" > '${log}'
cat > /dev/null
echo OK
`);
  await chmod(bin, 0o700);
  const previous = process.env.POLYTH_CODEX_BIN;
  process.env.POLYTH_CODEX_BIN = bin;
  t.after(() => {
    if (previous === undefined) delete process.env.POLYTH_CODEX_BIN;
    else process.env.POLYTH_CODEX_BIN = previous;
  });
  return { log, cwd: dir };
}

const host = { pluginId: "backend-codex" } as unknown as Parameters<typeof createCodexProvider>[0];
const model = { providerID: "openai", modelID: "gpt-5.5-codex-mini" };

test("an account's request reads only that account's login", async (t) => {
  const { log, cwd } = await fakeCodex(t);
  const provider = createCodexProvider(host, { id: "work", harnessId: "codex-work", name: "Work", dir: "/accounts/work" });
  const result = await provider.completeUtility!({ cwd, prompt: "Reply with just: OK", model });
  assert.equal(result.text, "OK");
  const seen = JSON.parse(await readFile(log, "utf8")) as { args: string; home: string };
  assert.equal(seen.home, "/accounts/work");
  assert.match(seen.args, /^exec --ephemeral --skip-git-repo-check --sandbox read-only .*--model gpt-5\.5-codex-mini/);
});

test("the default login stays the default", async (t) => {
  const { log, cwd } = await fakeCodex(t);
  await createCodexProvider(host).completeUtility!({ cwd, prompt: "Reply with just: OK", model });
  const seen = JSON.parse(await readFile(log, "utf8")) as { home: string };
  assert.equal(seen.home, process.env.CODEX_HOME ?? "");
});
