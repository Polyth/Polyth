import { test } from "node:test";
import assert from "node:assert/strict";
import { startPcm16Capture } from "../widgets/audioCapture.ts";

const withNavigator = async (value: unknown, run: () => Promise<void>): Promise<void> => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value });
  try {
    await run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
};

test("microphone permission denial is normalized to mic_denied", async () => {
  await withNavigator({
    mediaDevices: {
      async getUserMedia() {
        const error = new Error("permission denied");
        error.name = "NotAllowedError";
        throw error;
      },
    },
  }, async () => {
    await assert.rejects(
      () => startPcm16Capture({ onChunk() {} }),
      (error: unknown) => (error as { code?: string }).code === "mic_denied",
    );
  });
});

test("missing microphone API is reported as mic_denied", async () => {
  await withNavigator({}, async () => {
    await assert.rejects(
      () => startPcm16Capture({ onChunk() {} }),
      (error: unknown) => (error as { code?: string }).code === "mic_denied",
    );
  });
});
