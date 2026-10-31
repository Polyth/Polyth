// Stateless utility completion for Command Code. Headless `-p` withholds tools
// unless asked, so one non-interactive turn answers without touching the
// workspace; `--no-session` keeps it off disk.
import { createSmallModelCliRunner, type SmallModelCliRunner } from "@polyth/harness-runtime";

export interface CommandCodeSmallModelRunnerOptions {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: Parameters<typeof createSmallModelCliRunner>[0]["spawnProcess"];
}

export function createCommandCodeSmallModelRunner(options: CommandCodeSmallModelRunnerOptions): SmallModelCliRunner {
  return createSmallModelCliRunner({
    command: options.command,
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
    invocation: ({ model }) => ({
      args: [
        "-p",
        "--no-session",
        "--skip-onboarding",
        "--no-auto-update",
        "--max-turns", "1",
        "--output-format", "text",
        "--model", model.modelID,
      ],
    }),
  });
}
