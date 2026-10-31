// Stateless utility completion for Cursor. `agent -p --mode ask` runs a
// read-only prompt and prints the answer; `--trust` only skips the workspace
// trust prompt (the ACP runtime requires the same trust).
import { createSmallModelCliRunner, type SmallModelCliRunner } from "@polyth/harness-runtime";

export interface CursorSmallModelRunnerOptions {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: Parameters<typeof createSmallModelCliRunner>[0]["spawnProcess"];
}

export function createCursorSmallModelRunner(options: CursorSmallModelRunnerOptions): SmallModelCliRunner {
  return createSmallModelCliRunner({
    command: options.command,
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
    invocation: ({ model }) => ({
      args: [
        "-p",
        "--mode", "ask",
        "--trust",
        "--output-format", "text",
        "--model", model.modelID,
      ],
    }),
  });
}
