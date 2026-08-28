import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FORBIDDEN_PREFIXES = [
  "artifacts/",
  "logs/",
  "scripts/opencode-real-world/",
] as const;

const trackedFiles = (): string[] =>
  execFileSync(
    "git",
    ["-C", REPOSITORY_ROOT, "ls-files", "-z"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);

test("generated validation paths are never committed", () => {
  const violations = trackedFiles().filter((path) =>
    FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix)));
  assert.deepEqual(
    violations,
    [],
    "Validation artifacts, logs, and temporary scripts must stay outside git.",
  );
});
