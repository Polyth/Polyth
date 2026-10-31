// Stateless utility completion for Claude Code. `claude -p` with safe-mode and
// no built-in tools answers the prompt and exits; OAuth/keychain auth is
// preserved (unlike `--bare`, which would disable native credentials).
import { createSmallModelCliRunner, type SmallModelCliRunner } from "@polyth/harness-runtime";

export interface ClaudeSmallModelRunnerOptions {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: Parameters<typeof createSmallModelCliRunner>[0]["spawnProcess"];
}

export function createClaudeSmallModelRunner(options: ClaudeSmallModelRunnerOptions): SmallModelCliRunner {
  return createSmallModelCliRunner({
    command: options.command,
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
    invocation: ({ model }) => ({
      // `--tools ""` is documented to disable all built-in tools; it goes last
      // so a variadic parser cannot consume another flag as a tool name.
      args: [
        "-p",
        "--output-format", "text",
        "--model", model.modelID,
        "--no-session-persistence",
        "--safe-mode",
        "--tools", "",
      ],
    }),
  });
}
