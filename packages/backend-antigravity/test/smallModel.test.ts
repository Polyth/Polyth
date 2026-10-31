import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createAntigravitySmallModelRunner } from "../src/smallModel.ts";

const fakeChild = (stdout: string) => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter & { resume(): void };
    stdin: { end(value?: string): void; once(event: string, cb: () => void): void };
    exitCode: number | null;
    signalCode: string | null;
    kill(): void;
  };
  child.stdout = new EventEmitter();
  child.stderr = Object.assign(new EventEmitter(), { resume() {} });
  child.stdin = { end() {}, once() {} };
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

test("antigravity utility completion attaches the prompt to --print", async () => {
  const argv: string[][] = [];
  const spawnProcess = ((_command: string, args: string[]) => {
    argv.push(args);
    return fakeChild("feat: add the thing\n") as never;
  }) as unknown as Parameters<typeof createAntigravitySmallModelRunner>[0]["spawnProcess"];

  const runner = createAntigravitySmallModelRunner({ command: "/usr/bin/agy", cwd: "/repo", spawnProcess });
  const result = await runner.complete({
    cwd: "/repo",
    prompt: "describe the change",
    model: { providerID: "antigravity", modelID: "gemini-3.8-flash-low" },
  });

  assert.equal(result.text, "feat: add the thing");
  assert.equal(result.transport, "direct");
  assert.equal(argv[0]![0], "--print=describe the change");
  assert.ok(argv[0]!.includes("--disable-slash-commands"));
  assert.deepEqual(argv[0]!.slice(argv[0]!.indexOf("--model"), argv[0]!.indexOf("--model") + 2), ["--model", "gemini-3.8-flash-low"]);
});
