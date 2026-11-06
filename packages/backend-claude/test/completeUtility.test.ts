// A request with no runtime and no session: it runs the CLI's print mode in the
// caller's directory, on exactly this harness's login.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createClaudeProvider } from "../src/serverEntry.ts";

async function fakeClaude(t: TestContext): Promise<{ log: string; cwd: string }> {
  const dir = await mkdtemp(join(tmpdir(), "polyth-claude-utility-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "claude");
  const log = join(dir, "log.json");
  await writeFile(bin, `#!/bin/sh
printf '{"args":"%s","config":"%s","cwd":"%s"}' "$*" "$CLAUDE_CONFIG_DIR" "$PWD" > '${log}'
cat > /dev/null
echo OK
`);
  await chmod(bin, 0o700);
  const previous = process.env.POLYTH_CLAUDE_BIN;
  process.env.POLYTH_CLAUDE_BIN = bin;
  t.after(() => {
    if (previous === undefined) delete process.env.POLYTH_CLAUDE_BIN;
    else process.env.POLYTH_CLAUDE_BIN = previous;
  });
  return { log, cwd: dir };
}

const host = { pluginId: "backend-claude" } as unknown as Parameters<typeof createClaudeProvider>[0];
const model = { providerID: "anthropic", modelID: "haiku" };

test("an account's request reads only that account's login", async (t) => {
  const { log, cwd } = await fakeClaude(t);
  const provider = createClaudeProvider(host, { id: "work", harnessId: "claude-work", name: "Work", dir: "/accounts/work" });
  const result = await provider.completeUtility!({ cwd, prompt: "Reply with just: OK", model });
  assert.equal(result.text, "OK");
  const seen = JSON.parse(await readFile(log, "utf8")) as { args: string; config: string; cwd: string };
  assert.equal(seen.config, "/accounts/work");
  assert.ok(seen.cwd.endsWith(cwd.split("/").at(-1)!));
  assert.match(seen.args, /-p .*--model haiku .*--no-session-persistence .*--safe-mode .*--tools/);
});

test("the default login stays the default", async (t) => {
  const { log, cwd } = await fakeClaude(t);
  const provider = createClaudeProvider(host);
  await provider.completeUtility!({ cwd, prompt: "Reply with just: OK", model });
  const seen = JSON.parse(await readFile(log, "utf8")) as { config: string };
  assert.equal(seen.config, process.env.CLAUDE_CONFIG_DIR ?? "");
});

test("a request names its model", async (t) => {
  const { cwd } = await fakeClaude(t);
  await assert.rejects(createClaudeProvider(host).completeUtility!({ cwd, prompt: "x" }), { code: "unsupported" });
});
