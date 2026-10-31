import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HarnessSnapshot } from "@polyth/contracts";
import {
  applyNativeSkillPolicy,
  readNativeSkillPatch,
  readNativeSkillPolicy,
  scanSkillFolder,
  skillDescription,
  updateNativeSkillPolicy,
} from "../src/nativeSkills.ts";
import { configurationSections, harnessSummary, setupStep, statusTone } from "../widgets/presentation.ts";

test("native skill patches accept only a boolean inherit or one named skill toggle", () => {
  assert.deepEqual(readNativeSkillPatch({ inherit: true }), { inherit: true });
  assert.deepEqual(readNativeSkillPatch({ skill: { name: "tools:lint", enabled: false } }), { skill: { name: "tools:lint", enabled: false } });
  assert.throws(() => readNativeSkillPatch({}), /Nothing to change/);
  assert.throws(() => readNativeSkillPatch({ inherit: "yes" }), /true or false/);
  assert.throws(() => readNativeSkillPatch({ skill: { name: "../escape", enabled: true } }), /unsupported characters/);
  assert.throws(() => readNativeSkillPatch({ skill: { name: "pdf" } }), /skill.enabled/);
});

test("the stored policy defaults to inheriting nothing and keeps a sorted mute list", async () => {
  const root = await mkdtemp(join(tmpdir(), "polyth-skill-policy-"));
  try {
    const file = join(root, "nested", "policy.json");
    assert.deepEqual(await readNativeSkillPolicy(file), { inherit: false, muted: [] });
    await writeFile(join(root, "broken.json"), "{");
    assert.deepEqual(await readNativeSkillPolicy(join(root, "broken.json")), { inherit: false, muted: [] }, "unreadable means safe default");
    await updateNativeSkillPolicy(file, { inherit: true });
    await updateNativeSkillPolicy(file, { skill: { name: "zeta", enabled: false } });
    await updateNativeSkillPolicy(file, { skill: { name: "alpha", enabled: false } });
    await updateNativeSkillPolicy(file, { skill: { name: "zeta", enabled: true } });
    assert.deepEqual(await readNativeSkillPolicy(file), { inherit: true, muted: ["alpha"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill folders are scanned with descriptions and without following escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "polyth-skill-scan-"));
  try {
    const skills = join(root, "skills");
    await mkdir(join(skills, "pdf"), { recursive: true });
    await writeFile(join(skills, "pdf", "SKILL.md"), "---\nname: pdf\ndescription: 'Read PDF files'\n---\n");
    await mkdir(join(skills, "empty"), { recursive: true });
    await mkdir(join(root, "outside", "evil"), { recursive: true });
    await writeFile(join(root, "outside", "evil", "SKILL.md"), "---\ndescription: nope\n---\n");
    await symlink(join(root, "outside", "evil"), join(skills, "evil"));
    const found = await scanSkillFolder(skills, "user");
    assert.deepEqual(found, [{ name: "pdf", source: "user", description: "Read PDF files" }]);
    assert.deepEqual(await scanSkillFolder(join(root, "missing"), "user"), []);
    assert.equal(skillDescription("no front matter"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a policy enables discovered skills only when inherited, earlier sources winning a name", () => {
  const discovered = [
    { name: "deploy", source: "project" as const },
    { name: "deploy", source: "user" as const },
    { name: "pdf", source: "user" as const },
  ];
  assert.deepEqual(applyNativeSkillPolicy(discovered, { inherit: false, muted: [] }).map((skill) => [skill.name, skill.source, skill.enabled]),
    [["deploy", "project", false], ["pdf", "user", false]]);
  assert.deepEqual(applyNativeSkillPolicy(discovered, { inherit: true, muted: ["pdf"] }).map((skill) => [skill.name, skill.enabled]),
    [["deploy", true], ["pdf", false]]);
});

const snapshot = (availability: Partial<HarnessSnapshot["availability"]>, setup?: HarnessSnapshot["setup"], enabled = true): HarnessSnapshot => ({
  identity: { id: "codex", name: "Codex", integration: "x" },
  policy: { enabled, priority: 0, autoSelect: true },
  availability: { harnessId: "codex", state: "ready", installed: true, healthy: true, authenticated: true, checkedAt: 1, ...availability },
  context: { spaceId: "s", projectId: "p", cwd: "/", revision: "r", fetchedAt: 1 },
  ...(setup ? { setup } : {}),
});

test("setup steps lead with install or sign-in and keep re-sign-in for ready harnesses", () => {
  const setup = { installCommand: "npm i -g codex", signInCommand: "codex login", setupUrl: "https://x.test" };
  assert.deepEqual(setupStep(snapshot({ state: "not-installed", installed: false }, setup)), { kind: "install", command: "npm i -g codex" });
  assert.deepEqual(setupStep(snapshot({ state: "not-installed", installed: false }, { setupUrl: "https://x.test" })), { kind: "guide", url: "https://x.test" });
  assert.deepEqual(setupStep(snapshot({ state: "auth-required", authenticated: false }, setup)), { kind: "sign-in", command: "codex login" });
  assert.deepEqual(setupStep(snapshot({}, setup)), { kind: "sign-in-again", command: "codex login" });
  assert.deepEqual(setupStep(snapshot({})), { kind: "none" });
  assert.equal(statusTone(snapshot({ state: "auth-required" })), "warning");
  assert.equal(statusTone(snapshot({ state: "offline" })), "danger");
  assert.deepEqual(harnessSummary([
    snapshot({}), snapshot({ state: "auth-required" }), snapshot({ state: "not-installed", installed: false }), snapshot({}, undefined, false),
  ]), { ready: 1, attention: 1, signIn: 1, off: 1, missing: 1, checking: 0, unverified: 0, updates: 0 });
});

test("the Skills section appears only on harnesses that can list native skills", () => {
  const items = [{ id: "harnesses.skills", order: 40, meta: { harnessId: "*", sectionId: "skills", label: "Skills", requires: "native-skills" } }];
  assert.deepEqual(configurationSections(items, "codex", {}), []);
  assert.deepEqual(configurationSections(items, "claude", { nativeSkills: true }).map((section) => section.id), ["skills"]);
});
