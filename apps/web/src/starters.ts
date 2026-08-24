// Quick starters for the fresh-session hero (UX-MOBILE-01 §3/§35): a small
// catalog of one-tap prompts whose suggestions follow the real workspace
// state — a dirty worktree offers review/commit work, a clean one offers
// exploration and planning. Pins and custom starters persist locally
// (pure UI preference; never in the session event log).
import { useSyncExternalStore } from "react";
import type { GitStatus } from "./api.ts";

export interface Starter {
  id: string;
  label: string;
  prompt: string;
  description?: string;
  /** StarterIcon key (see components/mobile/StarterPicker.tsx). */
  icon: string;
}

/** Workspace signals that select which suggestions fit right now. */
export interface StarterContext {
  dirty: boolean;
  hasHistory: boolean;
  lastTurnFinished: boolean;
}

export interface StarterPrefs {
  pinned: string[];
  custom: Starter[];
  used: Record<string, number>;
}

interface CatalogStarter extends Starter {
  /** Omitted = fits every context. */
  fits?: (context: StarterContext) => boolean;
}

export const STARTER_CATALOG: readonly CatalogStarter[] = [
  {
    id: "review-changes",
    label: "Review my changes",
    prompt: "Review my uncommitted changes and point out problems or risky spots before I commit.",
    description: "Walk the pending diff before committing",
    icon: "diff",
    fits: (context) => context.dirty,
  },
  {
    id: "commit-message",
    label: "Write a commit message",
    prompt: "Look at the staged and unstaged changes and draft a clear, conventional commit message.",
    description: "Summarize the pending diff",
    icon: "commit",
    fits: (context) => context.dirty,
  },
  {
    id: "continue-work",
    label: "Continue where I left off",
    prompt: "Look at the current uncommitted changes and continue the work in progress.",
    description: "Pick the in-progress work back up",
    icon: "resume",
    fits: (context) => context.dirty || context.hasHistory,
  },
  {
    id: "explore-code",
    label: "Explore the codebase",
    prompt: "Give me a guided tour of this codebase: the main packages, how they fit together, and where to start reading.",
    description: "Orient in an unfamiliar project",
    icon: "explore",
    fits: (context) => !context.dirty,
  },
  {
    id: "plan-feature",
    label: "Plan a feature",
    prompt: "Help me plan a new feature: I'll describe it, then break it into concrete implementation steps for this codebase.",
    description: "Turn an idea into implementation steps",
    icon: "plan",
    fits: (context) => !context.dirty,
  },
  {
    id: "fix-bug",
    label: "Fix a bug",
    prompt: "Help me track down a bug: I'll describe the symptom, then let's find the root cause and fix it.",
    description: "Hypothesis-driven debugging",
    icon: "bug",
  },
  {
    id: "improve-tests",
    label: "Improve test coverage",
    prompt: "Find the weakest-tested parts of this project and add focused tests for them.",
    description: "Strengthen the safety net",
    icon: "tests",
    fits: (context) => !context.dirty,
  },
];

export const STARTER_PREFS_KEY = "polyth.starters.v1";

const EMPTY_PREFS: StarterPrefs = { pinned: [], custom: [], used: {} };

export function parseStarterPrefs(raw: string | null): StarterPrefs {
  if (!raw) return EMPTY_PREFS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return EMPTY_PREFS;
    const record = parsed as Record<string, unknown>;
    const pinned = Array.isArray(record.pinned)
      ? record.pinned.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    const custom = Array.isArray(record.custom)
      ? record.custom.filter((entry): entry is Starter =>
          typeof entry === "object" && entry !== null
          && typeof (entry as Starter).id === "string" && (entry as Starter).id.length > 0
          && typeof (entry as Starter).label === "string"
          && typeof (entry as Starter).prompt === "string"
          && typeof (entry as Starter).icon === "string")
      : [];
    const used: Record<string, number> = {};
    if (typeof record.used === "object" && record.used !== null && !Array.isArray(record.used)) {
      for (const [id, count] of Object.entries(record.used as Record<string, unknown>)) {
        if (id && typeof count === "number" && Number.isFinite(count) && count > 0) used[id] = count;
      }
    }
    return { pinned, custom, used };
  } catch {
    return EMPTY_PREFS;
  }
}

const read = (): string | null => {
  try { return localStorage.getItem(STARTER_PREFS_KEY); } catch { return null; }
};
const write = (value: string): void => {
  try { localStorage.setItem(STARTER_PREFS_KEY, value); } catch { /* private mode */ }
};

let prefs: StarterPrefs = parseStarterPrefs(read());
const listeners = new Set<() => void>();

const commit = (next: StarterPrefs): void => {
  prefs = next;
  write(JSON.stringify(prefs));
  for (const listener of [...listeners]) listener();
};

export function getStarterPrefs(): StarterPrefs {
  return prefs;
}

export function useStarterPrefs(): StarterPrefs {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    },
    getStarterPrefs,
    getStarterPrefs,
  );
}

export function toggleStarterPinned(id: string): void {
  const pinned = prefs.pinned.includes(id)
    ? prefs.pinned.filter((candidate) => candidate !== id)
    : [...prefs.pinned, id];
  commit({ ...prefs, pinned });
}

/** Adds a user-authored starter and pins it so it shows up immediately. */
export function addCustomStarter(input: Omit<Starter, "id">): Starter {
  const starter: Starter = { ...input, id: `custom-${Date.now().toString(36)}` };
  commit({
    ...prefs,
    custom: [...prefs.custom, starter],
    pinned: [...prefs.pinned, starter.id],
  });
  return starter;
}

export function removeCustomStarter(id: string): void {
  commit({
    ...prefs,
    custom: prefs.custom.filter((starter) => starter.id !== id),
    pinned: prefs.pinned.filter((candidate) => candidate !== id),
  });
}

/** Usage counts break suggestion ties toward what this person actually taps. */
export function noteStarterUsed(id: string): void {
  commit({ ...prefs, used: { ...prefs.used, [id]: (prefs.used[id] ?? 0) + 1 } });
}

export function starterContextFrom(
  status: GitStatus | null,
  session: { hasHistory: boolean; lastTurnFinished: boolean },
): StarterContext {
  const dirty = status !== null
    && status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length > 0;
  return { dirty, hasHistory: session.hasHistory, lastTurnFinished: session.lastTurnFinished };
}

export function allStarters(prefs: StarterPrefs): Starter[] {
  return [...STARTER_CATALOG, ...prefs.custom];
}

/** Chips for the hero: pinned first (in pin order), then context-fitting
 *  suggestions ordered by personal usage, capped at `max`. */
export function visibleStarters(
  prefs: StarterPrefs,
  context: StarterContext,
  max: number,
): Starter[] {
  const byId = new Map<string, CatalogStarter>();
  for (const starter of STARTER_CATALOG) byId.set(starter.id, starter);
  for (const starter of prefs.custom) byId.set(starter.id, starter);

  const result: Starter[] = [];
  for (const id of prefs.pinned) {
    const starter = byId.get(id);
    if (starter && result.length < max) result.push(starter);
  }
  const suggestions = STARTER_CATALOG
    .filter((starter) => !prefs.pinned.includes(starter.id))
    .filter((starter) => starter.fits === undefined || starter.fits(context))
    .sort((a, b) => (prefs.used[b.id] ?? 0) - (prefs.used[a.id] ?? 0));
  for (const starter of suggestions) {
    if (result.length >= max) break;
    result.push(starter);
  }
  return result;
}
