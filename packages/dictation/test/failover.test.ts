import { test } from "node:test";
import assert from "node:assert/strict";
import { DictationError } from "../src/providers.ts";
import { createFailoverSttAdapter } from "../src/failover.ts";
import type { SttAdapter, SttStream } from "../src/streaming.ts";

const format = { encoding: "pcm_s16le" as const, sampleRate: 16_000, channels: 1 };
const chunk = (text: string) => new Uint8Array(Buffer.from(text));

function adapter(engine: string, options: {
  failPushAt?: number;
  failFinalize?: boolean;
} = {}): SttAdapter & { streams: Array<{ chunks: string[]; cancelled: boolean }> } {
  const streams: Array<{ chunks: string[]; cancelled: boolean }> = [];
  return {
    engine,
    streams,
    createStream(): SttStream {
      const state = { chunks: [] as string[], cancelled: false };
      streams.push(state);
      return {
        push(pcm) {
          state.chunks.push(Buffer.from(pcm).toString());
          if (options.failPushAt === state.chunks.length) {
            throw new DictationError("network_error", `${engine} disconnected`);
          }
        },
        partial: () => state.chunks.join(" "),
        async finalize() {
          if (options.failFinalize) throw new DictationError("provider_unavailable", `${engine} final failed`);
          return state.chunks.join(" ");
        },
        cancel() { state.cancelled = true; },
      };
    },
  };
}

test("mid-stream primary failure replays the complete bounded prefix once into explicit fallback", async () => {
  const primary = adapter("primary", { failPushAt: 2 });
  const fallback = adapter("fallback");
  const stream = createFailoverSttAdapter(primary, fallback).createStream({ format });

  await stream.push(chunk("one"));
  await stream.push(chunk("two"));
  await stream.push(chunk("three"));

  assert.deepEqual(primary.streams[0]!.chunks, ["one", "two"]);
  assert.equal(primary.streams[0]!.cancelled, true);
  assert.deepEqual(fallback.streams[0]!.chunks, ["one", "two", "three"]);
  assert.equal(stream.partial?.(), "one two three");
  assert.equal(await stream.finalize(), "one two three");
});

test("finalization failure can replay short in-memory audio into fallback", async () => {
  const primary = adapter("primary", { failFinalize: true });
  const fallback = adapter("fallback");
  const stream = createFailoverSttAdapter(primary, fallback).createStream({ format });
  await stream.push(chunk("hello"));
  await stream.push(chunk("world"));
  assert.equal(await stream.finalize(), "hello world");
  assert.deepEqual(fallback.streams[0]!.chunks, ["hello", "world"]);
});

test("non-recoverable primary errors never switch providers", async () => {
  const fallback = adapter("fallback");
  const primary: SttAdapter = {
    engine: "primary",
    createStream: () => ({
      push() { throw new DictationError("invalid_credentials", "bad key"); },
      finalize: async () => "",
    }),
  };
  const stream = createFailoverSttAdapter(primary, fallback).createStream({ format });
  await assert.rejects(
    () => stream.push(chunk("secret")),
    (error: unknown) => (error as { code?: string }).code === "invalid_credentials",
  );
  assert.equal(fallback.streams.length, 0);
});

test("exceeding replay budget keeps primary usable but refuses a lossy later switch", async () => {
  let pushes = 0;
  const primary: SttAdapter = {
    engine: "primary",
    createStream: () => ({
      push() {
        pushes++;
        if (pushes === 2) throw new DictationError("network_error", "late failure");
      },
      finalize: async () => "",
    }),
  };
  const fallback = adapter("fallback");
  const stream = createFailoverSttAdapter(primary, fallback, { maxReplayBytes: 64 * 1024 }).createStream({ format });
  await stream.push(new Uint8Array(64 * 1024));
  await assert.rejects(
    () => stream.push(new Uint8Array(2)),
    (error: unknown) => {
      const e = error as { code?: string; message?: string };
      return e.code === "network_error" && /replay budget was exceeded/.test(e.message ?? "");
    },
  );
  assert.equal(fallback.streams.length, 0);
});
