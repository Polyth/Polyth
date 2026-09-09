import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createLocalNemotronSttAdapter } from "../src/localNemotron.ts";

class FakeProcess extends EventEmitter {
  readonly messages: Array<Record<string, unknown>> = [];
  connected = true;
  killed = false;
  failPush = false;
  holdPush = false;
  neverReady = false;

  send(message: Record<string, unknown>, callback?: (error: Error | null) => void): boolean {
    this.messages.push(message);
    callback?.(null);
    if (message.type === "init") {
      if (!this.neverReady) queueMicrotask(() => this.emit("message", { type: "ready" }));
      return true;
    }
    const id = message.id as number;
    if (message.op === "push" && this.failPush) {
      queueMicrotask(() => this.emit("exit", 134, "SIGABRT"));
      return true;
    }
    if (message.op === "push" && this.holdPush) return true;
    const value = message.op === "ping" ? "ok"
      : message.op === "push" ? "привіт"
        : message.op === "final" ? "привіт світ" : "";
    queueMicrotask(() => this.emit("message", { id, ok: true, value }));
    return true;
  }

  disconnect(): void {
    this.connected = false;
  }

  kill(): boolean {
    this.killed = true;
    this.connected = false;
    return true;
  }
}

const pcm = new Uint8Array([0, 0, 1, 0]);
const format = { encoding: "pcm_s16le" as const, sampleRate: 16_000, channels: 1 };

test("local Nemotron stays behind an injected child process and normalizes locale language", async () => {
  const processes: FakeProcess[] = [];
  const adapter = createLocalNemotronSttAdapter({
    modelDir: "/models/nemotron",
    processFactory: () => {
      const child = new FakeProcess();
      processes.push(child);
      return child as unknown as ChildProcess;
    },
  });
  const stream = adapter.createStream({ format, language: "uk-UA" });
  await stream.push(pcm);
  assert.equal(stream.partial?.(), "привіт");
  assert.equal(await stream.finalize(), "привіт світ");
  assert.equal(processes.length, 1);
  const open = processes[0]!.messages.find((message) => message.op === "open");
  assert.equal(open?.language, "uk");
  assert.ok(processes[0]!.messages.some((message) => message.op === "push"));
  assert.ok(processes[0]!.messages.some((message) => message.op === "final"));
});

test("health probe uses isolated process IPC", async () => {
  const adapter = createLocalNemotronSttAdapter({
    modelDir: "/models/nemotron",
    processFactory: () => new FakeProcess() as unknown as ChildProcess,
  });
  assert.equal(await adapter.health(), true);
  adapter.dispose();
});

test("auto language leaves the Nemotron stream unpinned", async () => {
  let child!: FakeProcess;
  const adapter = createLocalNemotronSttAdapter({
    modelDir: "/models/nemotron",
    processFactory: () => {
      child = new FakeProcess();
      return child as unknown as ChildProcess;
    },
  });
  const stream = adapter.createStream({ format, language: "auto" });
  await stream.push(pcm);
  const open = child.messages.find((message) => message.op === "open");
  assert.equal(open?.language, undefined);
  await stream.cancel?.();
});

test("native process failure is surfaced as worker_crashed without sharing the server process", async () => {
  let child!: FakeProcess;
  const adapter = createLocalNemotronSttAdapter({
    modelDir: "/models/nemotron",
    processFactory: () => {
      child = new FakeProcess();
      child.failPush = true;
      return child as unknown as ChildProcess;
    },
  });
  const stream = adapter.createStream({ format });
  await assert.rejects(
    () => stream.push(pcm),
    (error: unknown) => (error as { code?: string }).code === "worker_crashed",
  );
});

test("process startup has a hard deadline instead of hanging forever", async () => {
  let child!: FakeProcess;
  const adapter = createLocalNemotronSttAdapter({
    modelDir: "/models/nemotron",
    startupTimeoutMs: 10,
    processFactory: () => {
      child = new FakeProcess();
      child.neverReady = true;
      return child as unknown as ChildProcess;
    },
  });
  const stream = adapter.createStream({ format });
  await assert.rejects(
    () => stream.push(pcm),
    (error: unknown) => {
      const e = error as { code?: string; message?: string };
      return e.code === "worker_crashed" && /did not become ready/.test(e.message ?? "");
    },
  );
  assert.equal(child.killed, true);
});

test("a wedged native decode is killed at the RPC deadline", async () => {
  let child!: FakeProcess;
  const adapter = createLocalNemotronSttAdapter({
    modelDir: "/models/nemotron",
    rpcTimeoutMs: 100,
    processFactory: () => {
      child = new FakeProcess();
      child.holdPush = true;
      return child as unknown as ChildProcess;
    },
  });
  const stream = adapter.createStream({ format });
  await assert.rejects(
    () => stream.push(pcm),
    (error: unknown) => (error as { code?: string }).code === "worker_crashed",
  );
  assert.equal(child.killed, true);
});

test("repeated native crashes trip the restart limiter", async () => {
  let created = 0;
  let clock = 1_000;
  const adapter = createLocalNemotronSttAdapter({
    modelDir: "/models/nemotron",
    maxCrashes: 2,
    crashWindowMs: 60_000,
    now: () => clock,
    processFactory: () => {
      created++;
      const child = new FakeProcess();
      child.failPush = true;
      return child as unknown as ChildProcess;
    },
  });

  for (let i = 0; i < 2; i++) {
    const stream = adapter.createStream({ format });
    await assert.rejects(
      () => stream.push(pcm),
      (error: unknown) => (error as { code?: string }).code === "worker_crashed",
    );
    clock += 10;
  }

  const blocked = adapter.createStream({ format });
  await assert.rejects(
    () => blocked.push(pcm),
    (error: unknown) => {
      const e = error as { code?: string; message?: string };
      return e.code === "worker_crashed" && /crash loop/.test(e.message ?? "");
    },
  );
  assert.equal(created, 2);
});

test("an unexpected clean exit still rejects startup as worker_crashed", async () => {
  let child!: FakeProcess;
  const adapter = createLocalNemotronSttAdapter({
    modelDir: "/models/nemotron",
    processFactory: () => {
      child = new FakeProcess();
      child.neverReady = true;
      queueMicrotask(() => child.emit("exit", 0, null));
      return child as unknown as ChildProcess;
    },
  });
  const stream = adapter.createStream({ format });
  await assert.rejects(
    () => stream.push(pcm),
    (error: unknown) => (error as { code?: string }).code === "worker_crashed",
  );
});

test("local Nemotron rejects the wrong audio format before process startup", () => {
  let created = 0;
  const adapter = createLocalNemotronSttAdapter({
    modelDir: "/models/nemotron",
    processFactory: () => {
      created++;
      return new FakeProcess() as unknown as ChildProcess;
    },
  });
  assert.throws(
    () => adapter.createStream({ format: { ...format, sampleRate: 48_000 } }),
    (error: unknown) => (error as { code?: string }).code === "audio_format_error",
  );
  assert.equal(created, 0);
});

test("dispose terminates the process, rejects pending RPC and prevents restart", async () => {
  let child!: FakeProcess;
  const adapter = createLocalNemotronSttAdapter({
    modelDir: "/models/nemotron",
    processFactory: () => {
      child = new FakeProcess();
      child.holdPush = true;
      return child as unknown as ChildProcess;
    },
  });
  const stream = adapter.createStream({ format });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const pushing = stream.push(pcm);
  await new Promise<void>((resolve) => setImmediate(resolve));
  adapter.dispose();
  await assert.rejects(
    () => pushing,
    (error: unknown) => (error as { code?: string }).code === "session_expired",
  );
  assert.equal(child.killed, true);
  assert.throws(
    () => adapter.createStream({ format }),
    (error: unknown) => (error as { code?: string }).code === "session_expired",
  );
});
