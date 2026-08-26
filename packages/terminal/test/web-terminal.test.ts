// F12 web terminal: reconnect backoff (pure) and replay-frame semantics on
// the emulator — a replay REPLACES state so reattach never duplicates output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextTermBackoff } from "../../../apps/web/src/utils.ts";
import { createTerminalEmulator } from "../widgets/terminal/emulator.ts";

test("nextTermBackoff doubles from 500ms to a 5s ceiling", () => {
  assert.equal(nextTermBackoff(undefined), 500);
  assert.equal(nextTermBackoff(0), 500);
  assert.equal(nextTermBackoff(500), 1000);
  assert.equal(nextTermBackoff(1000), 2000);
  assert.equal(nextTermBackoff(4000), 5000);
  assert.equal(nextTermBackoff(5000), 5000); // ceiling holds
});

const visibleText = (emu: ReturnType<typeof createTerminalEmulator>): string => {
  const out: string[] = [];
  for (let i = 0; i < emu.bufferLength(); i++) {
    const text = emu.rowInfo(i).text;
    if (text) out.push(text);
  }
  return out.join("\n");
};

test("replay frames REPLACE emulator state so reattach never duplicates output", () => {
  // simulate: live output accumulated, socket dropped, reattach replays all
  const emu = createTerminalEmulator({ cols: 40, rows: 10 });
  emu.write("$ npm test\r\n");
  emu.write("552 passing\r\n");
  assert.equal(visibleText(emu), "$ npm test\n552 passing");

  // reattach: the server replays the same scrollback — the client resets and
  // rebuilds from empty instead of appending, so nothing doubles
  emu.reset();
  emu.write("$ npm test\r\n552 passing\r\n");
  assert.equal(visibleText(emu), "$ npm test\n552 passing");
});

test("replay reset also clears sticky modes from the dropped session", () => {
  const emu = createTerminalEmulator({ cols: 40, rows: 10 });
  emu.write("\x1b[?1049h\x1b[?2004hin-alt");
  assert.equal(emu.modes().altScreen, true);
  emu.reset();
  emu.write("fresh");
  assert.equal(emu.modes().altScreen, false);
  assert.equal(emu.modes().bracketedPaste, false);
  assert.equal(visibleText(emu), "fresh");
});
