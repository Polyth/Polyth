import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskTrackerTaskDto } from "@polyth/contracts";
import { buildTaskWorkPrompt } from "@polyth/task-trackers";

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const runOpenCode = (
  cwd: string,
  model: string,
  prompt: string,
): Promise<ProcessResult> => new Promise((resolve, reject) => {
  const child = spawn("opencode", [
    "run",
    "--pure",
    "--format",
    "json",
    "--model",
    model,
    "--dir",
    cwd,
    "--title",
    `Polyth linked task integration (${model})`,
    prompt,
  ], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString()}`.slice(-2_000_000);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-200_000);
  });
  child.once("error", reject);
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, 120_000);
  child.once("exit", (code) => {
    clearTimeout(timeout);
    resolve({ code, stdout, stderr, timedOut });
  });
});

const linkedTask: TaskTrackerTaskDto = {
  provider: "jira",
  id: "10042",
  key: "POL-42",
  title: "Verify linked task agent handoff",
  description: [
    "This is a read-only integration probe.",
    "Do not inspect or modify files and do not invoke tools.",
    "Reply exactly LINKED_TASK_ACK_POL_42.",
  ].join(" "),
  status: { id: "2", name: "In Progress", category: "in_progress" },
  labels: ["integration"],
  assignees: [],
};

test(
  "OpenCode free models accept a linked Jira task as a real agent session",
  { skip: process.env.POLYTH_REAL_OPENCODE_TASK_TRACKER !== "1" },
  async (t) => {
    const models = (process.env.POLYTH_OPENCODE_FREE_MODELS ?? "opencode/big-pickle")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean);
    assert.ok(models.length > 0, "at least one free model is configured");

    const cwd = await mkdtemp(join(tmpdir(), "polyth-linked-task-"));
    try {
      const prompt = buildTaskWorkPrompt(
        linkedTask,
        "Integration test only: do not modify files or call tools. Reply exactly LINKED_TASK_ACK_POL_42.",
      );
      for (const model of models) {
        await t.test(model, async () => {
          assert.match(model, /^opencode\/.+(?:-free|big-pickle)$/);
          const result = await runOpenCode(cwd, model, prompt);
          assert.equal(result.timedOut, false, `${model} timed out\n${result.stderr}`);
          assert.equal(result.code, 0, `${model} exited ${result.code}\n${result.stderr}`);
          assert.match(
            result.stdout,
            /LINKED_TASK_ACK_POL_42/,
            `${model} did not acknowledge the linked task\n${result.stdout}\n${result.stderr}`,
          );
          assert.match(result.stdout, /"type":"text"/);
        });
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
