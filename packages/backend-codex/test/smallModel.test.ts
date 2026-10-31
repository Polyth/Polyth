import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createCodexSmallModelRunner } from "../src/smallModel.ts";

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

test("codex utility completion runs one ephemeral exec and reads the last message", async () => {
  const prompts: string[] = [];
  const argv: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    argv.push(args);
    return fakeChild("feat: add the thing\n", prompts) as never;
  }) as unknown as Parameters<typeof createCodexSmallModelRunner>[0]["spawnProcess"];

  const runner = createCodexSmallModelRunner({ command: "/usr/bin/codex", cwd: "/repo", spawnProcess });
  const result = await runner.complete({
    cwd: "/repo",
    prompt: "describe the change",
    model: { providerID: "openai", modelID: "gpt-5.6-luna" },
  });

  assert.equal(result.text, "feat: add the thing");
  assert.equal(result.transport, "direct");
  assert.equal(argv[0]![0], "exec");
  assert.ok(argv[0]!.includes("--ephemeral"));
  assert.ok(argv[0]!.includes("--skip-git-repo-check"));
  assert.deepEqual(argv[0]!.slice(argv[0]!.indexOf("--sandbox"), argv[0]!.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
  assert.deepEqual(argv[0]!.slice(argv[0]!.indexOf("--model"), argv[0]!.indexOf("--model") + 2), ["--model", "gpt-5.6-luna"]);
  const outputFileIndex = argv[0]!.indexOf("--output-last-message");
  assert.ok(outputFileIndex > 0);
  assert.match(argv[0]![outputFileIndex + 1]!, /last-message\.txt$/);
  assert.equal(argv[0]!.at(-1), "-");
  assert.ok(!argv[0]!.some((arg) => arg.includes("describe the change")));
  assert.equal(prompts[0], "describe the change");
});
