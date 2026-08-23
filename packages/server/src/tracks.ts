// Spec-driven track orchestration. This is deliberately composition-only:
// Knowledge owns durable specs/plans/progress, Goals bounds agent turns,
// Schedule dispatches each step, Terminal runs its declared test, and Git owns
// the atomic commit. No second agent loop or process adapter is introduced.
import type {
  JsonObject,
  ProjectService,
  SessionEvent,
  SessionService,
  TrackCreateInput,
  TrackDto,
  TrackTestResult,
} from "@polyth/contracts";
import type { GitService } from "@polyth/git";
import type { GoalService } from "@polyth/goals";
import type { TrackStore } from "@polyth/knowledge";
import type { ScheduleService } from "@polyth/schedule";
import type { TerminalService } from "@polyth/terminal";

export interface TrackWorkflow {
  list(projectId?: string): TrackDto[];
  get(id: string): TrackDto | undefined;
  create(input: TrackCreateInput): Promise<TrackDto>;
  start(id: string, sessionId: string): Promise<TrackDto>;
  retry(id: string, sessionId?: string): Promise<TrackDto>;
  completeStep(id: string): Promise<TrackDto>;
  /** Called after the existing goal auditor marks a session goal completed. */
  completeForSession(sessionId: string): Promise<TrackDto | null>;
}

export interface TrackWorkflowDeps {
  tracks: TrackStore;
  goals: GoalService;
  schedule: ScheduleService;
  git: GitService;
  terminals: TerminalService;
  projects: ProjectService;
  sessions: SessionService;
  append(sessionId: string, type: string, data: JsonObject): Promise<SessionEvent | unknown>;
  now?: () => number;
}

function err(message: string, code = "invalid-input"): never {
  throw Object.assign(new Error(message), { code });
}

const stepObjective = (track: TrackDto): string => {
  const step = track.steps[track.currentStep]!;
  return [
    `Complete plan step ${track.currentStep + 1} of ${track.steps.length} for track "${track.title}".`,
    "",
    step.prompt,
    "",
    `Required verification: ${step.testCommand}`,
    "Work only on this step. Run focused checks while working, but do not create a Git commit.",
    "When the step and its test are ready, report completion; Polyth will run the declared test and create the atomic step commit.",
  ].join("\n");
};

const eventStep = (track: TrackDto): JsonObject => {
  const step = track.steps[track.currentStep]!;
  return {
    trackId: track.id,
    trackTitle: track.title,
    stepId: step.id,
    stepIndex: track.currentStep,
    stepTitle: step.title,
  };
};

const testFailure = (result: TrackTestResult): string => {
  if (result.timedOut) return `test timed out: ${result.command}`;
  return `test failed with exit code ${String(result.exitCode)}: ${result.command}`;
};

export function createTrackWorkflow(deps: TrackWorkflowDeps): TrackWorkflow {
  const now = deps.now ?? Date.now;
  const finalizing = new Set<string>();

  const rootOf = async (track: TrackDto): Promise<string> => {
    const project = await deps.projects.get(track.projectId);
    if (!project) err("track project not found", "not-found");
    if (!track.sessionId) return project.path;
    const session = await deps.sessions.snapshot(track.sessionId);
    if (session.projectId !== track.projectId) err("track session does not belong to its project");
    if (session.worktreeState === "missing") err("track session worktree is missing", "not-found");
    return session.worktreePath ?? project.path;
  };

  const markFailed = async (
    track: TrackDto,
    message: string,
    test?: TrackTestResult,
  ): Promise<TrackDto> => {
    const failed = deps.tracks.fail(track.id, track.currentStep, message, test);
    if (failed.sessionId) {
      await deps.append(failed.sessionId, "track/step-failed", {
        ...eventStep(failed),
        error: message,
        ...(test ? {
          testCommand: test.command,
          testExitCode: test.exitCode,
          testTimedOut: test.timedOut,
        } : {}),
      }).catch(() => {});
    }
    return failed;
  };

  const start = async (id: string, sessionId: string): Promise<TrackDto> => {
    const before = deps.tracks.get(id);
    if (!before) err("track not found", "not-found");
    const session = await deps.sessions.snapshot(sessionId);
    if (session.projectId !== before.projectId) err("session does not belong to the track project");
    if (session.status === "archived") err("archived sessions cannot run tracks", "conflict");

    const root = session.worktreePath ?? (await deps.projects.get(before.projectId))?.path;
    if (!root) err("track project not found", "not-found");
    if (!(await deps.git.isRepo(root))) err("tracks require a Git repository", "conflict");
    const initialStatus = await deps.git.status(root);
    if (initialStatus.conflicted.length > 0) err("resolve Git conflicts before starting a track step", "conflict");
    const next = before.steps.find((step) => step.status !== "completed");
    // Every new step starts from a clean commit boundary. A failed step may be
    // retried with its existing edits intact.
    if (next?.status === "pending" && !initialStatus.clean) {
      err("commit or discard existing changes before starting a new track step", "conflict");
    }

    let track = deps.tracks.begin(id, sessionId);
    let taskId: string | undefined;
    try {
      await deps.goals.attach(sessionId, {
        objective: stepObjective(track),
        ...(track.budgetTokens ? { budgetTokens: track.budgetTokens } : {}),
        ...(track.maxContinuations ? { maxContinuations: track.maxContinuations } : {}),
      });
      const task = deps.schedule.create({
        projectId: track.projectId,
        title: `Track: ${track.title} · Step ${track.currentStep + 1}`,
        prompt: stepObjective(track),
        cadence: { kind: "at", at: now() },
        target: { mode: "existing-session", sessionId },
        overlapPolicy: "skip",
      });
      taskId = task.id;
      track = deps.tracks.bindSchedule(track.id, track.currentStep, task.id);
      await deps.append(sessionId, "track/step-started", {
        ...eventStep(track),
        specKnowledgeId: track.specKnowledgeId,
        planKnowledgeId: track.planKnowledgeId,
        scheduleTaskId: task.id,
        testCommand: track.steps[track.currentStep]!.testCommand,
      });
      const ran = await deps.schedule.runNow(task.id);
      if (ran.lastError) {
        await deps.goals.stop(sessionId);
        return markFailed(track, `step dispatch failed: ${ran.lastError}`);
      }
      return deps.tracks.get(track.id)!;
    } catch (error) {
      if (taskId) {
        try { deps.schedule.setEnabled(taskId, false); } catch { /* task creation may have failed */ }
      }
      await deps.goals.stop(sessionId).catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      return markFailed(track, `step dispatch failed: ${message}`);
    }
  };

  const completeForSession = async (sessionId: string): Promise<TrackDto | null> => {
    if (finalizing.has(sessionId)) return deps.tracks.findRunningBySession(sessionId) ?? null;
    const track = deps.tracks.findRunningBySession(sessionId);
    if (!track) return null;
    if (deps.goals.get(sessionId)?.status !== "completed") {
      err("the active step goal is not completed", "conflict");
    }
    finalizing.add(sessionId);
    try {
      const step = track.steps[track.currentStep]!;
      const root = await rootOf(track);
      const ran = await deps.terminals.run(
        { projectId: track.projectId, cwd: root, cmd: step.testCommand },
        { timeoutMs: 120_000, maxOutputBytes: 64 * 1024 },
      );
      const test: TrackTestResult = {
        command: step.testCommand,
        exitCode: ran.exitCode,
        timedOut: ran.timedOut,
        truncated: ran.truncated,
        output: ran.output.slice(-16_000),
        completedAt: now(),
      };
      if (ran.timedOut || ran.exitCode !== 0) return markFailed(track, testFailure(test), test);

      let committed: { sha: string };
      try {
        const status = await deps.git.status(root);
        if (status.conflicted.length > 0) return markFailed(track, "Git conflicts prevent the atomic step commit", test);
        const paths = [...new Set([
          ...status.staged,
          ...status.unstaged,
          ...status.untracked,
        ].map((file) => file.path))];
        if (paths.length === 0) return markFailed(track, "step produced no changes to commit", test);
        await deps.git.stage(root, paths);
        const staged = await deps.git.status(root);
        if (staged.conflicted.length > 0 || staged.staged.length === 0) {
          return markFailed(track, "step changes could not be staged atomically", test);
        }
        const message = step.commitMessage ?? `track(${track.title}): ${step.title}`;
        committed = await deps.git.commit(root, message);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return markFailed(track, `atomic commit failed: ${message}`, test);
      }
      // Git succeeded: never attempt to roll the commit back or relabel the
      // already-completed step if a later projection/event write fails.
      const completed = await deps.tracks.complete(track.id, track.currentStep, committed.sha, test);
      await deps.append(sessionId, "track/step-completed", {
        trackId: completed.id,
        trackTitle: completed.title,
        stepId: step.id,
        stepIndex: track.currentStep,
        stepTitle: step.title,
        commitSha: committed.sha,
        testCommand: test.command,
        testExitCode: test.exitCode,
      }).catch(() => {});
      if (completed.status === "completed") {
        await deps.append(sessionId, "track/completed", {
          trackId: completed.id,
          trackTitle: completed.title,
          commits: completed.steps.map((candidate) => candidate.commitSha ?? ""),
        }).catch(() => {});
        return completed;
      }
      return start(completed.id, sessionId);
    } finally {
      finalizing.delete(sessionId);
    }
  };

  return {
    list: (projectId) => deps.tracks.list(projectId),
    get: (id) => deps.tracks.get(id),
    create: (input) => deps.tracks.create(input),
    start,
    retry(id, sessionId) {
      const track = deps.tracks.get(id);
      if (!track) err("track not found", "not-found");
      if (track.status !== "blocked") err("only blocked tracks can be retried", "conflict");
      const target = sessionId ?? track.sessionId;
      if (!target) err("sessionId is required");
      return start(id, target);
    },
    async completeStep(id) {
      const track = deps.tracks.get(id);
      if (!track) err("track not found", "not-found");
      if (!track.sessionId) err("track has no active session", "conflict");
      const completed = await completeForSession(track.sessionId);
      if (!completed) err("track has no running step", "conflict");
      return completed;
    },
    completeForSession,
  };
}
