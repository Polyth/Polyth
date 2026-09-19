import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowDto } from "@polyth/contracts";
import { atomicWriteSync, type ServerPackageHost } from "@polyth/plugins";

function recovery(message: string): never {
  throw Object.assign(new Error(message), { code: "recovery-required" });
}

interface SeedProject { projectId: string; samples: string[] }
interface SeedState { v: 1; projects: SeedProject[] }

function parseWorkflows(file: string): WorkflowDto[] {
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")) as unknown; } catch { recovery("legacy workflow storage is unreadable"); }
  const value = parsed as { v?: unknown; workflows?: unknown } | null;
  if (!value || (value.v !== undefined && value.v !== 1) || !Array.isArray(value.workflows)) recovery("legacy workflow storage is invalid");
  return value.workflows.map((row) => {
    const workflow = row as WorkflowDto;
    if (!workflow || typeof workflow !== "object" || typeof workflow.id !== "string" || typeof workflow.projectId !== "string") {
      recovery("legacy workflow ownership is ambiguous");
    }
    return workflow;
  });
}

function parseSeeds(file: string): SeedState {
  if (!existsSync(file)) return { v: 1, projects: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")) as unknown; } catch { recovery("legacy workflow sample state is unreadable"); }
  const value = parsed as { v?: unknown; projects?: unknown } | null;
  if (!value || value.v !== 1 || !Array.isArray(value.projects)) recovery("legacy workflow sample state is invalid");
  const projects = value.projects.map((row) => {
    const item = row as { projectId?: unknown; samples?: unknown };
    if (typeof item.projectId !== "string" || !Array.isArray(item.samples)
      || item.samples.some((sample) => typeof sample !== "string")) recovery("legacy workflow sample ownership is ambiguous");
    return { projectId: item.projectId, samples: [...item.samples] as string[] };
  });
  return { v: 1, projects };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Split the old deployment-global workflow files by canonical project Space.
 * Writes are monotonic/idempotent; a crash before legacy unlink simply repeats
 * the merge on next enable. Any ownership or conflicting duplicate ambiguity
 * fails closed instead of silently moving tenant data to a default Space.
 */
export async function migrateLegacyWorkflowStorage(host: ServerPackageHost): Promise<number> {
  const workflowFile = join(host.storageDir, "workflows.json");
  const samplesFile = join(host.storageDir, "workflow-samples.json");
  const hasWorkflowFile = existsSync(workflowFile);
  const hasSamplesFile = existsSync(samplesFile);
  if (!hasWorkflowFile && !hasSamplesFile) return 0;

  const workflows = parseWorkflows(workflowFile);
  const seeds = parseSeeds(samplesFile);
  const groupedWorkflows = new Map<string, WorkflowDto[]>();
  const groupedSeeds = new Map<string, SeedProject[]>();

  const spaceOf = async (projectId: string): Promise<string> => {
    const project = await host.projects.get(projectId);
    if (!project?.spaceId) recovery(`workflow project ownership is missing: ${projectId}`);
    return project.spaceId;
  };

  for (const workflow of workflows) {
    const spaceId = await spaceOf(workflow.projectId);
    const rows = groupedWorkflows.get(spaceId) ?? [];
    rows.push(workflow);
    groupedWorkflows.set(spaceId, rows);
  }
  for (const seed of seeds.projects) {
    const spaceId = await spaceOf(seed.projectId);
    const rows = groupedSeeds.get(spaceId) ?? [];
    rows.push(seed);
    groupedSeeds.set(spaceId, rows);
  }

  const spaces = new Set([...groupedWorkflows.keys(), ...groupedSeeds.keys()]);
  for (const spaceId of spaces) {
    const root = host.spaceStorage(host.systemSpaceContext(spaceId)).packageDir(host.pluginId);
    const targetWorkflows = join(root, "workflows.json");
    const targetSamples = join(root, "workflow-samples.json");

    const existingWorkflows = parseWorkflows(targetWorkflows);
    const merged = new Map(existingWorkflows.map((workflow) => [workflow.id, workflow]));
    for (const workflow of groupedWorkflows.get(spaceId) ?? []) {
      const existing = merged.get(workflow.id);
      if (existing && !sameJson(existing, workflow)) recovery(`workflow id conflict during Space migration: ${workflow.id}`);
      merged.set(workflow.id, workflow);
    }
    atomicWriteSync(targetWorkflows, `${JSON.stringify({ v: 1, workflows: [...merged.values()] }, null, 2)}\n`);

    const existingSeeds = parseSeeds(targetSamples);
    const byProject = new Map(existingSeeds.projects.map((entry) => [entry.projectId, new Set(entry.samples)]));
    for (const entry of groupedSeeds.get(spaceId) ?? []) {
      const set = byProject.get(entry.projectId) ?? new Set<string>();
      for (const sample of entry.samples) set.add(sample);
      byProject.set(entry.projectId, set);
    }
    atomicWriteSync(targetSamples, `${JSON.stringify({
      v: 1,
      projects: [...byProject].map(([projectId, samples]) => ({ projectId, samples: [...samples] })),
    }, null, 2)}\n`);
  }

  if (hasWorkflowFile) unlinkSync(workflowFile);
  if (hasSamplesFile) unlinkSync(samplesFile);
  return workflows.length + seeds.projects.length;
}
