import { createApiTransport } from "@polyth/web-sdk";
import type {
  CoachApi, CoachCommitmentDto, CoachGoalDto, CoachProfileDto,
  CoachProposalDto,
} from "./api.ts";

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

export interface CoachSessionOptions {
  resume?: boolean;
  text?: string;
  timeZone?: string;
}
export interface CoachSessionReply {
  sessionId: string;
  resumed?: boolean;
  startError?: string;
}

/** Extends the existing transport; no duplicate state, polling or chat engine. */
export interface CoachJourneyApi extends CoachApi {
  createSession(title?: string, options?: CoachSessionOptions): Promise<CoachSessionReply>;
  finishSetup(input: CoachSetupPreferences): Promise<CoachProfileDto>;
  goals(): Promise<CoachGoalDto[]>;
  createGoal(input: { title: string; desiredOutcome?: string }): Promise<CoachGoalDto>;
  updateGoal(id: string, patch: Partial<Pick<CoachGoalDto, "title" | "desiredOutcome" | "status">>): Promise<CoachGoalDto>;
  commitments(goalId?: string): Promise<CoachCommitmentDto[]>;
  createCommitment(input: { title: string; goalId?: string; plannedFor: number }): Promise<CoachCommitmentDto>;
  rescheduleCommitment(id: string, plannedFor: number): Promise<CoachCommitmentDto>;
  proposals(): Promise<CoachProposalDto[]>;
}

export function createCoachJourneyApi(base: CoachApi): CoachJourneyApi {
  const api = createApiTransport();
  return {
    ...base,
    createSession: (title, options) => api.post<CoachSessionReply>("/api/personal-coach/session", {
      ...(title ? { title } : {}), ...options,
    }),
    finishSetup: (input) => api.post<CoachProfileDto>("/api/personal-coach/setup", input),
    goals: async () => (await api.get<{ goals: CoachGoalDto[] }>("/api/personal-coach/goals")).goals,
    createGoal: (input) => api.post<CoachGoalDto>("/api/personal-coach/goals", input),
    updateGoal: (id, patch) => api.patch<CoachGoalDto>(`/api/personal-coach/goals/${encodeURIComponent(id)}`, patch),
    commitments: async (goalId) => (await api.get<{ commitments: CoachCommitmentDto[] }>(
      `/api/personal-coach/commitments?status=open&limit=100${goalId ? `&goalId=${encodeURIComponent(goalId)}` : ""}`,
    )).commitments,
    createCommitment: (input) => api.post<CoachCommitmentDto>("/api/personal-coach/commitments", input),
    rescheduleCommitment: (id, plannedFor) => api.post<CoachCommitmentDto>(
      `/api/personal-coach/commitments/${encodeURIComponent(id)}/reschedule`, { plannedFor },
    ),
    proposals: async () => (await api.get<{ proposals: CoachProposalDto[] }>("/api/personal-coach/proposals?status=pending")).proposals,
  };
}
