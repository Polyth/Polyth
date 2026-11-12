import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CLAUDE_UTILITY_SYSTEM_PROMPT, createClaudeSmallModelRunner } from "../src/smallModel.ts";

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
    "--system-prompt", CLAUDE_UTILITY_SYSTEM_PROMPT,
    "--tools", "",
  ]);
  // A Windows `.cmd` shim refuses these characters in argv.
  assert.doesNotMatch(CLAUDE_UTILITY_SYSTEM_PROMPT, /["%^&|<>!\r\n]/);
  assert.ok(!argv[0]!.some((arg) => arg.includes("describe the change")));
  assert.ok(prompts[0]!.includes("Be terse."));
  assert.ok(prompts[0]!.includes("describe the change"));
});

test("a refused claude print turn reports the CLI's own reason, not its exit code", async () => {
  // Measured on Claude Code 2.1.318 over its 5-hour limit: the reason is on
  // stdout, stderr is empty, and the process exits with code 1.
  const spawnProcess = (() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { end() {}, once() {} },
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill() {},
    });
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("You've hit your 5-hour limit · resets 2:50pm (Europe/Kyiv)\n"));
      child.exitCode = 1;
      child.emit("close", 1);
    });
    return child as never;
  }) as unknown as Parameters<typeof createClaudeSmallModelRunner>[0]["spawnProcess"];
  const runner = createClaudeSmallModelRunner({ command: "/usr/bin/claude", cwd: "/repo", spawnProcess });
  await assert.rejects(
    () => runner.complete({ cwd: "/repo", prompt: "summarize", model: { providerID: "anthropic", modelID: "opus" } }),
    (error: Error & { code?: string }) => {
      assert.equal(error.message, "You've hit your 5-hour limit · resets 2:50pm (Europe/Kyiv)");
      assert.equal(error.code, "unavailable");
      return true;
    },
  );
});
