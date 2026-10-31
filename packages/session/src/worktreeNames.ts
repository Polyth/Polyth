// Pure, browser-safe names for ordinary linked worktrees. Temporary names are
// deliberately recognizable: the Git package may replace one after the model
// supplies the session's semantic title, while never touching user branches.

export const TEMPORARY_WORKTREE_PREFIX = "temp/";

const TEMPORARY_CODENAMES = [
  "red-panther",
  "iron-dawn",
  "silver-orbit",
  "quiet-comet",
  "cobalt-fox",
  "amber-signal",
  "polar-engine",
  "crimson-vector",
  "neon-harbor",
  "granite-sparrow",
  "velvet-circuit",
  "lunar-forge",
  "rapid-badger",
  "frozen-beacon",
  "carbon-raven",
  "golden-pulse",
] as const;
const TEMPORARY_CODENAME_SET = new Set<string>(TEMPORARY_CODENAMES);

export function worktreeSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "") || "session";
}

const normalizedBranches = (taken: readonly string[]): Set<string> =>
  new Set(taken.map((branch) => branch.replace(/^refs\/heads\//, "")));

/** Human-readable codename plus digits. The caller supplies all known branch
 * names, making fast repeated taps collision-safe even with a deterministic
 * random source in tests. */
export function randomWorktreeSlug(
  taken: readonly string[] = [],
  random: () => number = Math.random,
  now: () => number = Date.now,
): string {
  const used = normalizedBranches(taken);
  const firstName = Math.floor(random() * TEMPORARY_CODENAMES.length);
  const firstDigits = Math.floor(random() * 9_000);
  for (let attempt = 0; attempt < TEMPORARY_CODENAMES.length * 2; attempt += 1) {
    const name = TEMPORARY_CODENAMES[(firstName + attempt) % TEMPORARY_CODENAMES.length]!;
    const digits = 1_000 + ((firstDigits + attempt) % 9_000);
    const slug = `${name}-${digits}`;
    if (!used.has(`${TEMPORARY_WORKTREE_PREFIX}${slug}`) && !used.has(slug)) return slug;
  }
  const fallback = `project-${now().toString(36)}`;
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const slug = `${fallback}-${String(suffix).padStart(4, "0")}`;
    if (!used.has(`${TEMPORARY_WORKTREE_PREFIX}${slug}`) && !used.has(slug)) return slug;
  }
  return `${fallback}-${Math.floor(random() * 1_000_000).toString().padStart(6, "0")}`;
}

export function temporaryWorktreeBranch(
  taken: readonly string[] = [],
  random: () => number = Math.random,
  now: () => number = Date.now,
): string {
  return `${TEMPORARY_WORKTREE_PREFIX}${randomWorktreeSlug(taken, random, now)}`;
}

export function isTemporaryWorktreeBranch(branch: string | null | undefined): branch is string {
  if (!branch?.startsWith(TEMPORARY_WORKTREE_PREFIX)) return false;
  const match = /^temp\/(.+)-(\d{4})$/.exec(branch);
  return !!match && TEMPORARY_CODENAME_SET.has(match[1]!);
}

const semanticPrefix = (title: string): string => {
  const value = title.toLowerCase();
  if (/\b(fix|bug|crash|error|broken|repair|regression|hotfix)\b/.test(value)) return "fix";
  if (/\b(doc|docs|readme|guide|copy|wording)\b/.test(value)) return "docs";
  if (/\b(refactor|cleanup|restructure|simplif)\w*\b/.test(value)) return "refactor";
  if (/\b(test|spec|coverage)\b/.test(value)) return "test";
  if (/\b(perf|performance|speed|latency|optimi[sz])\w*\b/.test(value)) return "perf";
  if (/\b(ci|pipeline|workflow)\b/.test(value)) return "ci";
  if (/\b(build|bundle|compile|dependency|dependencies)\b/.test(value)) return "build";
  if (/\b(chore|maintenance|upgrade|bump)\b/.test(value)) return "chore";
  return "feat";
};

/** Turn the model-generated session title into a conventional branch name. */
export function semanticWorktreeBranch(title: string, taken: readonly string[]): string {
  const used = normalizedBranches(taken);
  const prefix = semanticPrefix(title);
  const subject = title.replace(
    /^(?:fix|repair|resolve|add|implement|create|build|update|improve|refactor|test|document|docs?|chore)\b[\s:–—-]*/i,
    "",
  );
  const base = `${prefix}/${worktreeSlug(subject || title)}`.slice(0, 120).replace(/[-/]+$/g, "");
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base.slice(0, 115 - String(suffix).length)}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 106)}-${Date.now().toString(36)}`;
}
