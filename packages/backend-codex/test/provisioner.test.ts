import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { HarnessContext, HarnessProvisioningPlan, SpaceContext } from "@polyth/contracts";
import { codexOverlays, createCodexProvisioner } from "../src/provisioner.ts";

const temporaryDirectory = (): string => mkdtempSync(join(tmpdir(), "polyth-codex-capability-"));
const spaceAt = (storageDir: string, spaceId: string): SpaceContext => {
  mkdirSync(storageDir, { recursive: true });
  return {
    spaceId,
    spaceSlug: spaceId,
    userId: "user",
    role: "owner",
    deployment: "local-trusted",
    storageDir,
  };
};
const contextAt = (storageDir: string, spaceId = "space", sessionId = "session"): HarnessContext => ({
  spaceId,
  projectId: "project",
  sessionId,
  cwd: temporaryDirectory(),
  space: spaceAt(storageDir, spaceId),
});
const skillPlan = (desiredRevision: string, instructions = "Use the repository evidence."): HarnessProvisioningPlan => ({
  harnessId: "codex",
  desiredRevision,
  items: [{
    capability: {
      id: "example.docs",
      kind: "skill",
      owner: "example",
      scope: "session",
      revision: `skill-${desiredRevision}`,
      name: "docs",
      title: "Docs",
      description: "Write project documentation",
      instructions,
    },
    mode: "native",
    mutability: "session-create",
  }],
});
const noSecrets = { mcpSecrets: () => ({}) };

test("Codex stages revisioned native skills only in matching Space-private storage", async () => {
  const spaceA = temporaryDirectory();
  const spaceB = temporaryDirectory();
  const contextA = contextAt(spaceA, "a");
  const contextB = { ...contextA, spaceId: "b", space: spaceAt(spaceB, "b") };
  const provisioner = createCodexProvisioner();

  const resultA = await provisioner.apply(contextA, skillPlan("r1"), noSecrets);
  const resultB = await provisioner.apply(contextB, skillPlan("r1"), noSecrets);
  assert.equal((await provisioner.support(contextA)).kinds.skill?.modes[0], "native");
  assert.equal(resultA.records[0]?.status, "pending");
  assert.equal(resultA.records[0]?.mode, "native");
  const overlayA = codexOverlays.peek(contextA, "codex")?.value;
  const overlayB = codexOverlays.peek(contextB, "codex")?.value;
  assert.ok(overlayA?.nativeSkills);
  assert.ok(overlayB?.nativeSkills);
  assert.notEqual(overlayA.nativeSkills.root, overlayB.nativeSkills.root);
  assert.ok(overlayA.nativeSkills.root.startsWith(`${spaceA}/runtime/codex/`));
  assert.ok(overlayB.nativeSkills.root.startsWith(`${spaceB}/runtime/codex/`));
  const skill = overlayA.nativeSkills.skills[0]!;
  assert.equal(skill.name, "docs");
  assert.equal(dirname(dirname(skill.path)), overlayA.nativeSkills.root);
  assert.match(readFileSync(skill.path, "utf8"), /^---\nname: "docs"\n/);
  assert.equal(overlayA.developerInstructions, undefined, "native skill bodies are not duplicated into the prompt");

  provisioner.release?.(contextA);
  assert.equal(existsSync(overlayA.nativeSkills.root), false);
  assert.equal(existsSync(overlayB.nativeSkills.root), true);
});

test("Codex capability revisions are immutable and a mismatched Space context cannot write", async () => {
  const storage = temporaryDirectory();
  const context = contextAt(storage);
  const provisioner = createCodexProvisioner();
  await provisioner.apply(context, skillPlan("same", "First body."), noSecrets);
  const path = codexOverlays.peek(context, "codex")!.value.nativeSkills!.skills[0]!.path;
  const changed = await provisioner.apply(context, skillPlan("same", "Changed without a revision."), noSecrets);
  assert.equal(changed.records[0]?.status, "failed");
  assert.match(readFileSync(path, "utf8"), /First body\./);

  const foreign = { ...context, spaceId: "foreign" };
  const rejected = await provisioner.apply(foreign, skillPlan("foreign"), noSecrets);
  assert.equal(rejected.records[0]?.status, "failed");
  assert.equal(codexOverlays.peek(foreign, "codex")?.value.nativeSkills, undefined);
});

test("Codex refuses a symlinked capability-storage parent", async () => {
  const storage = temporaryDirectory();
  const outside = temporaryDirectory();
  mkdirSync(join(storage, "runtime"));
  symlinkSync(outside, join(storage, "runtime", "codex"));
  const context = contextAt(storage);
  await assert.rejects(
    createCodexProvisioner().apply(context, skillPlan("r1"), noSecrets),
    /non-directory component/,
  );
  assert.equal(codexOverlays.peek(context, "codex"), undefined);
  assert.deepEqual(existsSync(join(outside, "capabilities")), false);
});
