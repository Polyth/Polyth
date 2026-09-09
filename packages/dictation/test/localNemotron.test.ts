import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Worker } from "node:worker_threads";
import { createLocalNemotronSttAdapter } from "../src/localNemotron.ts";

class FakeWorker extends EventEmitter {
  readonly messages: Array<Record<string, unknown>> = [];
  terminated = false;
  failPush = false;
  holdPush = false;

  constructor(ready = true) {
    super();
    if (ready) queueMicrotask(() => this.emit("message", { type: "ready" }));
  }

  postMessage(message: Record<string, unknown>): void {
    this.messages.push(message);
    const id = message.id as number;
    if (message.op === "push" && this.failPush) {
      queueMicrotask(() => this.emit("error", new Error("native crash")));
      return;
    }
    if (message.op === "push" && this.holdPush) return;
    const value = message.op === "push" ? "привіт" : message.op === "final" ? "привіт світ" : "";
    queueMicrotask(() => this.emit("message", { id, ok: true, value }));
  }

  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

const pcm = new Uint8Array([0, 0, 1, 0]);
const format = { encoding: "pcm_s16le" as const, sampleRate: 16_000, channels: 1 };

test("local Nemotron stays behind an injected Worker and normalizes locale language", async () => {
  const workers: FakeWorker[] = [];
  const adapter = createLocalNemotronSttAdapter({
    modelDir: "/models/nemotron",
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  const stream = adapter.createStream({ format, language: "uk-UA" });
  await stream.push(pcm);
  assert.equal(stream.partial?.(), "привіт");
  assert.equal(await stream.finalize(), "привіт світ");
  assert.equal(workers.length, 1);
  const open = workers[0]!.messages.find((message) => message.op === "open");
  assert.equal(open?.language, "uk");
  assert.ok(workers[0]!.messages.some((message) => message.op === "push"));
  assert.ok(workers[0]!.messages.some((message) => message.op === "final"));
});

test("auto language leaves the Nemotron stream unpinned", async () => {
  let worker!: FakeWorker;
  const adapter = createLocalNemotronSttAdapter({
    modelDir: "/models/nemotron",
    workerFactory: () => {
      worker = new FakeWorker();
      return worker as unknown as Worker;
    },
  });
  const stream = adapter.createStream({ format, language: "auto" });
  await stream.push(pcm);
  const open = worker.messages.find((message) => message.op === "open");
  assert.equal(open?.language, undefined);
  await stream.cancel?.();
});

test("worker failure is surfaced as worker_crashed", async () => {
  let worker!: FakeWorker;
  const adapter = createLocalNemotronSttAdapter({
    modelDir: "/models/nemotron",
    workerFactory: () => {
      worker = new FakeWorker();
      worker.failPush = true;
      return worker as unknown as Worker;
    },
  });
  const stream = adapter.createStream({ format });
  await assert.rejects(
    () => stream.push(pcm),
    (error: unknown) => (error as { code?: string }).code === "worker_crashed",
  );
});

test("worker startup has a hard deadline instead of hanging forever", async () => {
  let worker!: FakeWorker;
  const adapter = createLocalNemotronSttAdapter({
    modelDir: "/models/nemotron",
    startupTimeoutMs: 10,
    workerFactory: () => {
      worker = new FakeWorker(false);
      return worker as unknown as Worker;
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
  assert.equal(worker.terminated, true);
});

test("repeated native crashes trip the restart limiter", async () => {
  let created = 0;
  let clock = 1_000;
  const adapter = createLocalNemotronSttAdapter({
    modelDir: "/models/nemotron",
    maxCrashes: 2,
    crashWindowMs: 60_000,
    now: () => clock,
    workerFactory: () => {
      created++;
      const worker = new FakeWorker();
      worker.failPush = true;
      return worker as unknown as Worker;
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
  let worker!: FakeWorker;
  const adapter = createLocalNemotronSttAdapter({
    modelDir: "/models/nemotron",
    workerFactory: () => {
      worker = new FakeWorker(false);
      queueMicrotask(() => worker.emit("exit", 0));
      return worker as unknown as Worker;
    },
  });
  const stream = adapter.createStream({ format });
  await assert.rejects(
    () => stream.push(pcm),
    (error: unknown) => (error as { code?: string }).code === "worker_crashed",
  );
});

test("local Nemotron rejects the wrong audio format before worker startup", () => {
  let created = 0;
  const adapter = createLocalNemotronSttAdapter({
    modelDir: "/models/nemotron",
    workerFactory: () => {
      created++;
      return new FakeWorker() as unknown as Worker;
    },
  });
  assert.throws(
    () => adapter.createStream({ format: { ...format, sampleRate: 48_000 } }),
    (error: unknown) => (error as { code?: string }).code === "audio_format_error",
  );
  assert.equal(created, 0);
});

test("dispose terminates the worker, rejects pending RPC and prevents restart", async () => {
  let worker!: FakeWorker;
  const adapter = createLocalNemotronSttAdapter({
    modelDir: "/models/nemotron",
    workerFactory: () => {
      worker = new FakeWorker();
      worker.holdPush = true;
      return worker as unknown as Worker;
    },
  });
  const stream = adapter.createStream({ format });
  // Let the open RPC complete before starting a deliberately stuck decode.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const pushing = stream.push(pcm);
  await new Promise<void>((resolve) => setImmediate(resolve));
  adapter.dispose();
  await assert.rejects(
    () => pushing,
    (error: unknown) => (error as { code?: string }).code === "session_expired",
  );
  assert.equal(worker.terminated, true);
  assert.throws(
    () => adapter.createStream({ format }),
    (error: unknown) => (error as { code?: string }).code === "session_expired",
  );
});
