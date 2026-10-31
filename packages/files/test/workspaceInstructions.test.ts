import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project, RemoteHost } from "@polyth/contracts";
import { createFileService } from "../src/index.ts";
import {
  createWorkspaceInstructionSource,
  WORKSPACE_INSTRUCTIONS_MAX_BYTES,
} from "../src/workspaceInstructions.ts";

const localSource = (project: Project) => createWorkspaceInstructionSource({
  projects: { get: async (id) => id === project.id ? project : undefined },
  localFiles: createFileService(),
});

test("workspace instruction source reads bounded UTF-8 and rejects unsafe local files", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-agents-source-"));
  const outside = mkdtempSync(join(tmpdir(), "polyth-agents-outside-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const project: Project = { id: "p", name: "p", path: root, createdAt: 1 };
  const source = localSource(project);

  assert.equal(await source.read(root, project.id), null);
  writeFileSync(join(root, "AGENTS.md"), "Keep tests causal.\n");
  assert.equal(await source.read(root, project.id), "Keep tests causal.\n");

  writeFileSync(join(root, "AGENTS.md"), Buffer.alloc(WORKSPACE_INSTRUCTIONS_MAX_BYTES + 1, 65));
  await assert.rejects(
    source.read(root, project.id),
    (error: Error & { code?: string }) => error.code === "payload-too-large",
  );

  writeFileSync(join(root, "AGENTS.md"), Buffer.from([0xc3, 0x28]));
  await assert.rejects(
    source.read(root, project.id),
    (error: Error & { code?: string }) => error.code === "invalid-input",
  );

  unlinkSync(join(root, "AGENTS.md"));
  writeFileSync(join(outside, "secret.md"), "outside\n");
  symlinkSync(join(outside, "secret.md"), join(root, "AGENTS.md"));
  await assert.rejects(source.read(root, project.id), /escapes project root/i);
});

const localShellHost = (): RemoteHost => ({
  label: "local-shell-fixture",
  exec: (command) => new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  }),
  start: async () => { throw new Error("not used"); },
  forward: async () => { throw new Error("not used"); },
});

test("remote workspace instruction reads are confined to the execution root", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-agents-remote-"));
  const outside = mkdtempSync(join(tmpdir(), "polyth-agents-remote-outside-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const project: Project = {
    id: "remote",
    name: "remote",
    path: root,
    createdAt: 1,
    remote: { kind: "ssh", connectionId: "ssh-1" },
  };
  const source = createWorkspaceInstructionSource({
    projects: { get: async (id) => id === project.id ? project : undefined },
    localFiles: createFileService(),
    remoteHost: (id) => id === "ssh-1" ? localShellHost() : undefined,
  });

  assert.equal(await source.read(root, project.id), null);
  writeFileSync(join(root, "AGENTS.md"), "Remote policy.\n");
  assert.equal(await source.read(root, project.id), "Remote policy.\n");

  unlinkSync(join(root, "AGENTS.md"));
  writeFileSync(join(outside, "secret.md"), "outside\n");
  symlinkSync(join(outside, "secret.md"), join(root, "AGENTS.md"));
  await assert.rejects(
    source.read(root, project.id),
    (error: Error & { code?: string }) => error.code === "invalid-path",
  );
});
