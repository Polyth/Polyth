// Stateless utility completion for Copilot. A prompt piped to `copilot -s`
// runs once, non-interactively, and prints only the answer. Without an allow
// rule that mode denies every tool that needs approval, and the tools that
// could still start native agents are left out. It runs in the system
// temporary directory: the prompt is self-contained, the project's custom
// instructions must not shape it, and the one-off session then never shows up
// among the project's native sessions.
import { tmpdir } from "node:os";
import { createSmallModelCliRunner, type SmallModelCliRunner } from "@polyth/harness-runtime";

export interface CopilotSmallModelRunnerOptions {
  command: string;
  env?: NodeJS.ProcessEnv;
  /** Tools removed from the run (see `COPILOT_NATIVE_AGENT_TOOLS`). */
  excludedTools: readonly string[];
  spawnProcess?: Parameters<typeof createSmallModelCliRunner>[0]["spawnProcess"];
}

export function createCopilotSmallModelRunner(options: CopilotSmallModelRunnerOptions): SmallModelCliRunner {
  return createSmallModelCliRunner({
    command: options.command,
    cwd: tmpdir(),
    ...(options.env ? { env: options.env } : {}),
    ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
    invocation: ({ model }) => ({
      args: [
        "-s",
        "--model", model.modelID,
        "--no-custom-instructions",
        "--disable-builtin-mcps",
        "--no-auto-update",
        "--no-color",
        `--excluded-tools=${options.excludedTools.join(",")}`,
      ],
    }),
  });
}
