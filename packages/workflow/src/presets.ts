import type {
  WorkflowCategory,
  WorkflowDto,
  WorkflowNodeDto,
  WorkflowPreferencesDto,
} from "@polyth/contracts";
import { layerize } from "./graph.ts";

/** Browser-safe catalog. Built-ins are synthesized, never seeded into user storage. */
export const WORKFLOW_CATEGORIES = [
  { id: "development", label: "Development" },
  { id: "visual", label: "Visual" },
  { id: "research", label: "Research" },
  { id: "review", label: "Review" },
  { id: "devops", label: "DevOps" },
  { id: "general", label: "General" },
] as const satisfies readonly { id: WorkflowCategory; label: string }[];

interface Preset {
  id: string;
  name: string;
  category: WorkflowCategory;
  description: string;
  stages: WorkflowNodeDto[][];
}

const lead = (role = "Lead", focus = "implementation"): WorkflowNodeDto => ({
  id: "lead", role, kind: "lead",
  prompt: `Inspect the request, project, and supplied context. Produce a concise ${focus} brief grounded in actual files and evidence. Allocate a bounded, non-overlapping scope to each downstream worker, identify shared contracts and checks, and state what must remain unchanged. Do not edit files. Keep the brief sufficient for workers without repeating the conversation.`,
});

const worker = (id: string, role: string, prompt: string, group?: string): WorkflowNodeDto => ({
  id, role, kind: "worker", ...(group ? { group } : {}),
  prompt: `${prompt} Follow the lead's scope for your execution-unit identity; inspect current source first. If ownership is ambiguous, report the dependency instead of editing shared files concurrently. Preserve unrelated work. Return concise results, changed paths, checks, and unresolved questions.`,
});

const review = (role = "Reviewer", focus = "correctness, regression risk, and the requested behavior"): WorkflowNodeDto => ({
  id: "review", role, kind: "review",
  prompt: `Review the actual work and upstream evidence for ${focus}. Use the original request and current project state. Run relevant available checks without modifying files. Identify actionable findings and partial or unverified work explicitly; when something must change, request changes so the units before you rework it, and approve only work that meets the request. Produce one coherent final result with the outcome, useful evidence, and any next action; do not simply concatenate worker reports.`,
});

const implementation = (count: number, role = "Worker", focus = "Implement your assigned part using existing project patterns.") =>
  Array.from({ length: count }, (_, index) => worker(`worker-${index + 1}`, role, focus, "implementation"));

const PRESETS: readonly Preset[] = [
  {
    id: "build-review", name: "Build + Review", category: "development",
    description: "Build a change, then check it independently.",
    stages: [[worker("builder", "Builder", "Implement the requested change. Inspect existing patterns and run focused checks.")], [review()]],
  },
  {
    id: "development", name: "Development", category: "development",
    description: "A lead coordinates two workers and an independent review.",
    stages: [[lead()], implementation(2), [review()]],
  },
  {
    id: "parallel-development", name: "Parallel Development", category: "development",
    description: "Split a larger change across three clearly scoped workers.",
    stages: [[lead()], implementation(3), [review()]],
  },
  {
    id: "visual-development", name: "Visual Development", category: "visual",
    description: "Build and inspect the real interface across screen sizes.",
    stages: [
      [lead("Lead", "visual design and responsive verification")],
      implementation(2, "UI Worker", "Implement your assigned visual surface using the existing design system. Inspect actual rendering with available browser/screenshot tools, including phone and desktop, long content, errors, focus, and theme preferences. Distinguish visual evidence from source inspection; report unavailable tools honestly."),
      [review("Visual Reviewer", "actual rendered appearance, responsive behavior, accessibility, and design-system consistency; inspect screenshots and the real UI when tools are available")],
    ],
  },
  {
    id: "backend", name: "Backend", category: "development",
    description: "Coordinate implementation and tests, then review the boundary.",
    stages: [
      [lead("Architect", "backend contracts, failure handling, and test ownership")],
      [worker("builder", "Backend Worker", "Implement the assigned backend behavior. Preserve authorization, storage, and runtime ownership boundaries."),
        worker("tests", "Test Worker", "Own only the test files assigned by the architect. Add causal tests for expected behavior, failure, and isolation using established fixtures. Do not edit implementation files.")],
      [review()],
    ],
  },
  {
    id: "research", name: "Research", category: "research",
    description: "Research three independent angles and synthesize the evidence.",
    stages: [
      [lead("Research Lead", "research scope, independent questions, and source quality")],
      Array.from({ length: 3 }, (_, index) => worker(`researcher-${index + 1}`, "Researcher", "Research your assigned question with available primary sources. Do not modify the project. Cite supporting sources, distinguish inference, and preserve uncertainty.", "research")),
      [review("Synthesis", "source quality, contradictory evidence, and decision-relevant findings; preserve citations and uncertainty")],
    ],
  },
  {
    id: "review", name: "Review", category: "review",
    description: "Inspect the work, then verify the findings.",
    stages: [[{ ...review(), id: "reviewer" }], [{ ...review("Verification", "the previous review's findings and reproducible checks"), id: "verify" }]],
  },
];

function instantiate(preset: Preset, projectId: string): WorkflowDto {
  const nodes = structuredClone(preset.stages.flat());
  const edges = preset.stages.slice(1).flatMap((stage, index) =>
    preset.stages[index]!.flatMap((source) => stage.map((target) => ({
      id: `${source.id}-${target.id}`, source: source.id, target: target.id,
    }))));
  return {
    id: `preset:${encodeURIComponent(projectId)}:${preset.id}`,
    projectId, name: preset.name, description: preset.description, category: preset.category,
    builtin: true, preset: { id: preset.id, version: 1 }, revision: 1, profile: "balanced",
    nodes, edges,
    defaults: { pipe: "direct", permissions: "manual", maxParallel: 2, nodeTimeoutMs: 1_800_000 },
    createdAt: 0, updatedAt: 0,
  };
}

export function workflowPresets(projectId: string): WorkflowDto[] {
  return projectId.trim() ? PRESETS.map((preset) => instantiate(preset, projectId)) : [];
}

export function getWorkflowPreset(id: string): WorkflowDto | null {
  const match = /^preset:([^:]+):([^:]+)$/.exec(id);
  if (!match) return null;
  const preset = PRESETS.find((entry) => entry.id === match[2]);
  if (!preset) return null;
  try {
    const projectId = decodeURIComponent(match[1]!);
    return projectId.trim() ? instantiate(preset, projectId) : null;
  } catch { return null; }
}

/** A compact, readable topology for cards, the picker, and assistive technology. */
export function topologySummary(workflow: Pick<WorkflowDto, "nodes" | "edges">): string {
  const result = layerize(workflow);
  if (!result.ok) return "Check workflow connections";
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  return result.layers.map((layer) => {
    const groups = new Map<string, { role: string; count: number }>();
    for (const id of layer) {
      const node = nodes.get(id)!;
      const key = node.group ? `${node.group}\u0000${node.role}` : node.id;
      const group = groups.get(key);
      if (group) group.count++;
      else groups.set(key, { role: node.role, count: 1 });
    }
    return [...groups.values()].map(({ role, count }) => count > 1 ? `${role} ×${count}` : role).join(" + ");
  }).join(" → ");
}

export function orderWorkflows(workflows: readonly WorkflowDto[], preferences: WorkflowPreferencesDto): WorkflowDto[] {
  const score = (workflow: WorkflowDto): number => {
    const pinned = preferences.pinnedIds.indexOf(workflow.id);
    if (pinned >= 0) return pinned;
    if (workflow.id === preferences.selectedId) return 100;
    const recent = preferences.recentIds.indexOf(workflow.id);
    if (recent >= 0) return 200 + recent;
    return workflow.category === preferences.category ? 300 : 400;
  };
  return workflows.map((workflow, index) => ({ workflow, index }))
    .sort((a, b) => score(a.workflow) - score(b.workflow) || a.index - b.index)
    .map(({ workflow }) => workflow);
}
