import { createApiTransport } from "@polyth/web-sdk";
import type {
  CoachApi, CoachCommitmentDto, CoachGoalDto, CoachProfileDto,
  CoachProposalDto, CoachRoutineDto,
} from "./api.ts";

export type { CoachSessionOptions, CoachSessionReply } from "./api.ts";

export interface CoachSetupPreferences {
  confirm: true;
  timeZone: string;
  tone: CoachProfileDto["tone"];
  initiative: CoachProfileDto["initiative"];
  challengeAssumptions: boolean;
  dailyCheckIn: boolean;
  dailyMinuteOfDay: number;
  weeklyReview: boolean;
  weeklyDay: number;
  weeklyMinuteOfDay: number;
}

/** Extends the existing transport; no duplicate state, polling or chat engine. */
export interface CoachJourneyApi extends CoachApi {
  finishSetup(input: CoachSetupPreferences): Promise<CoachProfileDto>;
  goals(status?: CoachGoalDto["status"]): Promise<CoachGoalDto[]>;
  createGoal(input: { title: string; desiredOutcome?: string }): Promise<CoachGoalDto>;
  updateGoal(id: string, patch: Partial<Pick<CoachGoalDto, "title" | "desiredOutcome" | "why" | "status">>): Promise<CoachGoalDto>;
  setPrimaryGoal(id: string): Promise<CoachGoalDto>;
  clearPrimaryGoal(): Promise<unknown>;
  commitments(goalId?: string): Promise<CoachCommitmentDto[]>;
  /**
   * `plannedFor` is optional on purpose. A next action toward a goal is not the
   * same thing as a commitment for today, and the UI must be able to express
   * "unscheduled" instead of silently stamping the current time.
   */
  createCommitment(input: { title: string; goalId?: string; plannedFor?: number }): Promise<CoachCommitmentDto>;
  rescheduleCommitment(id: string, plannedFor: number): Promise<CoachCommitmentDto>;
  routines(): Promise<CoachRoutineDto[]>;
  proposals(): Promise<CoachProposalDto[]>;
}

export function createCoachJourneyApi(base: CoachApi): CoachJourneyApi {
  const api = createApiTransport();
  const goalPath = (id: string) => `/api/personal-coach/goals/${encodeURIComponent(id)}`;
  return {
    ...base,
    finishSetup: (input) => api.post<CoachProfileDto>("/api/personal-coach/setup", input),
    goals: async (status) => (await api.get<{ goals: CoachGoalDto[] }>(
      `/api/personal-coach/goals${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    )).goals,
    createGoal: (input) => api.post<CoachGoalDto>("/api/personal-coach/goals", input),
    updateGoal: (id, patch) => api.patch<CoachGoalDto>(goalPath(id), patch),
    setPrimaryGoal: (id) => api.post<CoachGoalDto>(`${goalPath(id)}/primary`, {}),
    clearPrimaryGoal: () => api.delete<unknown>("/api/personal-coach/goals/primary"),
    commitments: async (goalId) => (await api.get<{ commitments: CoachCommitmentDto[] }>(
      `/api/personal-coach/commitments?status=open&limit=100${goalId ? `&goalId=${encodeURIComponent(goalId)}` : ""}`,
    )).commitments,
    createCommitment: (input) => api.post<CoachCommitmentDto>("/api/personal-coach/commitments", input),
    rescheduleCommitment: (id, plannedFor) => api.post<CoachCommitmentDto>(
      `/api/personal-coach/commitments/${encodeURIComponent(id)}/reschedule`, { plannedFor },
    ),
    routines: async () => (await api.get<{ routines: CoachRoutineDto[] }>(
      "/api/personal-coach/routines?status=active",
    )).routines,
    proposals: async () => (await api.get<{ proposals: CoachProposalDto[] }>("/api/personal-coach/proposals?status=pending")).proposals,
  };
}
