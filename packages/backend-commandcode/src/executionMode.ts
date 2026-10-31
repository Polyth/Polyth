import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HarnessControlDescriptor, JsonValue } from "@polyth/contracts";

export type CommandCodeExecutionMode = "follow-polyth" | "plan";

const DEFAULT_MODE: CommandCodeExecutionMode = "follow-polyth";

export async function readCommandCodeExecutionMode(file: string): Promise<CommandCodeExecutionMode> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as { executionMode?: unknown };
    return value?.executionMode === "plan" ? "plan" : DEFAULT_MODE;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_MODE;
    return DEFAULT_MODE;
  }
}

export async function writeCommandCodeExecutionMode(
  file: string,
  value: JsonValue,
): Promise<CommandCodeExecutionMode> {
  if (value !== "follow-polyth" && value !== "plan") {
    throw Object.assign(new Error("Unsupported Command Code execution mode"), { code: "invalid-control" });
  }
  const next: CommandCodeExecutionMode = value;
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ version: 1, executionMode: next }, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
  return next;
}

export function commandCodeExecutionModeControl(
  value: CommandCodeExecutionMode,
): HarnessControlDescriptor {
  return {
    id: "execution-mode",
    label: "Native execution mode",
    description: value === "plan"
      ? "Command Code runs in native Plan mode: read-only exploration and plan generation, with mutations denied by its own permission engine."
      : "Command Code follows Polyth safety policy: Auto-Approve maps to native auto-accept; otherwise native dont-ask fails closed instead of opening a terminal prompt.",
    kind: "select",
    scope: "project",
    placement: "harness-settings",
    applySemantics: "next-turn",
    danger: "none",
    available: true,
    value,
    choices: [
      {
        value: "follow-polyth",
        label: "Follow Polyth",
        description: "Use Polyth Auto-Approve when enabled; otherwise deny interactive permission prompts headlessly.",
      },
      {
        value: "plan",
        label: "Plan",
        description: "Use Command Code's native plan permission mode for read-only exploration and planning.",
      },
    ],
  };
}
