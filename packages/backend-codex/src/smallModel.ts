// Stateless utility completion for Codex. `codex exec --ephemeral` runs one
// non-interactive turn against the same native auth and writes the final
// message to a file, so progress output cannot contaminate the answer.
import { join } from "node:path";
import { createSmallModelCliRunner, type SmallModelCliRunner } from "@polyth/harness-runtime";

export interface CodexSmallModelRunnerOptions {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: Parameters<typeof createSmallModelCliRunner>[0]["spawnProcess"];
}

export function createCodexSmallModelRunner(options: CodexSmallModelRunnerOptions): SmallModelCliRunner {
  return createSmallModelCliRunner({
    command: options.command,
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
    invocation: ({ model }, { tempDir }) => {
      const lastMessage = join(tempDir, "last-message.txt");
      return {
        args: [
          "exec",
          "--ephemeral",
          "--skip-git-repo-check",
          "--sandbox", "read-only",
          "--color", "never",
          "--model", model.modelID,
          "--output-last-message", lastMessage,
          "-",
        ],
        parse: ({ stdout, readFile }) => {
          let fromFile = "";
          try { fromFile = readFile(lastMessage).trim(); } catch { /* not written */ }
          return fromFile || stdout.trim();
        },
      };
    },
  });
}
