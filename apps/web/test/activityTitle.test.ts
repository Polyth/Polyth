import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject } from "@polyth/contracts";
import { activityTitle } from "../src/activityTitle.ts";
import { ensureLocale, setLocale } from "../src/i18n/index.ts";
import type { AssistantMsg, TaskActivityMsg, ToolMsg } from "../src/reduce.ts";

let seq = 0;
const call = (tool: string, input: JsonObject, patch: Partial<ToolMsg> = {}): ToolMsg => {
  const id = `call-${++seq}`;
  return {
    kind: "tool",
    id,
    callId: id,
    eventSeq: seq,
    tool,
    input,
    output: "",
    status: "done",
    time: seq,
    finishTime: seq + 1,
    ...patch,
  } as ToolMsg;
};
const read = (path: string) => call("read", { filePath: path });
const edit = (path: string) => call("edit", { filePath: path, oldString: "a", newString: "b" });
const bash = (command: string) => call("bash", { command });
const task = (taskId: string, action: TaskActivityMsg["action"] = "completed"): TaskActivityMsg => ({
  kind: "task", id: `task-${++seq}`, eventSeq: seq, taskId, text: taskId, action, time: seq,
});
const thought = (reasoning: string, text = ""): AssistantMsg =>
  ({ kind: "assistant", id: `a-${++seq}`, eventSeq: seq, text, reasoning, time: seq } as AssistantMsg);

test("the title names the kinds of action inside, in the order they happened", () => {
  assert.equal(
    activityTitle({ items: [read("src/a.ts"), read("src/b.ts"), edit("src/a.ts"), bash("npm test")] }),
    "Read 2 files, edited 1 file, ran tests",
  );
  assert.equal(
    activityTitle({ items: [bash("ls -la"), bash("git status"), edit("src/a.ts"), edit("src/b.ts")] }),
    "Ran 2 commands, edited 2 files",
  );
});

test("file kinds count distinct paths, other kinds count calls", () => {
  assert.equal(activityTitle({ items: [read("src/a.ts"), read("src/a.ts"), read("src/b.ts")] }), "Read 2 files");
  assert.equal(activityTitle({ items: [call("grep", { pattern: "x" }), call("glob", { pattern: "*.ts" })] }), "Ran 2 searches");
});

test("more than three kinds keep the most significant, still in time order", () => {
  const title = activityTitle({ items: [
    call("webfetch", { url: "https://example.com" }),
    read("src/a.ts"),
    call("grep", { pattern: "x" }),
    edit("src/a.ts"),
    bash("ls"),
  ] });
  assert.equal(title, "Read 1 file, edited 1 file, ran 1 command");
});

test("plan bookkeeping reads as tasks, never as a tool call", () => {
  assert.equal(activityTitle({ items: [
    call("mcp__polyth-agent-tools__polyth_todo", { todos: [] }),
    task("one"),
    task("one", "started"),
    task("two"),
  ] }), "Updated 2 tasks");
});

test("a reasoning-only block and an empty block keep sensible names", () => {
  assert.equal(activityTitle({ items: [thought("Considering the layout")] }), "Reasoning");
  assert.equal(activityTitle({ items: [] }), "Activity");
});

test("other locales join their own fragments and capitalize the first", async () => {
  await ensureLocale("zh-CN");
  await ensureLocale("de");
  try {
    await setLocale("zh-CN");
    assert.equal(activityTitle({ items: [read("a.ts"), edit("a.ts")] }), "读取了 1 个文件，编辑了 1 个文件");
    await setLocale("de");
    assert.equal(activityTitle({ items: [bash("npm test")] }), "Tests ausgeführt");
  } finally {
    await setLocale("en");
  }
});
