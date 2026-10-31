// Moved from packages/server/test/voiceSettings.test.ts: the server voice
// default must keep using dictation's balanced local model id. The host test
// cannot name this removable package, so the cross-package invariant lives
// here.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LOCAL_MODEL_ID } from "../src/index.ts";
import { createVoiceSettings } from "../../server/src/voice.ts";

test("the server voice default uses dictation's balanced local model id", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-voice-default-"));
  try {
    const current = createVoiceSettings({ file: join(root, "voice.json"), env: {} }).get();
    assert.equal(current.dictation.localModel, DEFAULT_LOCAL_MODEL_ID);
    assert.equal(current.dictation.localModel, "nemotron-3.5-streaming-0.6b-560ms");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
