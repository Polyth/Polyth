import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Worker } from "node:worker_threads";
import { createLocalNemotronSttAdapter } from "../src/localNemotron.ts";

class FakeWorker extends EventEmitter {
  readonly messages: Array<Record<string, unknown>> = [];
  terminated = false;
  failPush = false;

  constructor() {
    super();
    queueMicrotask(() => this.emit("message", { type: "ready" }));
  }

  postMessage(message: Record<string, unknown>): void {
    this.messages.push(message);
    const id = message.id as number;
    if (message.op === "push" && this.failPush) {
      queueMicrotask(() => this.emit("error", new Error("native crash")));
      return;
    }
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
