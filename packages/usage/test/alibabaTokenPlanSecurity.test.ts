import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveAlibabaTokenPlanBinary } from "../src/index.ts";

const runtime = (bin: string) => ({ platform: "linux", env: { PATH: bin } }) as never;

test("Alibaba CLI resolution accepts a real binary outside the project", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-alibaba-token-"));
  try {
    const project = join(root, "project");
    const bin = join(root, "bin");
    mkdirSync(project);
    mkdirSync(bin);
    const binary = join(bin, "bl");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(binary, 0o755);
    assert.equal(resolveAlibabaTokenPlanBinary(runtime(bin), project), binary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Alibaba CLI resolution rejects a symlink that resolves into the project", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-alibaba-token-"));
  try {
    const project = join(root, "project");
    const bin = join(root, "bin");
    mkdirSync(project);
    mkdirSync(bin);
    const payload = join(project, "payload");
    writeFileSync(payload, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(payload, 0o755);
    symlinkSync(payload, join(bin, "bl"));
    assert.equal(resolveAlibabaTokenPlanBinary(runtime(bin), project), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Alibaba CLI resolution rejects a resolved shell launcher", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-alibaba-token-"));
  try {
    const project = join(root, "project");
    const bin = join(root, "bin");
    mkdirSync(project);
    mkdirSync(bin);
    const shell = join(root, "bash");
    writeFileSync(shell, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(shell, 0o755);
    symlinkSync(shell, join(bin, "bl"));
    assert.equal(resolveAlibabaTokenPlanBinary(runtime(bin), project), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
