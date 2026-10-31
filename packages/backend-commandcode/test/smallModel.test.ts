import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createCommandCodeSmallModelRunner } from "../src/smallModel.ts";

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

test("command code utility completion runs a headless, sessionless print turn", async () => {
  const prompts: string[] = [];
  const argv: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    argv.push(args);
    return fakeChild("feat: add the thing\n", prompts) as never;
  }) as unknown as Parameters<typeof createCommandCodeSmallModelRunner>[0]["spawnProcess"];

  const runner = createCommandCodeSmallModelRunner({ command: "/usr/bin/command-code", cwd: "/repo", spawnProcess });
  const result = await runner.complete({
    cwd: "/repo",
    prompt: "describe the change",
    model: { providerID: "commandcode", modelID: "deepseek/deepseek-v4-flash" },
  });

  assert.equal(result.text, "feat: add the thing");
  assert.equal(result.transport, "direct");
  assert.deepEqual(argv[0], [
    "-p",
    "--no-session",
    "--skip-onboarding",
    "--no-auto-update",
    "--max-turns", "1",
    "--output-format", "text",
    "--model", "deepseek/deepseek-v4-flash",
  ]);
  assert.ok(!argv[0]!.some((arg) => arg.includes("describe the change")));
  assert.equal(prompts[0], "describe the change");
});
