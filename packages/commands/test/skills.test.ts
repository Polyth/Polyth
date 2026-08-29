import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandService } from "@polyth/commands";

test("skills round-trip through an OpenCode project location", async () => {
  const home = mkdtempSync(join(tmpdir(), "polyth-skills-home-"));
  const root = mkdtempSync(join(tmpdir(), "polyth-skills-root-"));
  const service = createCommandService({ home });
  await service.saveSkill(root, "project-opencode", {
    name: "release-check",
    description: "Prepare a release",
    instructions: "Check the version and changelog.",
  });
  assert.deepEqual(await service.listSkills(root), [{
    name: "release-check",
    description: "Prepare a release",
    instructions: "Check the version and changelog.",
    scope: "project-opencode",
  }]);
  assert.equal(await service.removeSkill(root, "project-opencode", "release-check"), true);
  assert.equal((await service.listSkills(root)).length, 0);
});

test("skills reject unsafe names and incomplete instructions", async () => {
  const service = createCommandService({ home: mkdtempSync(join(tmpdir(), "polyth-skills-home-")) });
  const root = mkdtempSync(join(tmpdir(), "polyth-skills-root-"));
  await assert.rejects(() => service.saveSkill(root, "project-opencode", { name: "Bad_Name", description: "x", instructions: "x" }), /lowercase/);
  await assert.rejects(() => service.saveSkill(root, "project-opencode", { name: "valid", description: "x", instructions: "" }), /instructions/);
});

test("skills read folded YAML descriptions written by compatible tools", async () => {
  const home = mkdtempSync(join(tmpdir(), "polyth-skills-home-"));
  const root = mkdtempSync(join(tmpdir(), "polyth-skills-root-"));
  const folder = join(root, ".opencode", "skills", "folded");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), "---\nname: folded\ndescription: >\n  Read a folded description\n  without showing YAML syntax.\n---\n\nUse it.\n");
  const [skill] = await createCommandService({ home }).listSkills(root);
  assert.equal(skill?.description, "Read a folded description without showing YAML syntax.");
});
