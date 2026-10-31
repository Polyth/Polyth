import { createApiTransport } from "@polyth/web-sdk";

export interface CoachProfileDto {
  tone: "supportive" | "balanced" | "direct";
  initiative: "reactive" | "balanced" | "proactive";
  timeZone: string;
  challengeAssumptions: boolean;
  onboardingState: "new" | "started" | "complete";
  updatedAt: number;
  onboardingCompletedAt?: number;
}

export interface CoachSettingsDto {
  revision: number;
  profile: CoachProfileDto;
}

export type CoachSettingsPatch = Partial<Pick<
  CoachProfileDto,
  "tone" | "initiative" | "timeZone" | "challengeAssumptions"
>>;

export interface CoachResetDto {
  revision: number;
  resetAt: number;
  profile: CoachProfileDto;
}

export interface CoachReminderSettingsDto {
  dailyCheckIn: { enabled: boolean; minuteOfDay: number };
  weeklyReview: { enabled: boolean; day: number; minuteOfDay: number };
  timeZone: string;
}

export interface CoachRemindersDto {
  available: boolean;
  settings?: CoachReminderSettingsDto;
}

export interface CoachReminderPatch {
  dailyCheckIn: boolean;
  dailyMinuteOfDay: number;
  weeklyReview: boolean;
  weeklyDay: number;
  weeklyMinuteOfDay: number;
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
  evidence: Array<{ eventSeq: number }>;
  status: "candidate" | "accepted" | "rejected" | "expired";
  createdAt: number;
  updatedAt: number;
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

export type CoachOccurrenceStatusDto = "done" | "skipped";

export interface CoachDueRoutineDto {
  routine: CoachRoutineDto;
  dateKey: string;
  /** Absent means the day is still open. */
  status?: CoachOccurrenceStatusDto;
}

export interface CoachRoutineOccurrenceDto {
  routineId: string;
  dateKey: string;
  status: CoachOccurrenceStatusDto;
  reason?: string;
  createdAt: number;
}

/**
 * Today, attention and upcoming are separate concepts on the wire, so no
 * component has to guess whether an action belongs to the day it is rendering.
 */
export interface CoachHomeDto {
  revision: number;
  date: string;
  profile: CoachProfileDto;
  today: {
    focus?: CoachCommitmentDto;
    actions: CoachCommitmentDto[];
    total: number;
    routines: CoachDueRoutineDto[];
  };
  attention: {
    overdue: CoachCommitmentDto[];
    overdueTotal: number;
    overloaded: boolean;
  };
  upcoming: {
    next?: CoachCommitmentDto;
    items: CoachCommitmentDto[];
    total: number;
  };
  activeGoals: CoachGoalDto[];
  activeGoalTotal: number;
  checkIn?: CoachCheckInDto;
  insight?: CoachInsightDto;
  suggestionCount: number;
  reviewDue: boolean;
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

export interface CoachApi {
  home(): Promise<CoachHomeDto>;
  settings(): Promise<CoachSettingsDto>;
  updateSettings(patch: CoachSettingsPatch): Promise<CoachProfileDto>;
  resetState(): Promise<CoachResetDto>;
  reminders(): Promise<CoachRemindersDto>;
  updateReminders(patch: CoachReminderPatch): Promise<CoachRemindersDto>;
  completeCommitment(id: string): Promise<CoachCommitmentDto>;
  skipCommitment(id: string, reason?: string): Promise<CoachCommitmentDto>;
  recordCheckIn(input: { energy: number; focus: number; note?: string }): Promise<CoachCheckInDto>;
  createSession(title?: string, options?: CoachSessionOptions): Promise<CoachSessionReply>;
  insight(id: string): Promise<CoachInsightDto>;
  setInsightStatus(id: string, action: "accept" | "reject" | "forget"): Promise<CoachInsightDto>;
  proposal(id: string): Promise<CoachProposalDto>;
  acceptProposal(id: string): Promise<CoachProposalDecisionDto>;
  rejectProposal(id: string): Promise<CoachProposalDecisionDto>;
  resolveRoutineDay(id: string, action: "done" | "skip" | "reopen", reason?: string): Promise<unknown>;
}

export function createCoachApi(): CoachApi {
  const api = createApiTransport();
  const insightPath = (id: string) => `/api/personal-coach/insights/${encodeURIComponent(id)}`;
  const proposalPath = (id: string) => `/api/personal-coach/proposals/${encodeURIComponent(id)}`;
  return {
    home: () => api.get<CoachHomeDto>("/api/personal-coach/home"),
    settings: () => api.get<CoachSettingsDto>("/api/personal-coach/settings"),
    updateSettings: (patch) => api.put<CoachProfileDto>("/api/personal-coach/settings", patch),
    resetState: () => api.post<CoachResetDto>("/api/personal-coach/reset", {}),
    reminders: () => api.get<CoachRemindersDto>("/api/personal-coach/reminders"),
    updateReminders: (patch) => api.put<CoachRemindersDto>("/api/personal-coach/reminders", patch),
    completeCommitment: (id) => api.post<CoachCommitmentDto>(
      `/api/personal-coach/commitments/${encodeURIComponent(id)}/complete`,
      {},
    ),
    skipCommitment: (id, reason) => api.post<CoachCommitmentDto>(
      `/api/personal-coach/commitments/${encodeURIComponent(id)}/skip`,
      reason ? { reason } : {},
    ),
    recordCheckIn: (input) => api.post<CoachCheckInDto>("/api/personal-coach/checkins", input),
    createSession: (title, options) => api.post<CoachSessionReply>(
      "/api/personal-coach/session",
      { ...(title ? { title } : {}), ...options },
    ),
    insight: (id) => api.get<CoachInsightDto>(insightPath(id)),
    setInsightStatus: (id, action) => api.post<CoachInsightDto>(`${insightPath(id)}/${action}`, {}),
    proposal: (id) => api.get<CoachProposalDto>(proposalPath(id)),
    acceptProposal: (id) => api.post<CoachProposalDecisionDto>(`${proposalPath(id)}/accept`, {}),
    rejectProposal: (id) => api.post<CoachProposalDecisionDto>(`${proposalPath(id)}/reject`, {}),
    // The local day is resolved server-side from the Coach time zone, so a
    // stale tab or a travelling device can never resolve the wrong day.
    resolveRoutineDay: (id, action, reason) => api.post<unknown>(
      `/api/personal-coach/routines/${encodeURIComponent(id)}/${action}`,
      reason ? { reason } : {},
    ),
  };
}
