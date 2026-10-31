import test from "node:test";
import assert from "node:assert/strict";
import { createReplayBuffer } from "../src/index.ts";
import { createTerminalEmulator } from "../widgets/terminal/emulator.ts";
import { restoreTerminalReplay } from "../widgets/terminal/replay.ts";

const text = (emu: ReturnType<typeof createTerminalEmulator>) => emu.getText(
  { row: 0, col: 0 }, { row: emu.scrollbackLength() + emu.rows() - 1, col: emu.cols() },
);

test("startup replay renders a prompt once after its initial PTY grid changes", () => {
  const prompt = "dev@workstation:/home/dev/src/polyth-example-builds-4bc0df77ceac$ ";
  const replay = createReplayBuffer();
  replay.resize(120, 32);
  replay.push(Buffer.from(`\x1b[?2004h${prompt}`));
  replay.resize(45, 24);
  replay.push(Buffer.from(`\r\x1b[K${prompt}`));

  const old = createTerminalEmulator({ cols: 45, rows: 24 });
  old.write(replay.snapshot());
  assert.equal(text(old).split("dev@workstation").length - 1, 2, "captured startup sequence reproduces the duplicate prompt prefix at the current grid");

  const restored = createTerminalEmulator({ cols: 45, rows: 24 });
  restored.write("stale output");
  restoreTerminalReplay(restored, replay.snapshot(), replay.frames());
  assert.equal(text(restored).trim(), prompt.trim());
  assert.equal(restored.cols(), 45);
  assert.equal(restored.rows(), 24);
  restored.write("echo hi");
  assert.equal(text(restored).trim(), `${prompt}echo hi`);
});

test("reconnect rebuilds replay at recorded grids and returns to the visible size", () => {
  const replay = createReplayBuffer();
  replay.resize(120, 32);
  replay.push(Buffer.from("ubuntu$ "));
  const emu = createTerminalEmulator({ cols: 80, rows: 24 });
  restoreTerminalReplay(emu, replay.snapshot(), replay.frames());
  restoreTerminalReplay(emu, replay.snapshot(), replay.frames());
  assert.equal(text(emu).trim(), "ubuntu$");
  assert.equal(emu.cols(), 80);
  assert.equal(emu.rows(), 24);
});

test("legacy string replay and invalid optional frames retain compatible rendering", () => {
  const emu = createTerminalEmulator({ cols: 80, rows: 24 });
  for (const frames of [undefined, [], [{ type: "resize", cols: 0, rows: 24 }], [{ type: "data", data: 42 }], new Array(4097).fill({ type: "data", data: "bad" })]) {
    emu.write("stale");
    restoreTerminalReplay(emu, "ubuntu$ ", frames);
    assert.equal(text(emu).trim(), "ubuntu$");
    assert.equal(emu.cols(), 80);
    assert.equal(emu.rows(), 24);
  }
});
