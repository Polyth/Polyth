// Starter judges: basic, ready-made settings a Space starts from. They are a
// starting point, not a recommendation: Polyth adds the seeded ones to a Space
// that never saved a judge, switched off and owned by no one, and offers every
// template again in "Add judge". Turning one on makes the person who did it
// its owner (its actions use their access); any other edit makes it their own
// judge. Browser-safe: the server seeds from it and the page builds drafts from
// it, both in the person's language through the package's own i18n keys.
import type { JudgmentJudgesMessageKey } from "./i18n/en.ts";
import { MESSAGE_PRESETS, type JudgeInput } from "./types.ts";

/** What a judge is about; the list and the template gallery group and mark judges by it. */
export type JudgeCategory = "permissions" | "actions" | "long-work" | "quality" | "limits" | "attention";
export type StarterText = (key: JudgmentJudgesMessageKey) => string;

export interface StarterTemplate {
  id: string;
  category: JudgeCategory;
  /** Added to a Space that never saved a judge. Templates that need the person's own choices (models) are only offered. */
  seeded: boolean;
  build(t: StarterText): JudgeInput;
}

const presetText = (id: (typeof MESSAGE_PRESETS)[number]["id"]) => MESSAGE_PRESETS.find((entry) => entry.id === id)!.text;
const base = { enabled: false, filters: {} } as const;

/**
 * Evaluation follows this order, so the guard that denies runs before the one
 * that approves: a destructive request is refused before anything could let it
 * through.
 */
export const STARTERS: readonly StarterTemplate[] = [
  {
    id: "stop-destructive", category: "permissions", seeded: true,
    build: (t) => ({ ...base, name: t("judgesstarter.stopDestructive.name"), description: t("judgesstarter.stopDestructive.description"),
      trigger: "permission-requested",
      evidence: [{ pick: "permission-request", maxChars: 1_500 }, { pick: "last-request", maxChars: 800 }],
      question: { type: "choice", text: t("judgesstarter.stopDestructive.question"), labels: [
        { label: "destructive", description: t("judgesstarter.stopDestructive.destructive") },
        { label: "harmless", description: t("judgesstarter.stopDestructive.harmless") },
      ] },
      fire: { label: "destructive", threshold: 0.8, margin: 0.3 },
      effects: [{ kind: "needs-attention" }, { kind: "deny-request", when: "destructive" }],
      dailyCap: 60 }),
  },
  {
    id: "approve-routine", category: "permissions", seeded: true,
    build: (t) => ({ ...base, name: t("judgesstarter.approveRoutine.name"), description: t("judgesstarter.approveRoutine.description"),
      trigger: "permission-requested",
      evidence: [{ pick: "permission-request", maxChars: 1_500 }, { pick: "last-request", maxChars: 1_200 }],
      question: { type: "choice", text: t("judgesstarter.approveRoutine.question"), labels: [
        { label: "routine", description: t("judgesstarter.approveRoutine.routine") },
        { label: "needs_look", description: t("judgesstarter.approveRoutine.needsLook") },
      ] },
      fire: { threshold: 0.9, margin: 0.4 },
      effects: [{ kind: "approve-request", when: "routine" }],
      dailyCap: 60 }),
  },
  {
    id: "review-commands", category: "actions", seeded: true,
    build: (t) => ({ ...base, name: t("judgesstarter.reviewCommands.name"), description: t("judgesstarter.reviewCommands.description"),
      trigger: "turn-completed",
      evidence: [{ pick: "last-request", maxChars: 600 }, { pick: "commands-run", maxChars: 2_000 }, { pick: "changed-files", maxChars: 1_000 }],
      question: { type: "noul", text: t("judgesstarter.reviewCommands.question") },
      fire: { threshold: 0.8, margin: 0.3 },
      effects: [{ kind: "needs-attention" }],
      dailyCap: 40 }),
  },
  {
    id: "keep-going", category: "long-work", seeded: true,
    build: (t) => ({ ...base, name: t("judgesstarter.keepGoing.name"), description: t("judgesstarter.keepGoing.description"),
      trigger: "turn-completed",
      evidence: [{ pick: "last-request", maxChars: 800 }, { pick: "last-answer", maxChars: 1_500 }, { pick: "open-todos", maxChars: 600 }],
      question: { type: "choice", text: t("judgesstarter.keepGoing.question"), labels: [
        { label: "unfinished", description: t("judgesstarter.keepGoing.unfinished") },
        { label: "finished", description: t("judgesstarter.keepGoing.finished") },
        { label: "needs_person", description: t("judgesstarter.keepGoing.needsPerson") },
      ] },
      fire: { threshold: 0.8, margin: 0.3 },
      effects: [{ kind: "send-message", text: presetText("continue"), when: "unfinished" }],
      maxRounds: 3, dailyCap: 40 }),
  },
  {
    id: "stay-on-task", category: "quality", seeded: true,
    build: (t) => ({ ...base, name: t("judgesstarter.stayOnTask.name"), description: t("judgesstarter.stayOnTask.description"),
      trigger: "turn-completed",
      evidence: [{ pick: "last-request", maxChars: 800 }, { pick: "changed-files", maxChars: 1_500 }],
      question: { type: "noul", text: t("judgesstarter.stayOnTask.question") },
      fire: { threshold: 0.8, margin: 0.3 },
      effects: [{ kind: "timeline-marker" }, { kind: "suggest-follow-up", text: t("judgesstarter.stayOnTask.followUp") }],
      dailyCap: 40 }),
  },
  {
    id: "merge-when-done", category: "actions", seeded: false,
    build: (t) => ({ ...base, name: t("judgesstarter.mergeWhenDone.name"), description: t("judgesstarter.mergeWhenDone.description"),
      trigger: "turn-completed",
      evidence: [{ pick: "last-request", maxChars: 800 }, { pick: "last-answer", maxChars: 1_500 }, { pick: "commands-run", maxChars: 1_500 }],
      question: { type: "choice", text: t("judgesstarter.mergeWhenDone.question"), labels: [
        { label: "done", description: t("judgesstarter.mergeWhenDone.done") },
        { label: "not_done", description: t("judgesstarter.mergeWhenDone.notDone") },
      ] },
      fire: { threshold: 0.9, margin: 0.4 },
      effects: [{ kind: "merge-isolated", when: "done" }],
      dailyCap: 40 }),
  },
  {
    id: "audit-big-changes", category: "quality", seeded: false,
    build: (t) => ({ ...base, name: t("judgesstarter.auditBigChanges.name"), description: t("judgesstarter.auditBigChanges.description"),
      trigger: "turn-completed",
      evidence: [{ pick: "last-request", maxChars: 800 }, { pick: "commands-run", maxChars: 1_000 }, { pick: "changed-files", maxChars: 1_500 }],
      question: { type: "choice", text: t("judgesstarter.auditBigChanges.question"), labels: [
        { label: "big", description: t("judgesstarter.auditBigChanges.big") },
        { label: "small", description: t("judgesstarter.auditBigChanges.small") },
      ] },
      fire: { threshold: 0.8, margin: 0.3 },
      effects: [{ kind: "send-message", text: presetText("audit"), when: "big" }],
      maxRounds: 1, dailyCap: 20 }),
  },
  {
    id: "switch-at-limit", category: "limits", seeded: false,
    build: (t) => ({ ...base, name: t("judgesstarter.switchAtLimit.name"), description: t("judgesstarter.switchAtLimit.description"),
      trigger: "limit-reached",
      evidence: [{ pick: "last-request", maxChars: 600 }],
      question: { type: "route", text: t("judgesstarter.switchAtLimit.question") },
      fire: { threshold: 0.7, margin: 0.2 },
      effects: [{ kind: "switch-route" }],
      routes: [], dailyCap: 20 }),
  },
];

export const starterById = (id: string | undefined): StarterTemplate | undefined => STARTERS.find((starter) => starter.id === id);
export const isStarterId = (value: unknown): value is string => typeof value === "string" && STARTERS.some((starter) => starter.id === value);
