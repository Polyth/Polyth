import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HarnessSnapshot } from "@polyth/contracts";
import { renderCapabilityText } from "../src/capabilityText.ts";
import {
  applyNativeSkillPolicy,
  createFolderSkillManager,
  locateNativeSkill,
  nativeSkillFolders,
  parseSkillFile,
  readNativeSkillPatch,
  readNativeSkillPolicy,
  scanSkillFolder,
  skillDescription,
  skillListField,
  skillTextField,
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

test("a harness default applies only while the Space has not chosen", async () => {
  const root = await mkdtemp(join(tmpdir(), "polyth-skill-default-"));
  try {
    const file = join(root, "policy.json");
    assert.deepEqual(await readNativeSkillPolicy(file, true), { inherit: true, muted: [] }, "no stored choice follows the default");
    await writeFile(join(root, "broken.json"), "{");
    assert.deepEqual(await readNativeSkillPolicy(join(root, "broken.json"), true), { inherit: false, muted: [] }, "unreadable stays the safe default");
    await writeFile(join(root, "muted-only.json"), JSON.stringify({ muted: ["pdf"] }));
    assert.deepEqual(await readNativeSkillPolicy(join(root, "muted-only.json"), true), { inherit: true, muted: ["pdf"] });
    // Muting under the default stores the inherited state, so it survives a later default change.
    await updateNativeSkillPolicy(file, { skill: { name: "pdf", enabled: false } }, true);
    assert.deepEqual(await readNativeSkillPolicy(file, false), { inherit: true, muted: ["pdf"] });
    await updateNativeSkillPolicy(file, { inherit: false }, true);
    assert.deepEqual(await readNativeSkillPolicy(file, true), { inherit: false, muted: ["pdf"] }, "an explicit Off is kept");
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
  ]), { ready: 1, attention: 1, signIn: 1, off: 1, missing: 1, checking: 0, unverified: 0, updates: 0, signInEnding: 0 });
});

test("the Skills section appears only on harnesses that can list native skills", () => {
  const items = [{ id: "harnesses.skills", order: 40, meta: { harnessId: "*", sectionId: "skills", label: "Skills", requires: "native-skills" } }];
  assert.deepEqual(configurationSections(items, "codex", {}), []);
  assert.deepEqual(configurationSections(items, "claude", { nativeSkills: true }).map((section) => section.id), ["skills"]);
});

test("skill front matter reads the YAML real skills use", () => {
  const folded = parseSkillFile("---\nname: a\ndescription: >-\n  Runs over\n  two lines.\nlicense: MIT\n---\n\n# Body\n");
  assert.equal(skillTextField(folded, "description"), "Runs over two lines.");
  assert.equal(skillTextField(folded, "license"), "MIT");
  assert.equal(folded.body, "# Body");
  const literal = parseSkillFile("---\ndescription: |-\n  one\n  two\n---\nB");
  assert.equal(literal.fields.description, "one\ntwo");
  assert.equal(skillTextField(parseSkillFile('---\ndescription: "Use for \\"x\\": y"\n---\nB'), "description"), 'Use for "x": y');
  assert.equal(skillTextField(parseSkillFile("---\ndescription: 'It''s fine'\n---\nB"), "description"), "It's fine");
  assert.equal(skillTextField(parseSkillFile("---\ndescription: Runs on\n  over lines\n---\nB"), "description"), "Runs on over lines");
  assert.equal(skillTextField(parseSkillFile("---\r\ndescription: Windows\r\n---\r\nB"), "description"), "Windows");
  assert.equal(skillTextField(parseSkillFile("\uFEFF---\ndescription: BOM\n---\nB"), "description"), "BOM");
});

test("a skill's tool lists read in every form they are written", () => {
  assert.deepEqual(skillListField(parseSkillFile("---\nallowed-tools: Read, Bash\n---\nB"), "allowed-tools"), ["Read", "Bash"]);
  assert.deepEqual(skillListField(parseSkillFile("---\nallowed-tools: Read Bash\n---\nB"), "allowed-tools"), ["Read", "Bash"]);
  assert.deepEqual(skillListField(parseSkillFile('---\nallowed-tools: ["Read", "Bash"]\n---\nB'), "allowed-tools"), ["Read", "Bash"]);
  assert.deepEqual(skillListField(parseSkillFile("---\nallowed-tools:\n  - Read\n  - Bash\n---\nB"), "allowed-tools"), ["Read", "Bash"]);
  assert.deepEqual(skillListField(parseSkillFile("---\nname: x\n---\nB"), "allowed-tools"), []);
});

test("a malformed or hostile front matter yields fewer fields and never more", () => {
  const none = parseSkillFile("No front matter at all.");
  assert.deepEqual(Object.keys(none.fields), []);
  assert.equal(none.body, "No front matter at all.");
  assert.equal(parseSkillFile("---\nname: open\nnever closed").body, "---\nname: open\nnever closed");
  const hostile = parseSkillFile("---\n__proto__: polluted\nconstructor: x\nmetadata:\n  author: y\n---\nB");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(hostile.fields.metadata, undefined, "a nested map is not read as text");
  assert.equal(Object.getPrototypeOf(hostile.fields), null);
});

test("a listed description is one capped line, block scalars included", () => {
  assert.equal(skillDescription("---\ndescription: >-\n  Folded\n  text\n---\nB"), "Folded text");
  assert.equal(skillDescription(`---\ndescription: ${"x".repeat(400)}\n---\nB`)?.length, 300);
  assert.equal(skillDescription("no front matter"), undefined);
});

const localContext = (cwd: string, over: Record<string, unknown> = {}) => ({
  space: { spaceId: "s", spaceSlug: "s", userId: "u", role: "owner", deployment: "local-trusted", storageDir: cwd },
  spaceId: "s",
  projectId: "p1",
  cwd,
  ...over,
}) as never;

test("a harness that loads its own skills lists them read-only, nearest folder first", async () => {
  const root = await mkdtemp(join(tmpdir(), "polyth-folder-skills-"));
  try {
    const user = join(root, "home", "skills");
    const bundled = join(root, "home", "bundled");
    const project = join(root, "repo");
    const write = async (dir: string, name: string, description: string) => {
      await mkdir(join(dir, name), { recursive: true });
      await writeFile(join(dir, name, "SKILL.md"), `---\ndescription: ${description}\n---\nB`);
    };
    await write(join(project, ".x", "skills"), "shared", "From the project");
    await write(user, "shared", "From the person");
    await write(user, "mine", "Personal");
    await write(bundled, "system", "Ships with it");
    const manager = createFolderSkillManager({
      harnessId: "x",
      harnessName: "X",
      folders: (context) => nativeSkillFolders(context, { project: [join(".x", "skills")], user: [user], bundled: [bundled] }),
    });
    const list = await manager.list(localContext(project));
    assert.equal(list.control, "none");
    assert.equal(list.supported, true);
    assert.deepEqual(list.skills.map((skill) => [skill.name, skill.source, skill.description, skill.enabled, skill.locked]), [
      ["shared", "project", "From the project", true, true],
      ["mine", "user", "Personal", true, true],
      ["system", "bundled", "Ships with it", true, true],
    ]);
    const outside = await manager.list(localContext(project, { projectId: "__default__" }));
    assert.equal(outside.skills.find((skill) => skill.name === "shared")?.source, "user", "no project folder without a project");
    assert.equal(await manager.locate!(localContext(project), "shared"), await realpath(join(project, ".x", "skills", "shared")));
    assert.equal(await manager.locate!(localContext(project), "nope"), undefined);
    assert.equal(await manager.locate!(localContext(project), "plugin:skill"), undefined, "a plugin's skill has no folder here");
    await assert.rejects(manager.update(localContext(project), { inherit: false }), (error: { code?: string }) => error.code === "unsupported");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native skills stay on a local single-user Polyth and a local project", async () => {
  const root = await mkdtemp(join(tmpdir(), "polyth-folder-skills-"));
  try {
    await mkdir(join(root, "mine"), { recursive: true });
    await writeFile(join(root, "mine", "SKILL.md"), "---\ndescription: d\n---\nB");
    const manager = createFolderSkillManager({
      harnessId: "x",
      harnessName: "X",
      folders: () => [{ root, source: "user" }],
    });
    for (const context of [
      localContext(root, { remote: true }),
      localContext(root, { space: { spaceId: "s", deployment: "server-trusted" } }),
      localContext(root, { space: { spaceId: "s", deployment: "multi-tenant-sandboxed" } }),
    ]) {
      const list = await manager.list(context);
      assert.equal(list.supported, false);
      assert.deepEqual(list.skills, []);
      assert.equal(await manager.locate!(context, "mine"), undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a link out of the skills folder is never located", async () => {
  const root = await mkdtemp(join(tmpdir(), "polyth-folder-skills-"));
  try {
    const skills = join(root, "skills");
    const outside = join(root, "outside");
    await mkdir(skills, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "SKILL.md"), "---\ndescription: d\n---\nB");
    await symlink(outside, join(skills, "escape"));
    assert.equal(await locateNativeSkill([{ root: skills, source: "user" }], "escape"), undefined);
    assert.equal(await locateNativeSkill([{ root: skills, source: "user" }], "../outside"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const skillPlan = (extra: Record<string, unknown>) => ({
  harnessId: "h",
  desiredRevision: "r",
  items: [{
    mode: "prompt",
    mutability: "immediate",
    capability: { id: "c", kind: "skill", owner: "commands", scope: "space", revision: "1", name: "pdf", title: "pdf", description: "Work with PDFs.", instructions: "SECRET FULL TEXT", ...extra },
  }],
}) as never;

test("a prompt-delivered skill stored with its files is read on demand", () => {
  const onDemand = renderCapabilityText(skillPlan({ bundleDir: "/store/abc" }))!;
  assert.match(onDemand, /Work with PDFs\./);
  assert.match(onDemand, /read `\/store\/abc\/SKILL\.md`/);
  assert.doesNotMatch(onDemand, /SECRET FULL TEXT/);
  assert.match(renderCapabilityText(skillPlan({}))!, /SECRET FULL TEXT/, "one with no files stays inline");
});
