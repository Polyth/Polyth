// Durable spec-driven tracks live beside project knowledge. A track owns two
// ordinary Knowledge records (feature spec + managed plan) and a small JSON
// execution ledger. Runtime execution is composed by the server from goals,
// schedules, tests, and Git; this package only owns durable workflow state.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";
import type {
  TrackCreateInput,
  TrackDto,
  TrackStepDto,
  TrackTestResult,
} from "@polyth/contracts";
import type { KnowledgeStore } from "./index.ts";

export type {
  TrackCreateInput,
  TrackDto,
  TrackStatus,
  TrackStepDto,
  TrackStepInput,
  TrackStepStatus,
  TrackTestResult,
} from "@polyth/contracts";

export interface TrackStore {
  list(projectId?: string): TrackDto[];
  get(id: string): TrackDto | undefined;
  create(input: TrackCreateInput): Promise<TrackDto>;
  begin(id: string, sessionId: string): TrackDto;
  bindSchedule(id: string, stepIndex: number, scheduleTaskId: string): TrackDto;
  fail(id: string, stepIndex: number, error: string, test?: TrackTestResult): TrackDto;
  complete(id: string, stepIndex: number, commitSha: string, test: TrackTestResult): Promise<TrackDto>;
  findRunningBySession(sessionId: string): TrackDto | undefined;
}

interface PersistedTracks {
  v: 1;
  tracks: TrackDto[];
}

export interface TrackStoreOptions {
  file: string;
  knowledge: KnowledgeStore;
  now?: () => number;
}

const MAX_STEPS = 50;
const MAX_PROMPT = 32 * 1024;
const MAX_COMMAND = 2_000;

function fail(message: string, code = "invalid-input"): never {
  throw Object.assign(new Error(message), { code });
}

const positiveInteger = (value: number | undefined, field: string): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || !Number.isFinite(value) || value <= 0) {
    throw Object.assign(new Error(`${field} must be a finite positive integer`), {
      code: "invalid-input",
      field,
    });
  }
  return value;
};

const bounded = (value: unknown, field: string, limit: number): string => {
  if (typeof value !== "string" || !value.trim()) fail(`${field} is required`);
  const trimmed = (value as string).trim();
  if (trimmed.length > limit) fail(`${field} exceeds ${limit} characters`);
  return trimmed;
};

const inline = (value: string): string => value.replace(/\s+/g, " ").replaceAll("`", "'").trim();

export function trackPlanBody(track: Pick<TrackDto, "id" | "title" | "steps">): string {
  const lines = [
    `# ${track.title}`,
    "",
    `Managed by Polyth track \`${track.id}\`. Progress and commit hashes are updated after each verified step.`,
    "",
  ];
  track.steps.forEach((step, index) => {
    const done = step.status === "completed" ? "x" : " ";
    lines.push(`- [${done}] <!-- track-step:${step.id} --> **${index + 1}. ${inline(step.title)}**`);
    lines.push(`  - Test: \`${inline(step.testCommand)}\``);
    if (step.commitSha) lines.push(`  - Commit: \`${step.commitSha}\``);
    lines.push(`  - Instructions: ${inline(step.prompt)}`);
  });
  return `${lines.join("\n")}\n`;
}

const clone = <T>(value: T): T => structuredClone(value);

function load(file: string): TrackDto[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PersistedTracks>;
    return parsed.v === 1 && Array.isArray(parsed.tracks) ? parsed.tracks : [];
  } catch {
    return [];
  }
}

export function createTrackStore(opts: TrackStoreOptions): TrackStore {
  const now = opts.now ?? Date.now;
  let tracks = load(opts.file);

  const save = (): void => {
    mkdirSync(dirname(opts.file), { recursive: true });
    atomicWriteSync(opts.file, `${JSON.stringify({ v: 1, tracks } satisfies PersistedTracks, null, 2)}\n`);
  };

  const mustGet = (id: string): TrackDto => {
    const track = tracks.find((candidate) => candidate.id === id);
    if (!track) fail("track not found", "not-found");
    return track!;
  };

  const touch = (track: TrackDto): void => {
    track.revision += 1;
    track.updatedAt = now();
    save();
  };

  return {
    list(projectId) {
      return tracks
        .filter((track) => !projectId || track.projectId === projectId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(clone);
    },

    get(id) {
      const track = tracks.find((candidate) => candidate.id === id);
      return track ? clone(track) : undefined;
    },

    async create(input) {
      const projectId = bounded(input.projectId, "projectId", 200);
      const title = bounded(input.title, "title", 200);
      const spec = bounded(input.spec, "spec", 256 * 1024);
      if (!Array.isArray(input.steps) || input.steps.length === 0) fail("at least one plan step is required");
      if (input.steps.length > MAX_STEPS) fail(`at most ${MAX_STEPS} plan steps`);
      const budgetTokens = positiveInteger(input.budgetTokens, "budgetTokens");
      const maxContinuations = positiveInteger(input.maxContinuations, "maxContinuations");
      const id = randomUUID();
      const steps: TrackStepDto[] = input.steps.map((raw, index) => {
        const stepTitle = bounded(raw.title, `steps[${index}].title`, 200);
        const prompt = raw.prompt === undefined
          ? stepTitle
          : bounded(raw.prompt, `steps[${index}].prompt`, MAX_PROMPT);
        const testCommand = bounded(raw.testCommand, `steps[${index}].testCommand`, MAX_COMMAND);
        const commitMessage = raw.commitMessage === undefined
          ? undefined
          : bounded(raw.commitMessage, `steps[${index}].commitMessage`, 500);
        return {
          id: randomUUID(),
          title: stepTitle,
          prompt,
          testCommand,
          ...(commitMessage ? { commitMessage } : {}),
          status: "pending",
        };
      });
      const createdAt = now();
      const draft = {
        id,
        projectId,
        title,
        status: "draft" as const,
        specKnowledgeId: "",
        planKnowledgeId: "",
        planRevision: 1,
        steps,
        currentStep: 0,
        ...(budgetTokens ? { budgetTokens } : {}),
        ...(maxContinuations ? { maxContinuations } : {}),
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      };
      let specKnowledgeId: string | undefined;
      let planKnowledgeId: string | undefined;
      try {
        const specItem = await opts.knowledge.create({
          projectId,
          kind: "spec",
          title: `${title} — feature spec`,
          body: spec,
          tags: ["track", `track:${id}`, "feature-spec"],
        });
        specKnowledgeId = specItem.id;
        const planItem = await opts.knowledge.create({
          projectId,
          kind: "plan",
          title: `${title} — implementation plan`,
          body: trackPlanBody(draft),
          tags: ["track", `track:${id}`, "implementation-plan"],
        });
        planKnowledgeId = planItem.id;
        const track: TrackDto = {
          ...draft,
          specKnowledgeId,
          planKnowledgeId,
          planRevision: planItem.revision,
        };
        tracks.push(track);
        try {
          save();
        } catch (error) {
          tracks = tracks.filter((candidate) => candidate.id !== track.id);
          throw error;
        }
        return clone(track);
      } catch (error) {
        if (planKnowledgeId) await opts.knowledge.remove(planKnowledgeId).catch(() => false);
        if (specKnowledgeId) await opts.knowledge.remove(specKnowledgeId).catch(() => false);
        throw error;
      }
    },

    begin(id, sessionId) {
      const track = mustGet(id);
      if (track.status === "completed") fail("track is already completed", "conflict");
      if (track.status === "running") fail("track already has a running step", "conflict");
      const index = track.steps.findIndex((step) => step.status !== "completed");
      if (index < 0) fail("track has no remaining steps", "conflict");
      const step = track.steps[index]!;
      step.status = "running";
      step.sessionId = bounded(sessionId, "sessionId", 200);
      step.startedAt = now();
      delete step.completedAt;
      delete step.commitSha;
      delete step.error;
      track.currentStep = index;
      track.sessionId = sessionId;
      track.status = "running";
      touch(track);
      return clone(track);
    },

    bindSchedule(id, stepIndex, scheduleTaskId) {
      const track = mustGet(id);
      const step = track.steps[stepIndex];
      if (!step || step.status !== "running") fail("track step is not running", "conflict");
      step!.scheduleTaskId = bounded(scheduleTaskId, "scheduleTaskId", 200);
      touch(track);
      return clone(track);
    },

    fail(id, stepIndex, error, test) {
      const track = mustGet(id);
      const step = track.steps[stepIndex];
      if (!step || step.status !== "running") fail("track step is not running", "conflict");
      step!.status = "failed";
      step!.error = bounded(error, "error", 4_000);
      if (test) step!.test = clone(test);
      track.status = "blocked";
      touch(track);
      return clone(track);
    },

    async complete(id, stepIndex, commitSha, test) {
      const track = mustGet(id);
      const step = track.steps[stepIndex];
      if (!step || step.status !== "running") fail("track step is not running", "conflict");
      const sha = bounded(commitSha, "commitSha", 160);
      if (!/^[0-9a-f]{40,64}$/i.test(sha)) fail("commitSha must be a full Git commit hash");
      step!.status = "completed";
      step!.commitSha = sha;
      step!.test = clone(test);
      step!.completedAt = now();
      delete step!.error;
      const next = track.steps.findIndex((candidate) => candidate.status !== "completed");
      track.currentStep = next < 0 ? track.steps.length : next;
      track.status = next < 0 ? "completed" : "draft";
      touch(track);

      // The ledger is authoritative if a user deleted/edited the managed plan;
      // update the normal Knowledge record best-effort after durable completion.
      try {
        const currentPlan = await opts.knowledge.get(track.planKnowledgeId);
        if (currentPlan) {
          const updated = await opts.knowledge.update(
            track.planKnowledgeId,
            { body: trackPlanBody(track) },
            currentPlan.revision,
          );
          track.planRevision = updated.revision;
          touch(track);
        }
      } catch {
        // Completion and its commit hash must not be rolled back after Git has
        // committed merely because the secondary plan rendering was edited.
      }
      return clone(track);
    },

    findRunningBySession(sessionId) {
      const track = tracks.find((candidate) =>
        candidate.status === "running"
        && candidate.steps[candidate.currentStep]?.sessionId === sessionId);
      return track ? clone(track) : undefined;
    },
  };
}
