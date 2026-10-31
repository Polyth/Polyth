import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { HarnessContext, HarnessProvisioningPlan } from "@polyth/contracts";
import { claudeOverlays, createClaudeProvisioner } from "../src/provisioner.ts";

const temporary = () => mkdtempSync(join(tmpdir(), "polyth-claude-skills-"));
const contextFor = (storageDir: string, spaceId = "space-a"): HarnessContext => ({
  spaceId,
  projectId: "project-a",
  cwd: "/projects/a",
  sessionId: "session-a",
  space: {
    spaceId,
    spaceSlug: spaceId,
    userId: "user-a",
    role: "owner",
    deployment: "local-trusted",
    storageDir,
  },
});
const planFor = (revision: string, instructions = "Inspect the requested change."): HarnessProvisioningPlan => ({
  harnessId: "claude",
  desiredRevision: revision,
  items: [{
    capability: {
      id: "fixture.review",
      owner: "fixture",
      scope: "project",
      revision,
      kind: "skill",
      name: "review",
      title: "Review",
      description: "Review a change.",
      instructions,
    },
    mode: "filesystem",
    mutability: "session-create",
  }],
});
const secrets = { mcpSecrets: () => ({}) };
const rootFor = (context: HarnessContext) => join(context.space!.storageDir, "packages", "backend-claude");

test("Claude preserves global then harness-specific instructions in the native system prompt overlay", async (t) => {
  const storageDir = temporary();
  t.after(() => rmSync(storageDir, { recursive: true, force: true }));
  const context = contextFor(storageDir);
  const provisioner = createClaudeProvisioner({ storageRoot: rootFor });
  const support = await provisioner.support(context);
  assert.deepEqual(support.kinds.instruction?.modes, ["native"]);
  const plan: HarnessProvisioningPlan = {
    harnessId: "claude",
    desiredRevision: "claude-system-r1",
    items: [
      {
        capability: {
          id: "polyth.behavior",
          kind: "instruction",
          owner: "polyth",
          scope: "deployment",
          revision: "global-r1",
          text: "Global behavior.",
        },
        mode: "native",
        mutability: "session-create",
      },
      {
        capability: {
          id: "harness-runtime.system-prompt.claude",
          kind: "instruction",
          owner: "harness-runtime",
          scope: "space",
          spaceId: context.spaceId,
          revision: "claude-r1",
          text: "Claude-only behavior.",
        },
        mode: "native",
        mutability: "session-create",
      },
    ],
  };
  const result = await provisioner.apply(context, plan, secrets);
  assert.ok(result.records.every((row) => row.status === "pending"));
  assert.equal(
    claudeOverlays.peek(context, "claude")?.value.append,
    "Global behavior.\n\nClaude-only behavior.",
  );
  provisioner.release?.(context);
});

test("Claude materializes immutable revisioned local plugins and prunes only released revisions", async (t) => {
  const storageDir = temporary();
  t.after(() => rmSync(storageDir, { recursive: true, force: true }));
  const context = contextFor(storageDir);
  const provisioner = createClaudeProvisioner({ storageRoot: rootFor });
  const first = planFor("revision-one");
  if (first.items[0]?.capability.kind === "skill") {
    first.items[0].capability.disallowedTools = ["Bash", "Edit"];
  }
  first.keepRevisions = [first.desiredRevision];
  const firstResult = await provisioner.apply(context, first, secrets);
  assert.equal(firstResult.records[0]?.status, "pending");
  const firstOverlay = claudeOverlays.peek(context, "claude")!.value;
  assert.equal(firstOverlay.plugins?.length, 1);
  assert.equal(firstOverlay.skills?.length, 1);
  assert.match(firstOverlay.skills![0]!, /^polyth-[a-f0-9]{16}:review-[a-f0-9]{10}$/);
  assert.equal(firstOverlay.verification?.skills[0]?.name, "review");
  const firstPlugin = firstOverlay.plugins![0]!.path;
  const manifest = JSON.parse(readFileSync(join(firstPlugin, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(`${manifest.name}:${readdirSync(join(firstPlugin, "skills"))[0]}`, firstOverlay.skills![0]);
  const firstSkillDocument = readFileSync(join(firstPlugin, "skills", readdirSync(join(firstPlugin, "skills"))[0]!, "SKILL.md"), "utf8");
  assert.match(firstSkillDocument, /Inspect the requested change\./);
  assert.match(firstSkillDocument, /disallowed-tools: \["Bash","Edit"\]/);

  const second = planFor("revision-two", "Inspect the successor change.");
  second.keepRevisions = [first.desiredRevision, second.desiredRevision];
  await provisioner.apply(context, second, secrets);
  const secondPlugin = claudeOverlays.peek(context, "claude")!.value.plugins![0]!.path;
  assert.notEqual(secondPlugin, firstPlugin);
  assert.equal(readdirSync(dirname(dirname(firstPlugin))).length, 2);

  provisioner.release?.(context, { keepRevisions: [second.desiredRevision] });
  assert.throws(() => readFileSync(join(firstPlugin, ".claude-plugin", "plugin.json")));
  assert.match(readFileSync(join(secondPlugin, ".claude-plugin", "plugin.json"), "utf8"), /polyth-/);
  provisioner.release?.(context, { keepRevisions: [] });
  assert.throws(() => readFileSync(join(secondPlugin, ".claude-plugin", "plugin.json")));
});

test("Claude refuses same-revision mutation and a symlinked Space-private path", async (t) => {
  const storageDir = temporary();
  t.after(() => rmSync(storageDir, { recursive: true, force: true }));
  const context = contextFor(storageDir);
  const provisioner = createClaudeProvisioner({ storageRoot: rootFor });
  await provisioner.apply(context, planFor("immutable"), secrets);
  const plugin = claudeOverlays.peek(context, "claude")!.value.plugins![0]!.path;
  const skillPath = join(plugin, "skills", readdirSync(join(plugin, "skills"))[0]!, "SKILL.md");
  writeFileSync(skillPath, "changed outside Polyth\n");
  const repeated = await provisioner.apply(context, planFor("immutable"), secrets);
  assert.equal(repeated.records[0]?.status, "failed");
  assert.match(repeated.records[0]?.reason ?? "", /not immutable/);

  const otherStorage = temporary();
  t.after(() => rmSync(otherStorage, { recursive: true, force: true }));
  const foreign = join(otherStorage, "foreign");
  mkdirSync(foreign);
  symlinkSync(foreign, join(otherStorage, "packages"));
  const blocked = await createClaudeProvisioner({ storageRoot: rootFor }).apply(
    contextFor(otherStorage), planFor("symlink"), secrets,
  );
  assert.equal(blocked.records[0]?.status, "failed");
  assert.deepEqual(readdirSync(foreign), []);
});

test("Claude plugin paths and canonical names stay isolated between Spaces", async (t) => {
  const rootA = temporary();
  const rootB = temporary();
  t.after(() => { rmSync(rootA, { recursive: true, force: true }); rmSync(rootB, { recursive: true, force: true }); });
  const contextA = contextFor(rootA, "space-a");
  const contextB = contextFor(rootB, "space-b");
  const provisioner = createClaudeProvisioner({ storageRoot: rootFor });
  await provisioner.apply(contextA, planFor("same-revision"), secrets);
  await provisioner.apply(contextB, planFor("same-revision"), secrets);
  const overlayA = claudeOverlays.peek(contextA, "claude")!.value;
  const overlayB = claudeOverlays.peek(contextB, "claude")!.value;
  assert.notEqual(overlayA.plugins![0]!.path, overlayB.plugins![0]!.path);
  assert.notEqual(overlayA.skills![0], overlayB.skills![0]);
  const mismatched = await provisioner.apply({ ...contextA, spaceId: "space-b" }, planFor("mismatch"), secrets);
  assert.equal(mismatched.records[0]?.status, "failed");
});
