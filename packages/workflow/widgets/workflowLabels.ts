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

/** The built-in routing roles, in the order the editor offers them. A template
 * may carry another id (`custom-…`); it stays selectable as it is. */
export const WORKFLOW_ROUTING_ROLES = ["explore", "implement", "verify", "review", "vision", "write"] as const;

export function workflowRoleLabel(role: string): string {
  return (WORKFLOW_ROUTING_ROLES as readonly string[]).includes(role)
    ? tr(`workflowview.role.${role}` as "workflowview.role.explore")
    : role;
}

interface RouteFields {
  harness?: { mode: string; harnessId?: string };
  model?: { modelID: string };
}

const routeLabel = (node: RouteFields): string =>
  `${node.harness?.mode === "pinned" && node.harness.harnessId ? node.harness.harnessId : tr("workflowview.projectHarness")} · ${node.model?.modelID ?? tr("workflowview.defaultModel")}`;

/** A definition unit's route as one muted line: "By role: Implement" and, when
 * the unit also pins a route (its fallback), that route after it. */
export function workflowNodeRouteText(node: RouteFields & { routingRole?: string }): string {
  if (!node.routingRole) return routeLabel(node);
  const role = tr("workflowview.byRole", { role: workflowRoleLabel(node.routingRole) });
  return node.model || node.harness?.mode === "pinned" ? `${role} · ${routeLabel(node)}` : role;
}

/** A run unit's route: the role that chose it, then what it ran on. */
export function workflowRunRouteText(node: RouteFields & { routedRole?: string }): string | undefined {
  if (!node.routedRole) return undefined;
  return `${tr("workflowview.byRole", { role: workflowRoleLabel(node.routedRole) })} → ${routeLabel(node)}`;
}
