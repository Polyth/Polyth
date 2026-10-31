// The starter system behind the new-chat quick
// actions. Starters are a real, ordered, user-owned model — not decorative
// hardcoded chips:
//
//   * built-ins ship with the app and can be hidden but never deleted;
//   * the visible chips are CONTEXT-SENSITIVE (dirty worktree, conflicts, a
//     just-finished run, and a clean repo each surface different work);
//   * users pin (favorite), hide, reorder, and create their own;
//   * commands and skills discovered for the project join the same catalog;
//   * every package that opens a window joins it too: pinning one puts a
//     chip on the new chat that opens that window instead of a prompt.
//
// Everything that decides ordering or visibility is a pure function so the
// contract is testable without a DOM.
import { useSyncExternalStore } from "react";
import type { ProjectDirection } from "@polyth/contracts/project-composition";
import { tr } from "./i18n/index.ts";
import { getState, subscribeStore } from "./store.ts";

/** Icon ids are keys of the one shared icon set (icons.tsx) — never ad-hoc art. */
export type StarterIconId =
  | "target" | "branch" | "files" | "plan" | "book" | "shield" | "term"
  | "pencil" | "search" | "commit" | "check" | "chat" | "puzzle" | "sync"
  | "fileEdit" | "list" | "bookmark";

export type StarterSource = "builtin" | "custom" | "command" | "skill" | "package";

export interface Starter {
  /** Stable id: `builtin:*`, `custom:*`, `command:*`, `skill:*`, `package:*`. */
  id: string;
  /** Chip text. Short — it has to survive a 320px viewport. */
  label: string;
  /** Prompt handed to the composer. Empty for package windows. */
  prompt: string;
  icon: StarterIconId;
  /** One-line explanation shown in the picker (§34). */
  description?: string;
  source: StarterSource;
  /** Project directions this built-in suits. Absent = every project. */
  directions?: readonly ProjectDirection[];
  /** Package windows: the capability whose window the chip opens. */
  capabilityId?: string;
}

// ---- built-in catalog -------------------------------------------------------
//
// Built-ins are grouped by project direction (the project's "type"). Code and
// git work only makes sense in engineering projects; research and operations
// get their own small sets; the remaining directions keep just the universal
// starters and users author whatever else they need.

const ENGINEERING: readonly ProjectDirection[] = ["engineering"];

export const BUILTIN_STARTERS: readonly Starter[] = [
  {
    id: "builtin:explore",
    directions: ENGINEERING,
    label: tr("starters.exploreCodebase"),
    prompt: "Explore this codebase and give me a short tour: entry points, main modules, and how they fit together.",
    icon: "search",
    description: tr("starters.getOrientedInAnUnfamiliarProject"),
    source: "builtin",
  },
  {
    id: "builtin:catch-up",
    label: tr("starters.catchMeUp"),
    prompt: "Catch me up on what changed recently in this project and what is still in flight.",
    icon: "sync",
    description: tr("starters.summarizeRecentWorkAndOpenThreads"),
    source: "builtin",
  },
  {
    id: "builtin:review-changes",
    directions: ENGINEERING,
    label: tr("starters.reviewChanges"),
    prompt: "Review my uncommitted changes: correctness, edge cases, and anything I should clean up before committing.",
    icon: "fileEdit",
    description: tr("starters.readTheWorkingTreeDiffAndReport"),
    source: "builtin",
  },
  {
    id: "builtin:explain-diff",
    directions: ENGINEERING,
    label: tr("starters.explainDiff"),
    prompt: "Explain what my current diff does, file by file, in plain language.",
    icon: "files",
    description: tr("starters.narrateTheWorkingTreeDiff"),
    source: "builtin",
  },
  {
    id: "builtin:fix-tests",
    directions: ENGINEERING,
    label: tr("starters.fixFailingTests"),
    prompt: "Run the test suite, find what fails, and fix the failures.",
    icon: "check",
    description: tr("starters.runTestsAndRepairWhatBreaks"),
    source: "builtin",
  },
  {
    id: "builtin:commit",
    directions: ENGINEERING,
    label: tr("starters.commitChanges"),
    prompt: "Stage my changes and write a commit message that explains why, not just what.",
    icon: "commit",
    description: tr("starters.prepareACleanCommit"),
    source: "builtin",
  },
  {
    id: "builtin:resolve-conflicts",
    directions: ENGINEERING,
    label: tr("starters.resolveConflicts"),
    prompt: "Walk through the merge conflicts in this worktree and resolve them, explaining each decision.",
    icon: "branch",
    description: tr("starters.workThroughConflictedFiles"),
    source: "builtin",
  },
  {
    id: "builtin:review-result",
    label: tr("starters.reviewResult"),
    prompt: "Review what you just produced: what changed, what is still missing, and what could break.",
    icon: "list",
    description: tr("starters.auditTheAgentSLastPieceOf"),
    source: "builtin",
  },
  {
    id: "builtin:continue",
    label: tr("starters.continueWork"),
    prompt: "Continue where we left off — restate the plan first, then take the next step.",
    icon: "sync",
    description: tr("starters.resumeThePreviousTask"),
    source: "builtin",
  },
  {
    id: "builtin:plan-feature",
    directions: ENGINEERING,
    label: tr("starters.planAFeature"),
    prompt: "Help me plan a feature: clarify the goal, list the steps, and flag the risky parts before any code.",
    icon: "plan",
    description: tr("starters.turnAnIdeaIntoAConcretePlan"),
    source: "builtin",
  },
  {
    id: "builtin:weigh-options",
    label: tr("starters.weighMyOptions"),
    prompt: "I need to choose between a few approaches. Lay out the trade-offs and recommend one.",
    icon: "target",
    description: tr("starters.compareApproachesAndPickOne"),
    source: "builtin",
  },
  {
    id: "builtin:debug",
    directions: ENGINEERING,
    label: tr("starters.debugAnIssue"),
    prompt: "Help me debug an issue: ask for the symptom, form hypotheses, and test them one at a time.",
    icon: "term",
    description: tr("starters.workABugDownToItsCause"),
    source: "builtin",
  },
  {
    id: "builtin:debt",
    directions: ENGINEERING,
    label: tr("starters.findTechDebt"),
    prompt: "Find the technical debt that actually hurts here and rank it by payoff.",
    icon: "shield",
    description: tr("starters.rankTheDebtWorthPayingDown"),
    source: "builtin",
  },
  {
    id: "builtin:architecture",
    directions: ENGINEERING,
    label: tr("starters.understandArchitecture"),
    prompt: "Explain the architecture of this project: boundaries, data flow, and the rules a change has to respect.",
    icon: "book",
    description: tr("starters.mapTheStructureAndItsRules"),
    source: "builtin",
  },
  {
    id: "builtin:research-question",
    directions: ["research"],
    label: tr("starters.researchAQuestion"),
    prompt: "Help me research a question: clarify what I want to know, find credible sources, and summarize what they agree and disagree on.",
    icon: "search",
    description: tr("starters.findAndWeighSourcesOnATopic"),
    source: "builtin",
  },
  {
    id: "builtin:summarize-sources",
    directions: ["research"],
    label: tr("starters.summarizeSources"),
    prompt: "Summarize the material in this project: key findings, open questions, and where the evidence is thin.",
    icon: "book",
    description: tr("starters.condenseNotesAndDocumentsIntoFindings"),
    source: "builtin",
  },
  {
    id: "builtin:write-runbook",
    directions: ["operations"],
    label: tr("starters.writeARunbook"),
    prompt: "Help me write a runbook for a recurring procedure: preconditions, exact steps, checks, and how to roll back.",
    icon: "list",
    description: tr("starters.turnAProcedureIntoRepeatableSteps"),
    source: "builtin",
  },
  {
    id: "builtin:triage-incident",
    directions: ["operations"],
    label: tr("starters.triageAnIncident"),
    prompt: "Help me triage an incident: establish impact, timeline, and likely cause, then propose the next safe action.",
    icon: "shield",
    description: tr("starters.workOutImpactCauseAndNextStep"),
    source: "builtin",
  },
];

const BUILTIN_BY_ID = new Map(BUILTIN_STARTERS.map((starter) => [starter.id, starter]));

// ---- context-sensitive selection -------------------------------------------

export interface StarterContext {
  /** Files with any working-tree change (staged + unstaged + untracked). */
  changedFiles: number;
  /** Conflicted paths in the current worktree. */
  conflicted: number;
  /** Commits ahead of the upstream branch. */
  ahead: number;
  /** The session already holds messages. */
  hasHistory: boolean;
  /** The agent finished a turn in this session (nothing running now). */
  lastTurnFinished: boolean;
  /** Directions of the active project. Absent/empty = general project: every
   * built-in fits, as before directions existed. */
  directions?: readonly ProjectDirection[];
  /** The personal project: a plain private folder, not a codebase, so only
   * the PERSONAL_STARTERS built-ins fit. */
  personal?: boolean;
}

export const EMPTY_STARTER_CONTEXT: StarterContext = {
  changedFiles: 0,
  conflicted: 0,
  ahead: 0,
  hasHistory: false,
  lastTurnFinished: false,
};

/** Built-ins that suit the personal project, where there is no codebase or
 *  Git history to explore: everyday questions and decisions. */
const PERSONAL_STARTERS: ReadonlySet<string> = new Set([
  "builtin:research-question", "builtin:weigh-options", "builtin:continue", "builtin:review-result",
]);

/** Whether a starter belongs to a project with these directions. Multiple
 * directions are a union; only built-ins carry direction metadata. */
export function starterFitsProject(
  starter: Starter,
  directions: readonly ProjectDirection[] | undefined,
  personal = false,
): boolean {
  if (personal) return PERSONAL_STARTERS.has(starter.id);
  return !directions?.length || !starter.directions?.length
    || starter.directions.some((direction) => directions.includes(direction));
}

/** Direction-specific starters that lead the clean-workspace suggestions. */
const DIRECTION_LEADS: Partial<Record<ProjectDirection, readonly string[]>> = {
  research: ["builtin:research-question", "builtin:summarize-sources"],
  operations: ["builtin:triage-incident", "builtin:write-runbook"],
};

/**
 * Ordered built-in ids for a workspace state (§35/§49). Pure and total: the
 * clean-repo list always terminates the sequence, so callers can slice any
 * length and still get sensible starters. Ids that do not fit the project's
 * directions are dropped.
 */
export function contextualStarterIds(context: StarterContext): string[] {
  const ids: string[] = [];
  const push = (...candidates: string[]) => {
    for (const id of candidates) if (!ids.includes(id)) ids.push(id);
  };
  if (context.conflicted > 0) push("builtin:resolve-conflicts", "builtin:review-changes");
  if (context.lastTurnFinished) push("builtin:review-result", "builtin:continue");
  if (context.changedFiles > 0) push("builtin:review-changes", "builtin:fix-tests", "builtin:commit", "builtin:explain-diff");
  if (context.ahead > 0) push("builtin:catch-up");
  if (context.hasHistory) push("builtin:continue");
  if (context.personal) push("builtin:research-question", "builtin:weigh-options");
  for (const direction of context.directions ?? []) push(...DIRECTION_LEADS[direction] ?? []);
  push("builtin:explore", "builtin:plan-feature", "builtin:debt", "builtin:architecture", "builtin:weigh-options", "builtin:debug");
  push("builtin:catch-up");
  return ids.filter((id) => {
    const starter = BUILTIN_BY_ID.get(id);
    return starter !== undefined && starterFitsProject(starter, context.directions, context.personal);
  });
}

/** Working-tree counts → starter context. Keeps git shape out of components. */
export function starterContextFrom(
  status: {
    staged?: unknown[]; unstaged?: unknown[]; untracked?: unknown[]; conflicted?: unknown[]; ahead?: number;
  } | null | undefined,
  session: { hasHistory: boolean; lastTurnFinished: boolean },
): StarterContext {
  return {
    changedFiles: (status?.staged?.length ?? 0) + (status?.unstaged?.length ?? 0) + (status?.untracked?.length ?? 0),
    conflicted: status?.conflicted?.length ?? 0,
    ahead: status?.ahead ?? 0,
    hasHistory: session.hasHistory,
    lastTurnFinished: session.lastTurnFinished,
  };
}

/** Session-history inputs for `starterContextFrom`. Kept pure so every picker
 * entry point ranks the canonical catalog from the same replay-derived truth. */
export function starterSessionContext(session: {
  messages: readonly unknown[];
  turn: { status: "working" | "stopped" | "aborted" | "failed" } | null;
}): { hasHistory: boolean; lastTurnFinished: boolean } {
  return {
    hasHistory: session.messages.length > 0,
    lastTurnFinished: session.turn?.status === "stopped",
  };
}

// ---- preferences ------------------------------------------------------------

export interface CustomStarter {
  id: string;
  label: string;
  prompt: string;
  icon: StarterIconId;
}

export interface StarterPrefs {
  /** Apply this configuration to every project instead of only the active one. */
  shared: boolean;
  /** Pinned starters, in the user's drag order. They lead the chip row. */
  pinned: string[];
  /** Built-ins the user removed from suggestions. Never deleted, only hidden. */
  hidden: string[];
  /** Most-recently used first. */
  recents: string[];
  custom: CustomStarter[];
}

export const STARTER_PREFS_KEY = "polyth.starters.v1";
export const STARTER_RECENTS_MAX = 8;
export const STARTER_CUSTOM_MAX = 64;

export const STARTER_PREFS_DEFAULTS: StarterPrefs = { shared: false, pinned: [], hidden: [], recents: [], custom: [] };

export function starterPrefsStorageKey(projectId: string): string {
  return `${STARTER_PREFS_KEY}.${projectId}`;
}

const ICON_IDS: readonly StarterIconId[] = [
  "target", "branch", "files", "plan", "book", "shield", "term",
  "pencil", "search", "commit", "check", "chat", "puzzle", "sync",
  "fileEdit", "list", "bookmark",
];

export function isStarterIcon(value: unknown): value is StarterIconId {
  return typeof value === "string" && ICON_IDS.includes(value as StarterIconId);
}

const strings = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item !== ""))].slice(0, max)
    : [];

export function parseStarterPrefs(raw: string | null): StarterPrefs {
  try {
    const data = JSON.parse(raw ?? "") as Partial<StarterPrefs>;
    const custom = Array.isArray(data.custom)
      ? data.custom
          .filter((item): item is CustomStarter =>
            !!item && typeof item.id === "string" && typeof item.label === "string" && typeof item.prompt === "string")
          .map((item) => ({
            id: item.id,
            label: item.label.slice(0, 40),
            prompt: item.prompt.slice(0, 4000),
            icon: isStarterIcon(item.icon) ? item.icon : "bookmark",
          }))
          .slice(0, STARTER_CUSTOM_MAX)
      : [];
    return {
      shared: data.shared === true,
      pinned: strings(data.pinned, 32),
      hidden: strings(data.hidden, 64),
      recents: strings(data.recents, STARTER_RECENTS_MAX),
      custom,
    };
  } catch {
    return { ...STARTER_PREFS_DEFAULTS };
  }
}

export function serializeStarterPrefs(prefs: StarterPrefs): string {
  return JSON.stringify(prefs);
}

// ---- pure prefs transitions -------------------------------------------------

export function togglePinned(prefs: StarterPrefs, id: string): StarterPrefs {
  const pinned = prefs.pinned.includes(id)
    ? prefs.pinned.filter((item) => item !== id)
    : [...prefs.pinned, id];
  return { ...prefs, pinned, hidden: prefs.hidden.filter((item) => item !== id) };
}

export function setHidden(prefs: StarterPrefs, id: string, hidden: boolean): StarterPrefs {
  return {
    ...prefs,
    hidden: hidden
      ? [...new Set([...prefs.hidden, id])]
      : prefs.hidden.filter((item) => item !== id),
    pinned: hidden ? prefs.pinned.filter((item) => item !== id) : prefs.pinned,
  };
}

export function recordStarterUse(prefs: StarterPrefs, id: string): StarterPrefs {
  return { ...prefs, recents: [id, ...prefs.recents.filter((item) => item !== id)].slice(0, STARTER_RECENTS_MAX) };
}

/** Move `dragged` in front of `target` inside the pinned order (§27). */
export function reorderPinned(prefs: StarterPrefs, dragged: string, target: string): StarterPrefs {
  if (dragged === target || !prefs.pinned.includes(dragged) || !prefs.pinned.includes(target)) return prefs;
  const pinned = prefs.pinned.filter((item) => item !== dragged);
  pinned.splice(pinned.indexOf(target), 0, dragged);
  return { ...prefs, pinned };
}

export function withCustomStarter(prefs: StarterPrefs, starter: CustomStarter): StarterPrefs {
  const custom = prefs.custom.some((item) => item.id === starter.id)
    ? prefs.custom.map((item) => (item.id === starter.id ? starter : item))
    : [...prefs.custom, starter].slice(0, STARTER_CUSTOM_MAX);
  return { ...prefs, custom };
}

export function withoutCustomStarter(prefs: StarterPrefs, id: string): StarterPrefs {
  return {
    ...prefs,
    custom: prefs.custom.filter((item) => item.id !== id),
    pinned: prefs.pinned.filter((item) => item !== id),
    recents: prefs.recents.filter((item) => item !== id),
  };
}

// ---- catalog + visible chips ------------------------------------------------

export interface StarterCatalogInput {
  /** Project slash commands discovered for the composer. */
  commands?: Array<{ name: string; description?: string }>;
  /** Skills/snippets available in the workspace. */
  skills?: Array<{ name: string; description?: string }>;
  /** Capabilities that open a package window. */
  packages?: StarterPackage[];
}

export interface StarterPackage {
  /** Capability id. */
  id: string;
  label: string;
  description?: string;
}

export function commandStarter(command: { name: string; description?: string }): Starter {
  return {
    id: `command:${command.name}`,
    label: `/${command.name}`,
    prompt: `/${command.name}`,
    icon: "term",
    ...(command.description ? { description: command.description } : {}),
    source: "command",
  };
}

export function skillStarter(skill: { name: string; description?: string }): Starter {
  return {
    id: `skill:${skill.name}`,
    label: skill.name,
    prompt: `#${skill.name}`,
    icon: "puzzle",
    ...(skill.description ? { description: skill.description } : {}),
    source: "skill",
  };
}

export const PACKAGE_STARTER_PREFIX = "package:";

export function packageStarter(pkg: StarterPackage): Starter {
  return {
    id: `${PACKAGE_STARTER_PREFIX}${pkg.id}`,
    label: pkg.label,
    prompt: "",
    icon: "puzzle",
    ...(pkg.description ? { description: pkg.description } : {}),
    source: "package",
    capabilityId: pkg.id,
  };
}

export function customToStarter(custom: CustomStarter): Starter {
  return { id: custom.id, label: custom.label, prompt: custom.prompt, icon: custom.icon, source: "custom" };
}

/** Everything selectable, by id — built-ins, customs, commands, skills,
 *  package windows. A pinned id whose source is absent right now (a package
 *  not loaded or not relevant to this project) simply does not resolve. */
export function starterIndex(prefs: StarterPrefs, input: StarterCatalogInput = {}): Map<string, Starter> {
  const index = new Map<string, Starter>(BUILTIN_BY_ID);
  for (const custom of prefs.custom) index.set(custom.id, customToStarter(custom));
  for (const command of input.commands ?? []) index.set(`command:${command.name}`, commandStarter(command));
  for (const skill of input.skills ?? []) index.set(`skill:${skill.name}`, skillStarter(skill));
  for (const pkg of input.packages ?? []) index.set(`${PACKAGE_STARTER_PREFIX}${pkg.id}`, packageStarter(pkg));
  return index;
}

/**
 * The chips shown under the empty state: pinned first (user intent wins),
 * then context-sensitive suggestions, hidden ids removed, deduplicated and
 * clipped to `limit`.
 */
export function visibleStarters(
  prefs: StarterPrefs,
  context: StarterContext,
  limit: number,
  input: StarterCatalogInput = {},
): Starter[] {
  const index = starterIndex(prefs, input);
  const ordered: Starter[] = [];
  const take = (id: string) => {
    if (prefs.hidden.includes(id) || ordered.some((item) => item.id === id)) return;
    const starter = index.get(id);
    if (starter) ordered.push(starter);
  };
  for (const id of prefs.pinned) take(id);
  for (const id of contextualStarterIds(context)) take(id);
  return ordered.slice(0, Math.max(0, limit));
}

/** Named picker categories, in display order (§48). Empty groups are dropped. */
export function starterCategories(
  prefs: StarterPrefs,
  context: StarterContext,
  input: StarterCatalogInput = {},
): Array<{ id: string; title: string; starters: Starter[] }> {
  const index = starterIndex(prefs, input);
  const resolve = (ids: readonly string[]): Starter[] =>
    ids.map((id) => index.get(id)).filter((item): item is Starter => item !== undefined);
  const groups = [
    { id: tr("starters.favorites"), title: tr("starters.favorites2"), starters: resolve(prefs.pinned) },
    { id: tr("starters.recent"), title: tr("starters.recent2"), starters: resolve(prefs.recents.filter((id) => !prefs.pinned.includes(id))) },
    { id: tr("starters.suggested"), title: tr("starters.suggestedHere"), starters: resolve(contextualStarterIds(context).slice(0, 4)) },
    // Every built-in stays pinnable; the ones fitting this project come first.
    { id: tr("starters.builtin"), title: tr("starters.builtIn"), starters: [
      ...BUILTIN_STARTERS.filter((starter) => starterFitsProject(starter, context.directions, context.personal)),
      ...BUILTIN_STARTERS.filter((starter) => !starterFitsProject(starter, context.directions, context.personal)),
    ] },
    { id: tr("starters.custom"), title: tr("starters.custom2"), starters: prefs.custom.map(customToStarter) },
    { id: tr("starters.skills"), title: tr("starters.skills2"), starters: (input.skills ?? []).map(skillStarter) },
    { id: tr("starters.commands"), title: tr("starters.commands2"), starters: (input.commands ?? []).map(commandStarter) },
    { id: "packages", title: tr("starters.packageWindows"), starters: (input.packages ?? []).map(packageStarter) },
  ];
  return groups.filter((group) => group.starters.length > 0);
}

/** Case-insensitive filter across label, description, and prompt. */
export function matchesStarter(starter: Starter, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return [starter.label, starter.description ?? "", starter.prompt]
    .some((text) => text.toLowerCase().includes(q));
}

// ---- reactive store ---------------------------------------------------------

function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function read(projectId: string | null): StarterPrefs {
  const globalRaw = readStored(STARTER_PREFS_KEY);
  const globalPrefs = parseStarterPrefs(globalRaw);
  if (globalRaw !== null && globalPrefs.shared) return globalPrefs;
  if (projectId === null) return globalPrefs;

  const projectRaw = readStored(starterPrefsStorageKey(projectId));
  return projectRaw === null
    ? globalPrefs
    : { ...parseStarterPrefs(projectRaw), shared: false };
}

const write = (key: string, value: string): void => {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
};
const remove = (key: string): void => {
  try { localStorage.removeItem(key); } catch { /* private mode */ }
};

let activeProjectId = getState().activeProjectId;
let prefs: StarterPrefs = read(activeProjectId);
const listeners = new Set<() => void>();

function commit(next: StarterPrefs): void {
  prefs = next;
  if (prefs.shared) {
    write(STARTER_PREFS_KEY, serializeStarterPrefs(prefs));
  } else if (activeProjectId !== null) {
    write(starterPrefsStorageKey(activeProjectId), serializeStarterPrefs(prefs));
  }
  for (const listener of [...listeners]) listener();
}

subscribeStore(() => {
  const nextProjectId = getState().activeProjectId;
  if (nextProjectId === activeProjectId) return;
  activeProjectId = nextProjectId;
  prefs = read(activeProjectId);
  for (const listener of [...listeners]) listener();
});

export function getStarterPrefs(): StarterPrefs {
  return prefs;
}

export function toggleStarterPinned(id: string): void {
  commit(togglePinned(prefs, id));
}

export function setStarterShared(shared: boolean): void {
  if (prefs.shared === shared) return;
  if (!shared) remove(STARTER_PREFS_KEY);
  commit({ ...prefs, shared });
}

export function setStarterHidden(id: string, hidden: boolean): void {
  commit(setHidden(prefs, id, hidden));
}

export function noteStarterUsed(id: string): void {
  commit(recordStarterUse(prefs, id));
}

export function reorderStarters(dragged: string, target: string): void {
  commit(reorderPinned(prefs, dragged, target));
}

export function newCustomStarterId(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `custom:${random}`;
}

export function saveCustomStarter(starter: CustomStarter): void {
  commit(togglePinnedOnCreate(withCustomStarter(prefs, starter), starter.id));
}

/** A starter the user just authored is theirs: it joins the pinned row. */
function togglePinnedOnCreate(next: StarterPrefs, id: string): StarterPrefs {
  return next.pinned.includes(id) ? next : { ...next, pinned: [...next.pinned, id] };
}

export function deleteCustomStarter(id: string): void {
  commit(withoutCustomStarter(prefs, id));
}

export function useStarterPrefs(): StarterPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getStarterPrefs,
    getStarterPrefs,
  );
}
