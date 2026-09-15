import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  commandCodeExecutionModeControl,
  readCommandCodeExecutionMode,
  writeCommandCodeExecutionMode,
} from "../src/executionMode.ts";

test("Command Code execution mode defaults to Follow Polyth and persists Plan project-locally", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-mode-"));
  const file = join(dir, "config", "project.json");
  try {
    assert.equal(await readCommandCodeExecutionMode(file), "follow-polyth");

    assert.equal(await writeCommandCodeExecutionMode(file, "plan"), "plan");
    assert.equal(await readCommandCodeExecutionMode(file), "plan");
    const onDisk = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(onDisk, { version: 1, executionMode: "plan" });

    assert.equal(await writeCommandCodeExecutionMode(file, "follow-polyth"), "follow-polyth");
    assert.equal(await readCommandCodeExecutionMode(file), "follow-polyth");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Command Code execution mode rejects undocumented or bypass permission modes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-commandcode-mode-invalid-"));
  const file = join(dir, "config.json");
  try {
    for (const value of ["default", "yolo", "bypass", "auto-accept", "dont-ask", true, null]) {
      await assert.rejects(
        writeCommandCodeExecutionMode(file, value),
        /Unsupported Command Code execution mode/,
      );
    }
    assert.equal(await readCommandCodeExecutionMode(file), "follow-polyth");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Command Code Plan mode is exposed as a generic next-turn project harness control", () => {
  const follow = commandCodeExecutionModeControl("follow-polyth");
  assert.equal(follow.id, "execution-mode");
  assert.equal(follow.kind, "select");
  assert.equal(follow.scope, "project");
  assert.equal(follow.placement, "harness-settings");
  assert.equal(follow.applySemantics, "next-turn");
  assert.equal(follow.value, "follow-polyth");
  assert.deepEqual(follow.choices?.map((choice) => choice.value), ["follow-polyth", "plan"]);

  const plan = commandCodeExecutionModeControl("plan");
  assert.equal(plan.value, "plan");
  assert.match(plan.description ?? "", /native Plan mode/);
});
