import { join } from "node:path";
import type { HarnessProvisioningPlan } from "@polyth/contracts";

/** Render the canonical, already-scoped plan without discovering native files.
 * Keep the controller's ordering and trust decisions. Prompt projection delivers
 * skill instructions, not a claim of native skill installation or isolation. */
export function renderCapabilityText(plan: HarnessProvisioningPlan): string | undefined {
  const sections: string[] = [];
  for (const item of plan.items) {
    if (item.mode === "unsupported") continue;
    const capability = item.capability;
    switch (capability.kind) {
      case "instruction":
        if (capability.text.trim()) sections.push(capability.text);
        break;
      case "skill":
        if (item.mode !== "prompt") continue;
        // A skill stored with its files is read on demand, as a native harness
        // would: a long catalog skill must not weigh on every prompt.
        sections.push([
          `## Skill: ${capability.title}`,
          capability.description,
          capability.bundleDir
            ? `Before using this skill, read \`${join(capability.bundleDir, "SKILL.md")}\` and follow it. Paths in it are relative to that folder.`
            : capability.instructions,
        ].filter((part) => part.trim()).join("\n\n"));
        break;
      case "context":
        if (item.mode !== "prompt") continue;
        sections.push(`## Context: ${capability.title}\n\n${capability.text}`);
        break;
    }
  }
  return sections.length ? sections.join("\n\n") : undefined;
}
