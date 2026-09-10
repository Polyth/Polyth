import { createApiTransport } from "@polyth/web-sdk";

export interface CoachProfileDto {
  tone: "supportive" | "balanced" | "direct";
  initiative: "reactive" | "balanced" | "proactive";
  timeZone: string;
  challengeAssumptions: boolean;
  onboardingState: "new" | "started" | "complete";
  updatedAt: number;
}

export interface CoachGoalDto {
  id: string;
  areaId?: string;
  title: string;
  desiredOutcome?: string;
  why?: string;
  status: "active" | "paused" | "completed" | "cancelled";
  priority: 1 | 2 | 3;
  targetAt?: number;
}

export interface CoachCommitmentDto {
  id: string;
  goalId?: string;
  title: string;
  status: "open" | "done" | "skipped" | "cancelled";
  plannedFor?: number;
  dueAt?: number;
  estimateMinutes?: number;
  lastReason?: string;
}

export interface CoachRoutineDto {
  id: string;
  goalId?: string;
  title: string;
  cadence:
    | { kind: "daily" }
    | { kind: "weekly"; days: number[] }
    | { kind: "interval"; everyDays: number };
  preferredMinuteOfDay?: number;
  status: "active" | "paused" | "archived";
}

export interface CoachCheckInDto {
  id: string;
  energy: number;
  focus: number;
  note?: string;
  createdAt: number;
}

export interface CoachInsightDto {
  id: string;
  statement: string;
  confidence: "low" | "medium" | "high";
  status: "candidate" | "accepted" | "rejected" | "expired";
}

export interface CoachHomeDto {
  revision: number;
  date: string;
  profile: CoachProfileDto;
  activeGoals: CoachGoalDto[];
  today: {
    mainFocus?: CoachCommitmentDto;
    commitments: CoachCommitmentDto[];
    overflowCount: number;
    overdueCount: number;
    dueRoutines: CoachRoutineDto[];
  };
  nextAction?: CoachCommitmentDto;
  lastCheckIn?: CoachCheckInDto;
  insight?: CoachInsightDto;
  attention?: { kind: "overdue" | "overloaded"; count: number };
  reviewDue: boolean;
}

export interface CoachApi {
  home(): Promise<CoachHomeDto>;
  completeCommitment(id: string): Promise<CoachCommitmentDto>;
  skipCommitment(id: string, reason?: string): Promise<CoachCommitmentDto>;
  recordCheckIn(input: { energy: number; focus: number; note?: string }): Promise<CoachCheckInDto>;
  createSession(title?: string): Promise<{ sessionId: string }>;
}

export function createCoachApi(): CoachApi {
  const api = createApiTransport();
  return {
    home: () => api.get<CoachHomeDto>("/api/personal-coach/home"),
    completeCommitment: (id) => api.post<CoachCommitmentDto>(
      `/api/personal-coach/commitments/${encodeURIComponent(id)}/complete`,
      {},
    ),
    skipCommitment: (id, reason) => api.post<CoachCommitmentDto>(
      `/api/personal-coach/commitments/${encodeURIComponent(id)}/skip`,
      reason ? { reason } : {},
    ),
    recordCheckIn: (input) => api.post<CoachCheckInDto>("/api/personal-coach/checkins", input),
    createSession: (title) => api.post<{ sessionId: string }>(
      "/api/personal-coach/session",
      title ? { title } : {},
    ),
  };
}
