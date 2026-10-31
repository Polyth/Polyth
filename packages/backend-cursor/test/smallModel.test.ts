import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createCursorSmallModelRunner } from "../src/smallModel.ts";

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

test("cursor utility completion runs the read-only print mode over stdin", async () => {
  const prompts: string[] = [];
  const argv: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    argv.push(args);
    return fakeChild("feat: add the thing\n", prompts) as never;
  }) as unknown as Parameters<typeof createCursorSmallModelRunner>[0]["spawnProcess"];

  const runner = createCursorSmallModelRunner({ command: "/usr/bin/agent", cwd: "/repo", spawnProcess });
  const result = await runner.complete({
    cwd: "/repo",
    prompt: "describe the change",
    model: { providerID: "cursor", modelID: "composer-2.5" },
  });

  assert.equal(result.text, "feat: add the thing");
  assert.equal(result.transport, "direct");
  assert.deepEqual(argv[0], [
    "-p",
    "--mode", "ask",
    "--trust",
    "--output-format", "text",
    "--model", "composer-2.5",
  ]);
  assert.ok(!argv[0]!.some((arg) => arg.includes("describe the change")));
  assert.equal(prompts[0], "describe the change");
});
