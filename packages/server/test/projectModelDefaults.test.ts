import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProjectPatch } from "@polyth/contracts";
import { createProjectService } from "../src/projects.ts";

const wirePatch = (defaults: Record<string, unknown>): ProjectPatch =>
  ({ defaults } as unknown as ProjectPatch);

test("harness-qualified project models persist as canonical model plus harness", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-project-model-defaults-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const projects = createProjectService(join(root, "data"));
  const project = await projects.add(workspace, "Project");

  const updated = await projects.update(project.id, wirePatch({
    rememberModelSelection: true,
    model: {
      harnessId: "cursor",
      providerID: "shared",
      modelID: "same",
    },
  }));

  assert.deepEqual(updated.defaults, {
    rememberModelSelection: true,
    model: { providerID: "shared", modelID: "same" },
    harness: { mode: "pinned", harnessId: "cursor" },
  });
});

test("an explicit harness selection wins over a model catalog identity", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-project-model-explicit-harness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const projects = createProjectService(join(root, "data"));
  const project = await projects.add(workspace, "Project");

  const updated = await projects.update(project.id, wirePatch({
    model: {
      harnessId: "cursor",
      providerID: "shared",
      modelID: "same",
    },
    harness: { mode: "auto" },
  }));

  assert.deepEqual(updated.defaults, {
    model: { providerID: "shared", modelID: "same" },
    harness: { mode: "auto" },
  });
});

test("invalid hidden harness ids are rejected instead of persisted", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "polyth-project-model-invalid-harness-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const projects = createProjectService(join(root, "data"));
  const project = await projects.add(workspace, "Project");

  await assert.rejects(
    projects.update(project.id, wirePatch({
      model: {
        harnessId: "../cursor",
        providerID: "shared",
        modelID: "same",
      },
    })),
    /defaults\.model\.harnessId must be a valid harness id/,
  );
});
