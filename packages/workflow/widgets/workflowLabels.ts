import { tr } from "../../../apps/web/src/i18n/index.ts";
import type { WorkflowDto } from "@polyth/contracts";
import { topologySummary } from "../src/presets.ts";
import { WORKFLOW_SAMPLES } from "../src/sampleCatalog.ts";

const presetLabels = {
  "build-review": ["workflowpreset.buildReviewName", "workflowpreset.buildReviewDescription"],
  development: ["workflowpreset.developmentName", "workflowpreset.developmentDescription"],
  "parallel-development": ["workflowpreset.parallelDevelopmentName", "workflowpreset.parallelDevelopmentDescription"],
  "visual-development": ["workflowpreset.visualDevelopmentName", "workflowpreset.visualDevelopmentDescription"],
  backend: ["workflowpreset.backendName", "workflowpreset.backendDescription"],
  research: ["workflowpreset.researchName", "workflowpreset.researchDescription"],
  review: ["workflowpreset.reviewName", "workflowpreset.reviewDescription"],
} as const;

type PresetId = keyof typeof presetLabels;

export function workflowPresetName(id: string, fallback: string): string {
  const labels = presetLabels[id as PresetId];
  return labels ? tr(labels[0]) : fallback;
}

export function workflowPresetDescription(id: string, fallback: string): string {
  const labels = presetLabels[id as PresetId];
  return labels ? tr(labels[1]) : fallback;
}

export function workflowDisplayName(workflow: WorkflowDto): string {
  return workflow.builtin && workflow.preset
    ? workflowPresetName(workflow.preset.id, workflow.name) : workflow.name;
}

export function workflowDisplayDescription(workflow: WorkflowDto): string {
  return workflow.builtin && workflow.preset
    ? workflowPresetDescription(workflow.preset.id, workflow.description ?? "") : workflow.description ?? "";
}

const EXAMPLE_PREFIX = /^Example\s*[·•]\s*/u;
const sampleDescriptions = new Map(WORKFLOW_SAMPLES.map((sample) => [sample.name, sample.description]));

/** How a workflow reads on a library card. A bundled example keeps its stored
 * "Example · " name (users may rename it) but shows the prefix as a badge, and
 * examples seeded before descriptions were stored fall back to the catalog's. */
export function workflowCardLabel(workflow: WorkflowDto): { name: string; example: boolean; description: string } {
  const display = workflowDisplayName(workflow);
  const prefix = workflow.builtin ? null : EXAMPLE_PREFIX.exec(display);
  return {
    name: prefix ? display.slice(prefix[0].length) || display : display,
    example: !!prefix,
    description: workflowDisplayDescription(workflow) || sampleDescriptions.get(workflow.name) || "",
  };
}

export function workflowTopology(workflow: WorkflowDto): string {
  if (!workflow.builtin) return topologySummary(workflow);
  return topologySummary({ ...workflow, nodes: workflow.nodes.map((node) => ({
    ...node, role: tr(node.kind === "lead" ? "workflowview.lead"
      : node.kind === "review" ? "workflowview.reviewer" : "workflowview.worker"),
  })) });
}
