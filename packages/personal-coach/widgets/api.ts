import { createApiTransport } from "@polyth/web-sdk";

export interface CoachProfileDto {
  tone: "supportive" | "balanced" | "direct";
  initiative: "reactive" | "balanced" | "proactive";
  timeZone: string;
  challengeAssumptions: boolean;
  onboardingState: "new" | "started" | "complete";
  updatedAt: number;
}

export interface CoachSettingsDto {
  revision: number;
  profile: CoachProfileDto;
}

export type CoachSettingsPatch = Partial<Pick<
  CoachProfileDto,
  "tone" | "initiative" | "timeZone" | "challengeAssumptions"
>>;

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

export interface CoachProposalDto {
  id: string;
  type: "goal" | "commitment" | "routine" | "plan-change";
  payload: Record<string, unknown>;
  reason?: string;
  status: "pending" | "accepted" | "rejected" | "expired";
  sourceSessionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CoachProposalApplicationDto {
  type: "goal" | "commitment" | "routine" | "plan";
  id: string;
  appliedAt: number;
}

export interface CoachProposalDecisionDto {
  proposal: CoachProposalDto;
  application?: CoachProposalApplicationDto;
}

export interface CoachPlanDto {
  id: string;
  goalId?: string;
  title: string;
  currentRevision: number;
  createdAt: number;
  updatedAt: number;
}

export interface CoachPlanDetailDto extends CoachPlanDto {
  revisions: Array<{
    revision: number;
    summary: string;
    patch: Record<string, unknown>;
    sourceProposalId?: string;
    createdAt: number;
  }>;
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
  settings(): Promise<CoachSettingsDto>;
  updateSettings(patch: CoachSettingsPatch): Promise<CoachProfileDto>;
  completeCommitment(id: string): Promise<CoachCommitmentDto>;
  skipCommitment(id: string, reason?: string): Promise<CoachCommitmentDto>;
  recordCheckIn(input: { energy: number; focus: number; note?: string }): Promise<CoachCheckInDto>;
  createSession(title?: string): Promise<{ sessionId: string }>;
  proposal(id: string): Promise<CoachProposalDto>;
  acceptProposal(id: string): Promise<CoachProposalDecisionDto>;
  rejectProposal(id: string): Promise<CoachProposalDecisionDto>;
  plans(): Promise<CoachPlanDto[]>;
  plan(id: string): Promise<CoachPlanDetailDto>;
}

export function createCoachApi(): CoachApi {
  const api = createApiTransport();
  const proposalPath = (id: string) => `/api/personal-coach/proposals/${encodeURIComponent(id)}`;
  return {
    home: () => api.get<CoachHomeDto>("/api/personal-coach/home"),
    settings: () => api.get<CoachSettingsDto>("/api/personal-coach/settings"),
    updateSettings: (patch) => api.put<CoachProfileDto>("/api/personal-coach/settings", patch),
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
    proposal: (id) => api.get<CoachProposalDto>(proposalPath(id)),
    acceptProposal: (id) => api.post<CoachProposalDecisionDto>(`${proposalPath(id)}/accept`, {}),
    rejectProposal: (id) => api.post<CoachProposalDecisionDto>(`${proposalPath(id)}/reject`, {}),
    plans: async () => (await api.get<{ plans: CoachPlanDto[] }>("/api/personal-coach/plans")).plans,
    plan: (id) => api.get<CoachPlanDetailDto>(`/api/personal-coach/plans/${encodeURIComponent(id)}`),
  };
}
