// UX-MOBILE-01 §6/§7/§35: the starter system behind the new-chat quick
// actions. Starters are a real, ordered, user-owned model — not decorative
// hardcoded chips:
//
//   * built-ins ship with the app and can be hidden but never deleted;
//   * the visible chips are CONTEXT-SENSITIVE (dirty worktree, conflicts, a
//     just-finished run, and a clean repo each surface different work);
//   * users pin (favorite), hide, reorder, and create their own;
//   * commands and skills discovered for the project join the same catalog.
//
// Everything that decides ordering or visibility is a pure function so the
// contract is testable without a DOM.
import { useSyncExternalStore } from "react";
import { tr } from "./i18n/index.ts";

/** Icon ids are keys of the one shared icon set (icons.tsx) — never ad-hoc art. */
export type StarterIconId =
  | "target" | "branch" | "files" | "plan" | "book" | "shield" | "term"
  | "pencil" | "search" | "commit" | "check" | "chat" | "puzzle" | "sync"
  | "fileEdit" | "list" | "bookmark";

export type StarterSource = "builtin" | "custom" | "command" | "skill";

export interface Starter {
  /** Stable id: `builtin:*`, `custom:*`, `command:*`, `skill:*`. */
  id: string;
  /** Chip text. Short — it has to survive a 320px viewport. */
  label: string;
  /** Prompt handed to the composer. */
  prompt: string;
  icon: StarterIconId;
  /** One-line explanation shown in the picker (§34). */
  description?: string;
  source: StarterSource;
}

// ---- built-in catalog -------------------------------------------------------

export const BUILTIN_STARTERS: readonly Starter[] = [
  {
    id: "builtin:explore",
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
    label: tr("starters.reviewChanges"),
    prompt: "Review my uncommitted changes: correctness, edge cases, and anything I should clean up before committing.",
    icon: "fileEdit",
    description: tr("starters.readTheWorkingTreeDiffAndReport"),
    source: "builtin",
  },
  {
    id: "builtin:explain-diff",
    label: tr("starters.explainDiff"),
    prompt: "Explain what my current diff does, file by file, in plain language.",
    icon: "files",
    description: tr("starters.narrateTheWorkingTreeDiff"),
    source: "builtin",
  },
  {
    id: "builtin:fix-tests",
    label: tr("starters.fixFailingTests"),
    prompt: "Run the test suite, find what fails, and fix the failures.",
    icon: "check",
    description: tr("starters.runTestsAndRepairWhatBreaks"),
    source: "builtin",
  },
  {
    id: "builtin:commit",
    label: tr("starters.commitChanges"),
    prompt: "Stage my changes and write a commit message that explains why, not just what.",
    icon: "commit",
    description: tr("starters.prepareACleanCommit"),
    source: "builtin",
  },
  {
    id: "builtin:resolve-conflicts",
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
    label: tr("starters.debugAnIssue"),
    prompt: "Help me debug an issue: ask for the symptom, form hypotheses, and test them one at a time.",
    icon: "term",
    description: tr("starters.workABugDownToItsCause"),
    source: "builtin",
  },
  {
    id: "builtin:debt",
    label: tr("starters.findTechDebt"),
    prompt: "Find the technical debt that actually hurts here and rank it by payoff.",
    icon: "shield",
    description: tr("starters.rankTheDebtWorthPayingDown"),
    source: "builtin",
  },
  {
    id: "builtin:architecture",
    label: tr("starters.understandArchitecture"),
    prompt: "Explain the architecture of this project: boundaries, data flow, and the rules a change has to respect.",
    icon: "book",
    description: tr("starters.mapTheStructureAndItsRules"),
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
}

export const EMPTY_STARTER_CONTEXT: StarterContext = {
  changedFiles: 0,
  conflicted: 0,
  ahead: 0,
  hasHistory: false,
  lastTurnFinished: false,
};

/**
 * Ordered built-in ids for a workspace state (§35/§49). Pure and total: the
 * clean-repo list always terminates the sequence, so callers can slice any
 * length and still get sensible starters.
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
  push("builtin:explore", "builtin:plan-feature", "builtin:debt", "builtin:architecture", "builtin:weigh-options", "builtin:debug");
  return ids;
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

// ---- preferences ------------------------------------------------------------

export interface CustomStarter {
  id: string;
  label: string;
  prompt: string;
  icon: StarterIconId;
}

export interface StarterPrefs {
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

export const STARTER_PREFS_DEFAULTS: StarterPrefs = { pinned: [], hidden: [], recents: [], custom: [] };

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

export function customToStarter(custom: CustomStarter): Starter {
  return { id: custom.id, label: custom.label, prompt: custom.prompt, icon: custom.icon, source: "custom" };
}

/** Everything selectable, by id — built-ins, customs, commands, skills. */
export function starterIndex(prefs: StarterPrefs, input: StarterCatalogInput = {}): Map<string, Starter> {
  const index = new Map<string, Starter>(BUILTIN_BY_ID);
  for (const custom of prefs.custom) index.set(custom.id, customToStarter(custom));
  for (const command of input.commands ?? []) index.set(`command:${command.name}`, commandStarter(command));
  for (const skill of input.skills ?? []) index.set(`skill:${skill.name}`, skillStarter(skill));
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
    { id: tr("starters.builtin"), title: tr("starters.builtIn"), starters: [...BUILTIN_STARTERS] },
    { id: tr("starters.custom"), title: tr("starters.custom2"), starters: prefs.custom.map(customToStarter) },
    { id: tr("starters.skills"), title: tr("starters.skills2"), starters: (input.skills ?? []).map(skillStarter) },
    { id: tr("starters.commands"), title: tr("starters.commands2"), starters: (input.commands ?? []).map(commandStarter) },
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

const read = (): string | null => {
  try { return localStorage.getItem(STARTER_PREFS_KEY); } catch { return null; }
};
const write = (value: string): void => {
  try { localStorage.setItem(STARTER_PREFS_KEY, value); } catch { /* private mode */ }
};

let prefs: StarterPrefs = parseStarterPrefs(read());
const listeners = new Set<() => void>();

function commit(next: StarterPrefs): void {
  prefs = next;
  write(serializeStarterPrefs(prefs));
  for (const listener of [...listeners]) listener();
}

export function getStarterPrefs(): StarterPrefs {
  return prefs;
}

export function toggleStarterPinned(id: string): void {
  commit(togglePinned(prefs, id));
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
