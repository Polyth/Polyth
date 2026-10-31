// Stateless utility completion for Pi. A short throwaway `pi -p` process with
// no session, no tools, no skills and no context files answers the prompt and
// exits; the shared CLI runner owns the process plumbing.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSmallModelCliRunner, type SmallModelCliRunner } from "@polyth/harness-runtime";

// Without a system prompt Pi runs every request as "You are an expert coding
// assistant … You help users by reading files, executing commands, editing
// code". That persona is the likely reason a tool-trained model answered title
// requests with `Let me explore the project structure first.<tool_call>` although
// no tools exist (observed from commandcode/xiaomi/mimo-v2.5-pro). pi 0.85.1:
// `--system-prompt` takes a file path and replaces that prompt, and the task
// itself stays in the user message.
const UTILITY_SYSTEM_PROMPT = "You are a text utility, not a coding agent. You have no tools and cannot read files or run commands, so never explore or plan. Follow the instructions in the user message and reply with only the requested text.";

export interface PiSmallModelRunnerOptions {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam; defaults to node:child_process spawn. */
  spawnProcess?: Parameters<typeof createSmallModelCliRunner>[0]["spawnProcess"];
}

export type PiSmallModelRunner = SmallModelCliRunner;

export function createPiSmallModelRunner(options: PiSmallModelRunnerOptions): PiSmallModelRunner {
  return createSmallModelCliRunner({
    command: options.command,
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
    invocation: ({ model }, { tempDir }) => {
      // A file, not argv text: nothing here may depend on shell quoting.
      const systemPrompt = join(tempDir, "system-prompt.txt");
      writeFileSync(systemPrompt, UTILITY_SYSTEM_PROMPT);
      return {
        args: [
          "-p",
          "--no-session",
          "--no-tools",
          "--no-skills",
          "--no-context-files",
          "--thinking", "off",
          "--system-prompt", systemPrompt,
          "--provider", model.providerID,
          "--model", model.modelID,
        ],
      };
    },
  });
}
