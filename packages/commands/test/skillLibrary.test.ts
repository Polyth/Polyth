import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test, { after } from "node:test";
import type {
  HarnessCapabilitySupport,
  HarnessProvider,
  HarnessRegistry,
  HarnessRosterItem,
  HarnessSnapshot,
  Project,
  ProjectService,
  SpaceContext,
  SpaceStorage,
  ToolExecutionContext,
} from "@polyth/contracts";
import { createFolderSkillManager, nativeSkillFolders } from "@polyth/harness-runtime/native-skills";
import { buildZip } from "../../plugins/test/zipFixture.ts";
import { createCommandService } from "../src/index.ts";
import { createSkillCatalog } from "../src/skillCatalog.ts";
import { createSkillLibrary } from "../src/skillLibrary.ts";
import { createSkillService } from "../src/skills.ts";
import { createSkillTools, SKILLS_MANAGE_TOOL_NAME, SKILLS_TOOL_NAME } from "../src/skillTools.ts";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-skill-library-"));
  roots.push(dir);
  return dir;
};
const code = (error: unknown) => (error as { code?: string }).code;

const writeSkill = (root: string, name: string, description: string, extra: Record<string, string> = {}) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nInstructions for ${name}.\n`);
  for (const [path, body] of Object.entries(extra)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
};

const support = (harnessId: string, modes: readonly string[], blocked = false): HarnessCapabilitySupport => ({
  harnessId,
  kinds: { skill: { modes: modes as never, mutability: "immediate", remote: false, ...(blocked ? { skillDisallowedTools: true } : {}) } },
});

function makeRig() {
  const base = temp();
  const storageDir = join(base, "spaces", "s1");
  mkdirSync(storageDir, { recursive: true });
  const space: SpaceContext = { spaceId: "s1", spaceSlug: "s1", userId: "u1", role: "owner", deployment: "local-trusted", storageDir };
  const storage = (candidate: SpaceContext): SpaceStorage => ({
    root: candidate.storageDir,
    packageDir(id) {
      const target = join(candidate.storageDir, "packages", id);
      mkdirSync(target, { recursive: true });
      return target;
    },
    path(relative) {
      const target = resolve(candidate.storageDir, relative);
      if (!target.startsWith(candidate.storageDir + sep)) throw Object.assign(new Error("invalid"), { code: "invalid-path" });
      return target;
    },
  });
  const projectDir = join(base, "project");
  mkdirSync(projectDir, { recursive: true });
  const projects = (): ProjectService => ({
    get: async (id: string): Promise<Project | undefined> =>
      id === "p1" ? { id, path: projectDir, name: "P", spaceId: "s1", createdAt: 1 } : undefined,
  } as unknown as ProjectService);
  const skills = createSkillService({
    storage,
    projects,
    allowUserSkills: () => false,
    legacy: createCommandService({ personalDir: () => undefined }),
  });
  const catalog = createSkillCatalog({
    storage,
    skills,
    download: async () => buildZip([{ name: "r-HEAD/README.md", body: "x" }]),
    fetchText: async () => ({ status: 404, body: "", headers: {} }),
  });

  const claudeHome = join(base, "claude-skills");
  const cursorHome = join(base, "cursor-skills");
  const provider = (id: string, name: string, folder: string | undefined, modes: readonly string[], blocked = false): HarnessProvider => ({
    descriptor: { id, name },
    provisioner: { support: () => support(id, modes, blocked) },
    ...(folder ? {
      skills: createFolderSkillManager({
        harnessId: id,
        harnessName: name,
        folders: (context) => nativeSkillFolders(context, { project: [join(`.${id}`, "skills")], user: [folder] }),
      }),
    } : {}),
  } as unknown as HarnessProvider);
  const providers = [
    provider("claude", "Claude Code", claudeHome, ["native"], true),
    provider("cursor", "Cursor", cursorHome, ["prompt"]),
    provider("deepseek", "DeepSeek", undefined, ["prompt"]),
    provider("private", "Someone's account", undefined, ["native"]),
    provider("missing", "Not installed", undefined, ["native"]),
    provider("disabled", "Turned off", undefined, ["native"]),
  ];
  const registry = {
    providers: () => providers,
    get: (id: string) => providers.find((row) => row.descriptor.id === id),
    roster: async () => providers.map((row): HarnessRosterItem => ({
      identity: { id: row.descriptor.id, name: row.descriptor.name, integration: "test" },
      policy: { enabled: row.descriptor.id !== "disabled", priority: 1, autoSelect: true },
    } as HarnessRosterItem)),
    snapshots: async () => providers.map((row) => ({
      identity: { id: row.descriptor.id },
      availability: { state: row.descriptor.id === "missing" ? "not-installed" : "ready" },
    } as unknown as HarnessSnapshot)),
  } as unknown as HarnessRegistry;
  const visible = (candidate: HarnessProvider) => candidate.descriptor.id !== "private";
  const library = createSkillLibrary({ skills, catalog, projects, registry: () => registry });
  return { base, space, skills, catalog, library, claudeHome, cursorHome, projectDir, visible, registry };
}

test("the list shows only harnesses this person added and may see, and how each gets skills", async () => {
  const rig = makeRig();
  const { harnesses } = await rig.library.list(rig.space, "p1", rig.visible);
  assert.deepEqual(harnesses.map((row) => [row.id, row.delivery, row.nativeSkills, row.enforcesBlockedTools]), [
    ["claude", "native", "listed", true],
    ["cursor", "prompt", "listed", false],
    ["deepseek", "prompt", "none", false],
  ]);
});

test("one skill held by several harnesses is one row naming them all", async () => {
  const rig = makeRig();
  writeSkill(rig.claudeHome, "review", "Review a change.");
  writeSkill(rig.cursorHome, "review", "Review a change.");
  writeSkill(rig.cursorHome, "cursor-only", "Only here.");
  const { skills } = await rig.library.list(rig.space, undefined, rig.visible);
  assert.deepEqual(skills.map((row) => [row.name, row.natives.map((native) => native.harnessId)]), [
    ["cursor-only", ["cursor"]],
    ["review", ["claude", "cursor"]],
  ]);
  assert.equal(skills[1]!.description, "Review a change.");
  assert.equal(skills[1]!.natives[0]!.locked, true);
  assert.equal(skills[1]!.natives[0]!.importable, true);
});

test("using a harness's skill everywhere copies all its files, and the harness keeps its own", async () => {
  const rig = makeRig();
  const dir = writeSkill(rig.claudeHome, "pdf", "Work with PDFs.", { "scripts/fill.py": "print(1)\n", "refs/forms.md": "# Forms\n" });
  const adopted = await rig.library.adopt(rig.space, { harnessId: "claude", name: "pdf", scope: "project", projectId: "p1" }, rig.visible);
  assert.equal(adopted.origin?.kind, "harness");
  assert.deepEqual(adopted.bundle?.files, 3);
  const stored = rig.skills.listManaged(rig.space, "p1")[0]!;
  const bundle = rig.skills.bundleDir(rig.space, stored)!;
  assert.equal(readFileSync(join(bundle, "scripts", "fill.py"), "utf8"), "print(1)\n");
  assert.equal(readFileSync(join(dir, "refs", "forms.md"), "utf8"), "# Forms\n", "its folder is untouched");

  const { skills } = await rig.library.list(rig.space, "p1", rig.visible);
  const row = skills.find((entry) => entry.name === "pdf")!;
  assert.ok(row.managed);
  assert.deepEqual(row.natives.map((native) => native.harnessId), ["claude"]);
});

test("a copied skill notices when its harness's folder changes, and can take the change", async () => {
  const rig = makeRig();
  const dir = writeSkill(rig.claudeHome, "pdf", "Work with PDFs.");
  await rig.library.adopt(rig.space, { harnessId: "claude", name: "pdf", scope: "space" }, rig.visible);
  const state = async () => (await rig.library.list(rig.space, undefined, rig.visible)).skills.find((row) => row.name === "pdf")!;
  assert.equal((await state()).updateAvailable, undefined);
  writeFileSync(join(dir, "SKILL.md"), "---\nname: pdf\ndescription: Better.\n---\nNew words.\n");
  assert.equal((await state()).updateAvailable, true);
  const updated = await rig.library.update(rig.space, "space", "pdf", undefined, rig.visible);
  assert.equal(updated.description, "Better.");
  assert.equal(updated.instructions, "New words.");
  assert.equal((await state()).updateAvailable, undefined);
});

test("a harness this person may not see cannot be read or copied from", async () => {
  const rig = makeRig();
  writeSkill(rig.claudeHome, "pdf", "PDFs.");
  await assert.rejects(
    rig.library.adopt(rig.space, { harnessId: "claude", name: "pdf", scope: "space" }, () => false),
    (error) => code(error) === "not-found",
  );
  const { skills, harnesses } = await rig.library.list(rig.space, undefined, () => false);
  assert.deepEqual(harnesses, []);
  assert.deepEqual(skills, []);
});

test("a project from outside this Space looks like one that does not exist", async () => {
  const rig = makeRig();
  await assert.rejects(rig.library.list(rig.space, "foreign", rig.visible), (error) => code(error) === "not-found");
  await assert.rejects(rig.library.detail(rig.space, "foreign", "x", rig.visible), (error) => code(error) === "not-found");
});

test("a shared server never shows the host's own skill folders", async () => {
  const rig = makeRig();
  writeSkill(rig.claudeHome, "host-secret", "From the host's home.");
  const shared: SpaceContext = { ...rig.space, deployment: "server-trusted" };
  const { skills, harnesses } = await rig.library.list(shared, undefined, rig.visible);
  assert.deepEqual(skills, []);
  assert.equal(harnesses.find((row) => row.id === "claude")!.nativeSkills, "none");
  await assert.rejects(
    rig.library.adopt(shared, { harnessId: "claude", name: "host-secret", scope: "space" }, rig.visible),
    (error) => code(error) === "not-found",
  );
});

test("reading a harness's skill stays inside its folder", async () => {
  const rig = makeRig();
  writeSkill(rig.claudeHome, "pdf", "PDFs.", { "notes.md": "ok" });
  writeFileSync(join(rig.claudeHome, "outside.txt"), "not part of the skill");
  const ok = await rig.library.file(rig.space, undefined, "pdf", "notes.md", rig.visible);
  assert.equal(ok.text, "ok");
  await assert.rejects(rig.library.file(rig.space, undefined, "pdf", "../outside.txt", rig.visible), (error) => code(error) === "invalid-path");
  await assert.rejects(rig.library.file(rig.space, undefined, "pdf", "missing.md", rig.visible), (error) => code(error) === "not-found");
});

test("a plugin's skill copies under its plain name and stays one row", async () => {
  const rig = makeRig();
  const pluginRoot = join(rig.base, "plugin-root");
  writeSkill(pluginRoot, "accessibility-review", "Audit accessibility.", { "refs/wcag.md": "# WCAG\n" });
  const claude = rig.registry.get("claude")!;
  claude.skills = {
    list: async () => ({
      harnessId: "claude",
      inherit: true,
      supported: true,
      applies: "next-session",
      checkedAt: 1,
      skills: [
        { name: "design:accessibility-review", description: "Audit accessibility.", source: "plugin", plugin: "design@m", enabled: true },
        { name: "design:unreadable", source: "plugin", plugin: "design@m", enabled: true, noFolder: true },
      ],
    }),
    update: async () => { throw new Error("unused"); },
    locate: async (_context, name) => (name === "design:accessibility-review" ? join(pluginRoot, "accessibility-review") : undefined),
  };
  const before = await rig.library.list(rig.space, undefined, rig.visible, { fresh: true });
  const row = before.skills.find((entry) => entry.name === "design:accessibility-review")!;
  assert.equal(row.title, "Accessibility review");
  assert.equal(row.natives[0]!.importable, true);
  assert.equal(row.natives[0]!.locked, false, "Claude's own skills can be muted");
  assert.equal(before.skills.find((entry) => entry.name === "design:unreadable")!.natives[0]!.importable, false);

  const copied = await rig.library.adopt(rig.space, { harnessId: "claude", name: "design:accessibility-review", scope: "space" }, rig.visible);
  assert.equal(copied.name, "accessibility-review");
  assert.equal(copied.bundle?.files, 2);

  const after = await rig.library.list(rig.space, undefined, rig.visible, { fresh: true });
  assert.deepEqual(after.skills.map((entry) => entry.name).sort(), ["accessibility-review", "design:unreadable"]);
  const merged = after.skills.find((entry) => entry.name === "accessibility-review")!;
  assert.ok(merged.managed);
  assert.deepEqual(merged.natives.map((native) => native.nativeName), ["design:accessibility-review"]);
  // A page opened under the harness's name keeps working after the copy.
  const reopened = await rig.library.detail(rig.space, undefined, "design:accessibility-review", rig.visible);
  assert.equal(reopened.entry.name, "accessibility-review");
  assert.equal((await rig.library.file(rig.space, undefined, "design:accessibility-review", "refs/wcag.md", rig.visible)).text, "# WCAG\n");
});

test("a slow harness answers from memory, and a fresh read sees the change", async () => {
  const rig = makeRig();
  writeSkill(rig.cursorHome, "one", "First.");
  let reads = 0;
  const cursor = rig.registry.get("cursor")!;
  const original = cursor.skills!.list.bind(cursor.skills);
  cursor.skills!.list = async (context) => { reads += 1; return original(context); };
  await rig.library.list(rig.space, undefined, rig.visible);
  assert.equal(reads, 1);
  writeSkill(rig.cursorHome, "two", "Second.");
  const cached = await rig.library.list(rig.space, undefined, rig.visible);
  assert.equal(reads, 1, "a recent answer is reused");
  assert.deepEqual(cached.skills.map((row) => row.name), ["one"]);
  const other = await rig.library.list(rig.space, undefined, rig.visible, { fresh: "claude" });
  assert.equal(reads, 1, "re-reading one harness leaves the others alone");
  assert.deepEqual(other.skills.map((row) => row.name), ["one"]);
  const fresh = await rig.library.list(rig.space, undefined, rig.visible, { fresh: "cursor" });
  assert.equal(reads, 2);
  assert.deepEqual(fresh.skills.map((row) => row.name), ["one", "two"]);
});

test("an unreadable harness does not take the page down with it", async () => {
  const rig = makeRig();
  writeSkill(rig.cursorHome, "fine", "Still here.");
  rig.registry.get("claude")!.skills!.list = async () => { throw new Error("boom"); };
  const { skills, harnesses } = await rig.library.list(rig.space, undefined, rig.visible);
  assert.deepEqual(skills.map((row) => row.name), ["fine"]);
  assert.equal(harnesses.find((row) => row.id === "claude")!.nativeSkills, "none");
});

const tools = (rig: ReturnType<typeof makeRig>, person: SpaceContext | undefined) => {
  const [read, manage] = createSkillTools({
    skills: rig.skills,
    catalog: rig.catalog,
    library: rig.library,
    personSpace: () => person,
    readerSpace: () => rig.space,
    visibleTo: () => rig.visible,
  });
  return { read: read!, manage: manage! };
};
const call: ToolExecutionContext = { sessionId: "chat", projectId: "p1", cwd: "/x", spaceId: "s1", actorUserId: "u1" };

test("any harness can read a skill another harness holds", async () => {
  const rig = makeRig();
  writeSkill(rig.claudeHome, "pdf", "Work with PDFs.", { "refs/forms.md": "# Forms\n" });
  const { read } = tools(rig, rig.space);
  assert.equal(read.descriptor.kind === "tool" && read.descriptor.name, SKILLS_TOOL_NAME);
  assert.equal(read.descriptor.kind === "tool" && read.descriptor.mutating, false);
  const list = await read.execute!({ action: "list" }, call);
  assert.match(list.output, /pdf: Work with PDFs\./);
  assert.match(list.output, /Claude Code \(its own\)/);
  const skill = await read.execute!({ action: "read", name: "pdf" }, call);
  assert.match(skill.output, /Instructions for pdf\./);
  assert.match(skill.output, /refs\/forms\.md/);
  assert.equal((await read.execute!({ action: "read", name: "pdf", path: "refs/forms.md" }, call)).output, "# Forms\n");
  await assert.rejects(read.execute!({ action: "explode" }, call), (error) => code(error) === "invalid-input");
});

test("changing skills from a chat needs a person and goes through approval", async () => {
  const rig = makeRig();
  writeSkill(rig.claudeHome, "pdf", "Work with PDFs.");
  const nobody = tools(rig, undefined);
  assert.equal(nobody.manage.descriptor.kind === "tool" && nobody.manage.descriptor.name, SKILLS_MANAGE_TOOL_NAME);
  assert.equal(nobody.manage.descriptor.kind === "tool" && nobody.manage.descriptor.mutating, true);
  assert.equal(nobody.manage.autoApprove, undefined, "no standing approval");
  await assert.rejects(nobody.manage.execute!({ action: "adopt", harnessId: "claude", name: "pdf" }, call), (error) => code(error) === "forbidden");

  const { manage } = tools(rig, rig.space);
  assert.match((await manage.execute!({ action: "adopt", harnessId: "claude", name: "pdf" }, call)).output, /every harness/);
  assert.equal(rig.skills.listManaged(rig.space, "p1")[0]?.scope, "project");
  assert.match((await manage.execute!({ action: "remove", name: "pdf" }, call)).output, /Removed pdf/);
  await assert.rejects(manage.execute!({ action: "install", id: "x" }, call), /contentHash/);
});

test("a person's role limits what a chat can do on their behalf", async () => {
  const rig = makeRig();
  writeSkill(rig.claudeHome, "pdf", "Work with PDFs.");
  const member: SpaceContext = { ...rig.space, role: "member" };
  const { manage } = tools(rig, member);
  await assert.rejects(
    manage.execute!({ action: "adopt", harnessId: "claude", name: "pdf", scope: "space" }, call),
    (error) => code(error) === "forbidden",
  );
});
