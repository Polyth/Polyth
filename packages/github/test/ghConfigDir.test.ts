import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("the empty gh config directory is removed when the process exits", () => {
  const entry = join(import.meta.dirname, "../src/index.ts");
  const script = [
    `const { githubCallEnv, withGithubAuth } = await import(${JSON.stringify(entry)});`,
    `const env = await withGithubAuth({ token: "t", host: "github.com" }, async () => githubCallEnv());`,
    `const again = await withGithubAuth({ token: "t", host: "github.com" }, async () => githubCallEnv());`,
    `if (again.GH_CONFIG_DIR !== env.GH_CONFIG_DIR) throw new Error("not reused");`,
    `process.stdout.write(env.GH_CONFIG_DIR);`,
  ].join("\n");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /polyth-gh-/);
  assert.equal(existsSync(result.stdout), false);
});
