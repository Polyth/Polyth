// Stateless utility completion for the Antigravity CLI. `agy` has a text print
// mode but no text stdin mode: the prompt must be the value of `--print`, so it
// travels in argv (the shared runner maps an OS argument-limit failure back to
// the session compatibility path).
import { createSmallModelCliRunner, type SmallModelCliRunner } from "@polyth/harness-runtime";

export interface AntigravitySmallModelRunnerOptions {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: Parameters<typeof createSmallModelCliRunner>[0]["spawnProcess"];
}

export function createAntigravitySmallModelRunner(options: AntigravitySmallModelRunnerOptions): SmallModelCliRunner {
  return createSmallModelCliRunner({
    command: options.command,
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
    invocation: ({ model }, { message }) => ({
      args: [
        `--print=${message}`,
        "--output-format", "text",
        "--disable-slash-commands",
        "--model", model.modelID,
      ],
      stdin: "none",
    }),
  });
}
