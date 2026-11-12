// Stateless utility completion for Claude Code. `claude -p` with safe-mode, a
// tool-free system prompt and no built-in tools answers the prompt and exits; OAuth/keychain auth is
// preserved (unlike `--bare`, which would disable native credentials).
import { createSmallModelCliRunner, type SmallModelCliRunner } from "@polyth/harness-runtime";

export interface ClaudeSmallModelRunnerOptions {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: Parameters<typeof createSmallModelCliRunner>[0]["spawnProcess"];
}

/**
 * Replaces Claude Code's default agent prompt for utility runs. `--tools ""`
 * removes every tool definition, but the default prompt still tells the model
 * to work in its directory with Read, Grep and the rest. Asked about a file
 * path, the model then wrote a Read call as plain text, and Files' Explain
 * showed `<invoke name="Read">` as the explanation. The CLI keeps its own
 * identity and billing blocks ahead of this text (captured from 2.1.322).
 * It is fixed text, so it may go in argv, and it avoids the characters a
 * Windows `.cmd` shim refuses.
 */
export const CLAUDE_UTILITY_SYSTEM_PROMPT =
  "You answer one request in a single reply. You have no tools: you cannot read files, run commands or browse, " +
  "and everything you need is in the request. Answer it directly in plain text. Never write tool calls, " +
  "function calls or XML that imitates them.";

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
        "--system-prompt", CLAUDE_UTILITY_SYSTEM_PROMPT,
        "--tools", "",
      ],
    }),
  });
}
