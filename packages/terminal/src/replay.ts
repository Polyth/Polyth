/** Ordered terminal output and grid changes; safe to import as a browser type. */
export type TerminalReplayFrame =
  | { type: "data"; data: string }
  | { type: "resize"; cols: number; rows: number };
