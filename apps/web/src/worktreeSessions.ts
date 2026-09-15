// Pure branch-name helpers for worktree-backed sessions.
import { worktreeSlug } from "@polyth/session/worktree-names";

export {
  isTemporaryWorktreeBranch,
  randomWorktreeSlug,
  semanticWorktreeBranch,
  temporaryWorktreeBranch,
  worktreeSlug,
} from "@polyth/session/worktree-names";

function safeBranch(raw: string): string {
  const parts = raw
    .split("/")
    .map((part) => worktreeSlug(part))
    .filter(Boolean);
  return (parts.join("/") || "feat/session").slice(0, 120).replace(/[-/]+$/g, "") || "feat/session";
}

export function suggestWorktreeBranch(
  template: string,
  title: string,
  taken: readonly string[],
  now = new Date(),
): string {
  const date = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  ].join("-");
  const source = template.trim() || "feat/{slug}";
  const base = safeBranch(source.replaceAll("{slug}", worktreeSlug(title)).replaceAll("{date}", date));
  const used = new Set(taken.map((branch) => branch.replace(/^refs\/heads\//, "")));
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base.slice(0, 115 - String(suffix).length)}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 102)}-${now.getTime()}`;
}

export function worktreeLabel(branch: string | null | undefined, path: string): string {
  return branch || path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "worktree";
}
