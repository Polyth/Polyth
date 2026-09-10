import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";
import type { WorkflowCreateInput, WorkflowService } from "./index.ts";
import { WORKFLOW_SAMPLES, type WorkflowSample } from "./sampleCatalog.ts";

interface WorkflowSampleSeedProject {
  projectId: string;
  samples: string[];
}

interface WorkflowSampleSeedState {
  v: 1;
  projects: WorkflowSampleSeedProject[];
}

const emptySeedState = (): WorkflowSampleSeedState => ({ v: 1, projects: [] });

function loadSeedState(file: string): WorkflowSampleSeedState {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<WorkflowSampleSeedState>;
    if (parsed.v !== 1 || !Array.isArray(parsed.projects)) return emptySeedState();
    return {
      v: 1,
      projects: parsed.projects.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const raw = candidate as { projectId?: unknown; samples?: unknown };
        if (typeof raw.projectId !== "string" || !Array.isArray(raw.samples)) return [];
        return [{
          projectId: raw.projectId,
          samples: raw.samples.filter((item): item is string => typeof item === "string"),
        }];
      }),
    };
  } catch {
    return emptySeedState();
  }
}

function saveSeedState(file: string, state: WorkflowSampleSeedState): void {
  mkdirSync(dirname(file), { recursive: true });
  atomicWriteSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

const sampleInput = (sample: WorkflowSample, projectId: string): WorkflowCreateInput => ({
  projectId,
  name: sample.name,
  nodes: structuredClone(sample.nodes),
  edges: structuredClone(sample.edges),
  defaults: structuredClone(sample.defaults),
});

/**
 * Copy each bundled example into a project once. From then on it is a normal
 * workflow: users can edit, rename, or delete it and the seeder will not
 * recreate it. The sidecar records sample keys rather than workflow ids so
 * future sample additions can be seeded independently.
 */
export function createWorkflowSampleSeeder(
  workflow: WorkflowService,
  file: string,
): (projectId: string) => void {
  const state = loadSeedState(file);

  return (rawProjectId: string): void => {
    const projectId = rawProjectId.trim();
    if (!projectId) return;

    let project = state.projects.find((candidate) => candidate.projectId === projectId);
    if (!project) {
      project = { projectId, samples: [] };
      state.projects.push(project);
    }

    const seeded = new Set(project.samples);
    const existingNames = new Set(workflow.list(projectId).map((item) => item.name));
    let changed = false;

    for (const sample of WORKFLOW_SAMPLES) {
      if (seeded.has(sample.key)) continue;
      if (!existingNames.has(sample.name)) workflow.create(sampleInput(sample, projectId));
      seeded.add(sample.key);
      changed = true;
    }

    if (!changed) return;
    project.samples = [...seeded];
    saveSeedState(file, state);
  };
}
