import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { AgentRuntime, CanonicalTurnRequest } from "@polyth/contracts";
import { PI_CAPABILITIES } from "../src/runtime.ts";
import {
  createPiTitleRunner,
  isExplicitSessionTitle,
  parsePiSessionTitle,
  piTitlePrompt,
  PI_TITLE_MAX_CHARS,
  withPiTitleGeneration,
  type PiTitleRunner,
} from "../src/title.ts";
import type { PiRpc } from "../src/rpc.ts";

const context = {
  spaceId: "space",
  projectId: "project",
  sessionId: "canonical",
  cwd: "/tmp",
} as const;

test("pi title prompt is byte bounded and keeps the untrusted text intact", () => {
  const long = "é".repeat(2_000);
  const prompt = piTitlePrompt(long);
  assert.ok(Buffer.byteLength(prompt, "utf8") <= 960);
  assert.ok(prompt.length > 0);
  assert.equal(piTitlePrompt("  Fix the login race  "), "Fix the login race");
});

test("pi title parser normalizes provider output and bounds the result", () => {
  assert.equal(parsePiSessionTitle("Fix the login race"), "Fix the login race");
  assert.equal(parsePiSessionTitle('  "Fix the login race."\n'), "Fix the login race");
  assert.equal(parsePiSessionTitle("## Fix mobile composer\n\nmore"), "Fix mobile composer");
  assert.equal(parsePiSessionTitle("   \n  "), undefined);
  assert.equal(parsePiSessionTitle("x".repeat(200))?.length, PI_TITLE_MAX_CHARS);
});

test("pi title runner spawns a tool-free throwaway process and pipes the prompt", async () => {
  const prompts: string[] = [];
  const closed: Array<{ args: readonly string[] }> = [];
  const fakeSpawn = ((_command: string, args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { end(value: string): void; once(event: string, cb: () => void): void };
      exitCode: number | null;
      signalCode: string | null;
      kill(): void;
    };
    child.stdout = new EventEmitter();
    child.stderr = Object.assign(new EventEmitter(), { resume() {} });
    child.stdin = { end(value: string) { prompts.push(value); }, once() {} };
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {};
    setImmediate(() => {
      closed.push({ args });
      child.stdout.emit("data", Buffer.from('"Fix the login race"\n'));
      child.exitCode = 0;
      child.emit("close", 0);
    });
    return child as never;
  }) as unknown as typeof import("node:child_process").spawn;

  const runner = createPiTitleRunner({
    command: "/usr/bin/pi",
    cwd: "/tmp",
    spawnProcess: fakeSpawn,
  });
  const title = await runner.generate({
    prompt: "please fix the login race",
    model: { providerID: "opencode", modelID: "kimi-k2.6" },
  });
  assert.equal(title, "Fix the login race");
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0]!.includes("please fix the login race"));
  assert.equal(closed.length, 1);
  assert.ok(closed[0]!.args.includes("--no-session"));
  assert.ok(closed[0]!.args.includes("--no-tools"));
  // Extension discovery must stay enabled: installed extensions can supply the
  // model provider, and `--provider` rejects the session's own model without it.
  assert.ok(!closed[0]!.args.includes("--no-extensions"));
  assert.ok(closed[0]!.args.includes("opencode"));
  assert.ok(closed[0]!.args.includes("kimi-k2.6"));
  // The untrusted prompt must never become a process argument.
  assert.ok(!closed[0]!.args.some((arg) => arg.includes("please fix the login race")));
});

const makeRuntime = () => {
  const listeners = new Set<(sessionId: string, event: { type: string; title?: string }) => void>();
  const runtime = {
    capabilities: async () => PI_CAPABILITIES,
    models: async () => [],
    agents: async () => [],
    ensureSession: async () => "native",
    createSessionOperation: async () => ({ kind: "confirmed", value: { backendSessionId: "native" } }),
    resetSessionOperation: async () => ({ kind: "confirmed", value: { backendSessionId: "native" } }),
    sessions: async () => [],
    history: async () => [],
    startTurn: async () => {},
    startTurnOperation: async () => ({ kind: "confirmed", value: {} }),
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent: (cb: (sessionId: string, event: { type: string; title?: string }) => void) => {
      listeners.add(cb);
      return { dispose: () => { listeners.delete(cb); } };
    },
    dispose: async () => {},
  } as unknown as AgentRuntime;
  return {
    runtime,
    emit(event: { type: string; title?: string }) {
      for (const cb of listeners) cb("canonical", event);
    },
  };
};

const makeRpc = () => {
  const names: string[] = [];
  const rpc = {
    request: async (command: { type: string; name?: string }) => {
      if (command.type === "set_session_name") names.push(String(command.name));
      return undefined;
    },
  } as unknown as PiRpc;
  return { rpc, names };
};

const request = (text: string): CanonicalTurnRequest => ({ sessionId: "canonical", text });

test("explicit title detection distinguishes authored titles from Polyth fallbacks", () => {
  assert.equal(isExplicitSessionTitle("Manual title", "manual", "canonical"), true);
  assert.equal(isExplicitSessionTitle("Native title", "native", "canonical"), true);
  assert.equal(isExplicitSessionTitle("fix pi harness session titles are not being gen…", "polyth", "canonical"), false);
  assert.equal(isExplicitSessionTitle("New session", "placeholder", "canonical"), false);
  assert.equal(isExplicitSessionTitle(undefined, "placeholder", "canonical"), false);
  // Unknown provenance keeps the historical behavior (authored).
  assert.equal(isExplicitSessionTitle("Some title", undefined, "canonical"), true);
});

test("pi title generation refines a Polyth prompt fallback instead of treating it as authored", async () => {
  const { runtime } = makeRuntime();
  const { rpc, names } = makeRpc();
  const generated: string[] = [];
  const wrapped = withPiTitleGeneration(context, rpc, runtime, {
    generate: async ({ prompt }) => {
      generated.push(prompt);
      return "Refine session titles";
    },
  });
  await wrapped.createSessionOperation!({
    projectId: "project",
    sessionId: "canonical",
    title: "fix pi harness session titles are not being gen…",
    titleSource: "polyth",
    cwd: "/tmp",
  }, "op-fallback");
  await wrapped.startTurnOperation!(request("please refine pi session titles"), "turn-fallback");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(generated, ["please refine pi session titles"]);
  assert.deepEqual(names, ["Refine session titles"]);
});

test("pi title generation names a placeholder session once and writes the native name", async () => {
  const { runtime } = makeRuntime();
  const { rpc, names } = makeRpc();
  const generated: string[] = [];
  const runner: PiTitleRunner = {
    generate: async ({ prompt }) => {
      generated.push(prompt);
      return "Fix the login race";
    },
  };
  const wrapped = withPiTitleGeneration(context, rpc, runtime, runner);
  await wrapped.createSessionOperation!(
    { projectId: "project", sessionId: "canonical", title: "New session", cwd: "/tmp" },
    "op-1",
  );
  await wrapped.startTurnOperation!(request("please fix the login race"), "turn-1");
  await new Promise((resolve) => setImmediate(resolve));
  await wrapped.startTurnOperation!(request("and add a test"), "turn-2");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(generated, ["please fix the login race"]);
  assert.deepEqual(names, ["Fix the login race"]);
});

test("pi title generation defers to a native title that already arrived", async () => {
  const { runtime, emit } = makeRuntime();
  const { rpc, names } = makeRpc();
  let calls = 0;
  const wrapped = withPiTitleGeneration(context, rpc, runtime, {
    generate: async () => { calls += 1; return "Generated"; },
  });
  emit({ type: "session/title-generated", title: "Human title" });
  await wrapped.startTurnOperation!(request("do the thing"), "turn-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.deepEqual(names, []);
});

test("pi title generation skips native slash commands and explicit titles", async () => {
  const { runtime } = makeRuntime();
  const { rpc, names } = makeRpc();
  let calls = 0;
  const wrapped = withPiTitleGeneration(context, rpc, runtime, {
    generate: async () => { calls += 1; return "Generated"; },
  });
  await wrapped.startTurnOperation!({
    sessionId: "canonical",
    text: "/review",
    command: { id: "native:pi:review", owner: "native", name: "review" },
  }, "turn-command");
  const manual = withPiTitleGeneration(context, rpc, makeRuntime().runtime, {
    generate: async () => { calls += 1; return "Generated"; },
  });
  await manual.createSessionOperation!(
    { projectId: "project", sessionId: "canonical", title: "Manual title", cwd: "/tmp" },
    "op-manual",
  );
  await manual.startTurnOperation!(request("do the thing"), "turn-manual");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.deepEqual(names, []);
});

test("pi title generation aborts an in-flight runner on dispose", async () => {
  const { runtime } = makeRuntime();
  const { rpc } = makeRpc();
  let aborted = false;
  const runner: PiTitleRunner = {
    generate: ({ signal }) => new Promise((resolve) => {
      signal?.addEventListener("abort", () => { aborted = true; resolve(undefined); }, { once: true });
    }),
  };
  const wrapped = withPiTitleGeneration(context, rpc, runtime, runner);
  await wrapped.startTurnOperation!(request("do the thing"), "turn-1");
  await wrapped.dispose();
  assert.equal(aborted, true);
});
