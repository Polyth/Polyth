import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  WorkflowEdgeDto,
  WorkflowNodeDto,
  WorkflowRunOptionsDto,
} from "@polyth/contracts";
import { atomicWriteSync } from "@polyth/plugins";
import type { WorkflowCreateInput, WorkflowService } from "./index.ts";

export interface WorkflowSample {
  key: string;
  name: string;
  description: string;
  exampleInput: string;
  nodes: WorkflowNodeDto[];
  edges: WorkflowEdgeDto[];
  defaults: WorkflowRunOptionsDto;
}

export const WORKFLOW_SAMPLES: readonly WorkflowSample[] = [
  {
    key: "build-review",
    name: "Example · Build & Review",
    description: "Implement a software change, review it independently, verify it, then finalize the smallest correct diff.",
    exampleInput: "Add a compact keyboard-shortcuts help dialog to this application. Reuse existing UI primitives and keep the change minimal.",
    nodes: [
      {
        id: "scout",
        role: "Codebase Scout",
        prompt: "Inspect the project and the requested change. Identify the relevant files, existing patterns, constraints, tests, and likely risks. Do not modify files. Return a concise implementation brief with exact paths and reusable code you found.",
      },
      {
        id: "plan",
        role: "Implementation Planner",
        prompt: "Using the workflow input and upstream analysis, produce the smallest correct implementation plan. Prefer existing abstractions, platform capabilities, and already-installed dependencies. Define acceptance criteria and the most relevant checks. Do not modify files.",
      },
      {
        id: "implement",
        role: "Builder",
        prompt: "Implement the requested change using the approved upstream plan and the actual project state. Keep the diff minimal, preserve unrelated behavior, reuse existing code, and avoid speculative abstractions. Run focused checks where practical. Report changed files and checks performed.",
      },
      {
        id: "review",
        role: "Independent Reviewer",
        prompt: "Independently inspect the resulting working tree and diff together with the original task. Do not edit files. Look for correctness regressions, architecture violations, security or data-loss risks, accessibility regressions, unnecessary complexity, and missed edge cases. Return only actionable findings, ranked by severity; say explicitly when there are no material findings.",
      },
      {
        id: "verify",
        role: "Verifier",
        prompt: "Independently verify the implementation without editing files. Run the most relevant available tests, lint, typecheck, or build commands for the changed area. Inspect failures and distinguish likely pre-existing failures from regressions introduced by this change. Return the commands run and concise results.",
      },
      {
        id: "finalize",
        role: "Finalizer",
        prompt: "Use the original task and all upstream results. Inspect the actual working tree. Fix only confirmed issues required to satisfy the task, keep the final diff minimal, rerun the relevant checks, and return a concise final summary with changed files, verification results, and any remaining risk.",
      },
    ],
    edges: [
      { id: "scout-plan", source: "scout", target: "plan" },
      { id: "plan-implement", source: "plan", target: "implement" },
      { id: "implement-review", source: "implement", target: "review" },
      { id: "implement-verify", source: "implement", target: "verify" },
      { id: "review-finalize", source: "review", target: "finalize" },
      { id: "verify-finalize", source: "verify", target: "finalize" },
    ],
    defaults: {
      pipe: "ancestors",
      permissions: "auto",
      maxParallel: 2,
      nodeTimeoutMs: 1_800_000,
    },
  },
  {
    key: "research-decide",
    name: "Example · Research & Decide",
    description: "Research an open question from independent angles, reconcile the evidence, and produce a decision-ready recommendation.",
    exampleInput: "Choose a database for a small analytics product. Compare PostgreSQL, ClickHouse, and DuckDB for ingest, analytics queries, operations, ecosystem, and cost, then recommend a default and explain when the answer changes.",
    nodes: [
      {
        id: "scope",
        role: "Research Lead",
        prompt: "Turn the workflow input into a decision frame: the real question, assumptions, evaluation criteria, constraints, and facts that must be verified. Do not choose a winner yet. Keep the scope concise enough for parallel researchers to use consistently.",
      },
      {
        id: "primary",
        role: "Primary-Source Researcher",
        prompt: "Research the question using the best available primary or authoritative sources and tools. Focus on verifiable capabilities, limitations, current pricing or constraints when relevant, and exact facts that affect the decision. Cite source names or URLs when available and clearly mark anything you could not verify.",
      },
      {
        id: "practical",
        role: "Practical Researcher",
        prompt: "Research real-world operational and user experience relevant to the decision. Look for deployment friction, maintenance burden, ecosystem maturity, common failure modes, migration costs, and situations where headline claims differ from practice. Separate evidence from opinion and note source quality.",
      },
      {
        id: "risk",
        role: "Risk & Cost Analyst",
        prompt: "Analyze the options primarily through risk, cost, lock-in, complexity, reversibility, and likely second-order consequences. Quantify when trustworthy data is available; otherwise state uncertainty. Identify the conditions that could invalidate an otherwise attractive option.",
      },
      {
        id: "critic",
        role: "Evidence Critic",
        prompt: "Reconcile all upstream research against the original decision frame. Identify contradictions, unsupported claims, stale evidence, hidden assumptions, and criteria that were not actually answered. Produce a compact evidence table or structured comparison and state which conclusions are high-, medium-, or low-confidence.",
      },
      {
        id: "decision",
        role: "Decision Maker",
        prompt: "Produce the final decision-ready recommendation from the original task and reconciled evidence. Give a clear default choice, the strongest reasons, important trade-offs, and explicit conditions under which another option becomes better. Keep the conclusion concise but preserve material uncertainty and citations from upstream research.",
      },
    ],
    edges: [
      { id: "scope-primary", source: "scope", target: "primary" },
      { id: "scope-practical", source: "scope", target: "practical" },
      { id: "scope-risk", source: "scope", target: "risk" },
      { id: "primary-critic", source: "primary", target: "critic" },
      { id: "practical-critic", source: "practical", target: "critic" },
      { id: "risk-critic", source: "risk", target: "critic" },
      { id: "critic-decision", source: "critic", target: "decision" },
    ],
    defaults: {
      pipe: "ancestors",
      permissions: "auto",
      maxParallel: 3,
      nodeTimeoutMs: 1_800_000,
    },
  },
  {
    key: "content-studio",
    name: "Example · Content Studio",
    description: "Turn one product or campaign brief into coordinated positioning, landing-page, email, and social copy with a final editorial pass.",
    exampleInput: "Launch a privacy-first password manager for freelancers. The tone should be confident and human, never fear-based. Prepare a compact launch package for an English-speaking audience.",
    nodes: [
      {
        id: "brief",
        role: "Creative Lead",
        prompt: "Translate the workflow input into a compact creative brief: product or idea, target audience, desired action, differentiators, proof available, tone, constraints, and claims that must not be invented. Do not write final campaign copy yet.",
      },
      {
        id: "audience",
        role: "Audience Researcher",
        prompt: "Develop the audience angle from the brief. Identify likely jobs-to-be-done, pains, objections, motivations, vocabulary, and trust signals. Avoid invented demographic precision. Return messaging implications that a strategist can directly use.",
      },
      {
        id: "market",
        role: "Market & Positioning Researcher",
        prompt: "Analyze likely alternatives, category conventions, positioning traps, and opportunities to differentiate. Use available research tools when useful. Do not invent competitor facts; mark assumptions. Return concrete positioning implications rather than generic marketing advice.",
      },
      {
        id: "strategy",
        role: "Messaging Strategist",
        prompt: "Using the brief and upstream research, define one coherent messaging strategy: positioning statement, primary promise, supporting pillars, proof requirements, objection handling, CTA, voice, and phrases or claims to avoid. Resolve conflicts between researchers instead of simply concatenating them.",
      },
      {
        id: "landing",
        role: "Landing Page Writer",
        prompt: "Write concise landing-page copy from the approved messaging strategy. Include hero, supporting sections, proof placeholders only where proof is actually needed, objection handling, and CTA. Do not invent testimonials, metrics, certifications, or customer claims.",
      },
      {
        id: "email",
        role: "Launch Email Writer",
        prompt: "Write a launch email from the messaging strategy. Provide a strong subject line, preview text, compact body, and one clear CTA. Keep the voice aligned with the brief and avoid claims unsupported by upstream context.",
      },
      {
        id: "social",
        role: "Social Writer",
        prompt: "Create a small cross-platform social launch set from the messaging strategy: one concise LinkedIn-style post and three short posts suitable for fast social feeds. Preserve the same positioning while adapting density and hook. Do not add fabricated traction or urgency.",
      },
      {
        id: "edit",
        role: "Managing Editor",
        prompt: "Edit all upstream assets into one coherent launch package. Remove repetition, contradictions, generic AI phrasing, unsupported claims, and tone drift. Keep each channel native to its format while preserving one positioning. Return the final package under clear headings: Messaging Core, Landing Page, Launch Email, Social Posts, and Open Proof Gaps.",
      },
    ],
    edges: [
      { id: "brief-audience", source: "brief", target: "audience" },
      { id: "brief-market", source: "brief", target: "market" },
      { id: "audience-strategy", source: "audience", target: "strategy" },
      { id: "market-strategy", source: "market", target: "strategy" },
      { id: "strategy-landing", source: "strategy", target: "landing" },
      { id: "strategy-email", source: "strategy", target: "email" },
      { id: "strategy-social", source: "strategy", target: "social" },
      { id: "landing-edit", source: "landing", target: "edit" },
      { id: "email-edit", source: "email", target: "edit" },
      { id: "social-edit", source: "social", target: "edit" },
    ],
    defaults: {
      pipe: "ancestors",
      permissions: "auto",
      maxParallel: 3,
      nodeTimeoutMs: 1_800_000,
    },
  },
];

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
