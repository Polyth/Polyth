import type { TerminalReplayFrame } from "../../src/replay.ts";
import type { TerminalEmulator } from "./emulator.ts";

function isReplayFrame(value: unknown): value is TerminalReplayFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Record<string, unknown>;
  if (frame.type === "data") return typeof frame.data === "string";
  return frame.type === "resize"
    && typeof frame.cols === "number" && Number.isInteger(frame.cols) && frame.cols >= 2 && frame.cols <= 1000
    && typeof frame.rows === "number" && Number.isInteger(frame.rows) && frame.rows >= 2 && frame.rows <= 500;
}

/** Replay at the original grids before restoring the current visible grid. */
export function restoreTerminalReplay(emu: TerminalEmulator, data: string, frames?: unknown): void {
  const cols = emu.cols();
  const rows = emu.rows();
  emu.reset();
  if (Array.isArray(frames) && frames.length > 0 && frames.length <= 4096 && frames.every(isReplayFrame)) {
    for (const frame of frames) {
      if (frame.type === "resize") emu.resize(frame.cols, frame.rows);
      else emu.write(frame.data);
    }
  } else {
    // Older servers and malformed optional metadata retain the string replay.
    emu.write(data);
  }
  emu.resize(cols, rows);
}
