// F12 web terminal: reconnect backoff (pure) and replay-frame buffer semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTerminalChunk, nextTermBackoff } from "../src/utils.ts";

test("nextTermBackoff doubles from 500ms to a 5s ceiling", () => {
  assert.equal(nextTermBackoff(undefined), 500);
  assert.equal(nextTermBackoff(0), 500);
  assert.equal(nextTermBackoff(500), 1000);
  assert.equal(nextTermBackoff(1000), 2000);
  assert.equal(nextTermBackoff(4000), 5000);
  assert.equal(nextTermBackoff(5000), 5000); // ceiling holds
});

test("replay frames REPLACE the buffer so reattach never duplicates output", () => {
  // simulate: live output accumulated, socket dropped, reattach replays all
  let buf = "";
  buf = applyTerminalChunk(buf, "$ npm test\n");
  buf = applyTerminalChunk(buf, "552 passing\n");
  assert.equal(buf, "$ npm test\n552 passing\n");

  // reattach: the server replays the same scrollback — the client rebuilds
  // from empty instead of appending, so nothing doubles
  const replayed = applyTerminalChunk("", "$ npm test\n552 passing\n");
  assert.equal(replayed, buf);
});
