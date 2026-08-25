/**
 * Canonical English messages owned by the goals package. Every other locale
 * in this directory is checked against these keys.
 */
export const en = {
  "goalstrip.attachAnObjectiveFromTheSessionActions": "Attach an objective from the session actions to track progress here.",
  "goalstrip.attachGoal": "Attach goal",
  "goalstrip.attaching": "Attaching…",
  "goalstrip.closeGoalDialog": "Close goal dialog",
  "goalstrip.cont": "cont",
  "goalstrip.couldnTAttachTheGoal": "Couldn’t attach the goal.",
  "goalstrip.goal": "Goal",
  "goalstrip.maxContinuations": "Max continuations",
  "goalstrip.message": "×",
  "goalstrip.noGoalAttached": "No goal attached",
  "goalstrip.objective": "Objective",
  "goalstrip.optional": "Optional",
  "goalstrip.polythWillKeepTheObjectiveAndIts": "Polyth will keep the objective and its limits visible while the agent works.",
  "goalstrip.sessionGoal": "Session goal",
  "goalstrip.setAClearSessionGoal": "Set a clear session goal",
  "goalstrip.tok": "tok",
  "goalstrip.tokenBudget": "Token budget",
  "goalstrip.verdict": "verdict:",
  "goalstrip.whatShouldThisSessionAccomplishOneItem": "What should this session accomplish? One item per line becomes a checklist.",
  "goalsview.attachAnObjectiveAndLetTheAuditor": "Attach an objective and let the auditor drive continuations to completion.",
  "goalsview.attachGoal": "Attach goal",
  "goalsview.auditTrail": "Audit trail",
  "goalsview.continuations": "Continuations",
  "goalsview.giveThisSessionAnObjectivePolythKeeps": "Give this session an objective — Polyth keeps working until it is met.",
  "goalsview.lastVerdict": "Last verdict",
  "goalsview.noAuditsYetTheAuditorRunsAfter": "No audits yet — the auditor runs after each continuation.",
  "goalsview.noGoalYet": "No goal yet",
  "goalsview.noSessionOpen": "No session open",
  "goalsview.objective": "Objective",
  "goalsview.openASessionToAttachAGoal": "Open a session to attach a goal.",
  "goalsview.sessionGoals": "Session goals",
  "goalsview.status": "Status",
  "goalsview.tokenBudget": "Token budget",
  "goalsview.tokens": "Tokens",
} as const;

export type GoalsMessageKey = keyof typeof en;
export type GoalsMessages = Record<GoalsMessageKey, string>;
