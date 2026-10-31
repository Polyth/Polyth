import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createClaudeSmallModelRunner } from "../src/smallModel.ts";

const fakeChild = (stdout: string, prompts: string[]) => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter & { resume(): void };
    stdin: { end(value: string): void; once(event: string, cb: () => void): void };
    exitCode: number | null;
    signalCode: string | null;
    kill(): void;
  };
  child.stdout = new EventEmitter();
  child.stderr = Object.assign(new EventEmitter(), { resume() {} });
  child.stdin = { end(value) { prompts.push(value); }, once() {} };
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => { child.signalCode = "SIGTERM"; };
  setImmediate(() => {
    child.stdout.emit("data", Buffer.from(stdout));
    child.exitCode = 0;
    child.emit("close", 0);
  });
  return child;
};

test("claude utility completion runs a sessionless, tool-free print turn", async () => {
  const prompts: string[] = [];
  const argv: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    argv.push(args);
    return fakeChild("fix: bound the output\n", prompts) as never;
  }) as unknown as Parameters<typeof createClaudeSmallModelRunner>[0]["spawnProcess"];

  const runner = createClaudeSmallModelRunner({ command: "/usr/bin/claude", cwd: "/repo", spawnProcess });
  const result = await runner.complete({
    cwd: "/repo",
    prompt: "describe the change",
    systemPrompt: "Be terse.",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
  });

  assert.equal(result.text, "fix: bound the output");
  assert.equal(result.transport, "direct");
  assert.deepEqual(argv[0], [
    "-p",
    "--output-format", "text",
    "--model", "claude-sonnet-4-6",
    "--no-session-persistence",
    "--safe-mode",
    "--tools", "",
  ]);
  assert.ok(!argv[0]!.some((arg) => arg.includes("describe the change")));
  assert.ok(prompts[0]!.includes("Be terse."));
  assert.ok(prompts[0]!.includes("describe the change"));
});
