import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPiSmallModelRunner } from "../src/smallModel.ts";
import type { SmallModelCompletionRequest } from "@polyth/contracts";

const makeFakeChild = (input: {
  stdout?: string;
  exitCode?: number;
  stderr?: string;
  close?: boolean;
  onPrompt?: (value: string) => void;
}) => {
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
  child.stdin = {
    end(value: string) { input.onPrompt?.(value); },
    once() {},
  };
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => { child.signalCode = "SIGTERM"; };
  setImmediate(() => {
    if (input.stdout) child.stdout.emit("data", Buffer.from(input.stdout));
    if (input.stderr) child.stderr.emit("data", Buffer.from(input.stderr));
    if (input.close === false) return;
    child.exitCode = input.exitCode ?? 0;
    child.emit("close", input.exitCode ?? 0);
  });
  return child;
};

const request = (overrides: Partial<SmallModelCompletionRequest> = {}): SmallModelCompletionRequest => ({
  cwd: "/tmp",
  prompt: "describe the change",
  model: { providerID: "commandcode", modelID: "Qwen/Qwen3.8-27B" },
  ...overrides,
});

test("pi utility completion spawns a sessionless, tool-free print process", async () => {
  const prompts: string[] = [];
  const args: string[][] = [];
  const systemPrompts: string[] = [];
  const fakeSpawn = ((_command: string, argv: string[]) => {
    args.push(argv);
    const flag = argv.indexOf("--system-prompt");
    if (flag >= 0) systemPrompts.push(readFileSync(argv[flag + 1]!, "utf8"));
    return makeFakeChild({ stdout: "  feat: add the thing\n", onPrompt: (value) => prompts.push(value) }) as never;
  }) as unknown as typeof import("node:child_process").spawn;

  const runner = createPiSmallModelRunner({ command: "/usr/bin/pi", cwd: "/repo", spawnProcess: fakeSpawn });
  const result = await runner.complete(request({ systemPrompt: "Be terse." }));

  assert.equal(result.text, "feat: add the thing");
  assert.equal(result.transport, "direct");
  assert.equal(result.providerID, "commandcode");
  assert.equal(result.modelID, "Qwen/Qwen3.8-27B");
  assert.deepEqual(args[0]!.slice(0, 6), ["-p", "--no-session", "--no-tools", "--no-skills", "--no-context-files", "--thinking"]);
  // Pi's default system prompt makes the model a coding agent that explores the
  // project; the utility prompt replaces it, read from a file Pi is pointed at.
  assert.equal(systemPrompts.length, 1);
  assert.match(systemPrompts[0]!, /not a coding agent/);
  assert.match(systemPrompts[0]!, /no tools/);
  assert.ok(!systemPrompts[0]!.includes("describe the change"));
  assert.ok(args[0]!.includes("--provider"));
  assert.ok(args[0]!.includes("commandcode"));
  assert.ok(args[0]!.includes("--model"));
  assert.ok(args[0]!.includes("Qwen/Qwen3.8-27B"));
  // The untrusted prompt must never become a process argument.
  assert.ok(!args[0]!.some((arg) => arg.includes("describe the change")));
  assert.ok(!args[0]!.some((arg) => arg.includes("Be terse.")), "the request's own instructions stay on stdin");
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0]!.includes("Be terse."));
  assert.ok(prompts[0]!.includes("describe the change"));
});

test("pi utility completion strips code fences and surfaces provider failures", async () => {
  const okSpawn = (() => makeFakeChild({ stdout: "```\nfix: bound the output\n```\n" })) as unknown as typeof import("node:child_process").spawn;
  const ok = await createPiSmallModelRunner({ command: "pi", cwd: "/repo", spawnProcess: okSpawn })
    .complete(request());
  assert.equal(ok.text, "fix: bound the output");

  const failSpawn = (() => makeFakeChild({ exitCode: 1, stderr: "provider rejected the request" })) as unknown as typeof import("node:child_process").spawn;
  await assert.rejects(
    createPiSmallModelRunner({ command: "pi", cwd: "/repo", spawnProcess: failSpawn }).complete(request()),
    (error: Error & { code?: string }) => error.code === "unavailable" && /provider rejected/.test(error.message),
  );
});

test("pi utility completion rejects when no model is supplied and honours aborts", async () => {
  const runner = createPiSmallModelRunner({ command: "pi", cwd: "/repo" });
  await assert.rejects(
    runner.complete({ cwd: "/repo", prompt: "hi" }),
    (error: Error & { code?: string }) => error.code === "unsupported",
  );

  const controller = new AbortController();
  const hanging = createPiSmallModelRunner({ command: "pi", cwd: "/repo", spawnProcess: (() => makeFakeChild({ close: false })) as unknown as typeof import("node:child_process").spawn });
  const pending = hanging.complete(request({ signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, (error: Error & { code?: string }) => error.code === "aborted");
});
