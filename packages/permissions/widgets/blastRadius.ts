import { describeBlastRadius, type BlastRadius, type BlastRadiusEffect } from "../src/risk.ts";
import type { PendingPermission } from "../../../apps/web/src/reduce.ts";

/** `tr`-shaped: returns the key itself for a message it does not know. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface BlastRadiusLine {
  text: string;
  /** `text` split around its target, so the card can set the path, branch or
   * statement apart (monospace, isolated left-to-right inside RTL copy).
   * Absent when the message names no target. */
  target?: { before: string; value: string; after: string };
  /** Where it lands, and whether anything narrows it. */
  notes: string[];
}

/** A path inside one of the workspace roots, shown relative to it: the root
 * itself is long and the same for every line. */
function displayTarget(target: string, roots: readonly string[]): string {
  for (const root of roots) {
    const base = root.replace(/[\\/]+$/, "");
    if (!base) continue;
    if (target === base) return ".";
    if (target.startsWith(`${base}/`) || target.startsWith(`${base}\\`)) return target.slice(base.length + 1) || ".";
  }
  return target;
}

const TARGET_MARK = "\u2063TARGET\u2063";

const known = (translate: Translate, key: string, vars?: Record<string, string | number>): string | undefined => {
  const text = translate(key, vars);
  return text && text !== key ? text : undefined;
};

/** Localized labels for the server's stable high-risk reason codes. Unknown
 * codes from a newer server are skipped rather than shown raw. */
export function riskReasonLabels(reasons: readonly unknown[] | undefined, translate: Translate): string[] {
  const labels: string[] = [];
  for (const reason of reasons ?? []) {
    if (typeof reason !== "string") continue;
    const label = known(translate, `permissionbanner.reason.${reason}`);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** "Outside the task · 86%" when the Judgment second opinion held a routine
 * request (reason code `outside-task`); the percentage is shown only when the
 * preview carries a valid one. */
export function outsideTaskLabel(preview: { reasons?: readonly unknown[] } | undefined, translate: Translate): string | undefined {
  if (!preview?.reasons?.includes("outside-task")) return undefined;
  const probability = (preview as { scopeCheck?: { probability?: unknown } }).scopeCheck?.probability;
  if (typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1) {
    return known(translate, "permissionbanner.outsideTask", { percent: Math.round(probability * 100) });
  }
  return known(translate, "permissionbanner.reason.outside-task");
}

function effectKey(effect: BlastRadiusEffect): string | undefined {
  switch (effect.kind) {
    case "delete":
      if (effect.target === undefined) return "permissionbanner.blast.deleteFromInput";
      return effect.recursive ? "permissionbanner.blast.deleteRecursive" : "permissionbanner.blast.delete";
    case "discard-changes": return "permissionbanner.blast.discardChanges";
    case "discard-untracked": return effect.ignored ? "permissionbanner.blast.discardUntrackedIgnored" : "permissionbanner.blast.discardUntracked";
    case "delete-branch":
      if (effect.target === undefined) return effect.remote ? "permissionbanner.blast.pruneRemoteBranches" : undefined;
      return effect.remote ? "permissionbanner.blast.deleteRemoteBranch" : "permissionbanner.blast.deleteBranch";
    case "drop-stash": return effect.target === undefined ? "permissionbanner.blast.dropAllStashes" : "permissionbanner.blast.dropStash";
    case "rewrite-history": return "permissionbanner.blast.rewriteHistory";
    case "push":
      if (effect.unbounded) return "permissionbanner.blast.mirrorPush";
      return effect.target === undefined ? "permissionbanner.blast.forcePushCurrent" : "permissionbanner.blast.forcePush";
    case "write": return "permissionbanner.blast.write";
    case "permissions": return effect.recursive ? "permissionbanner.blast.permissionsRecursive" : "permissionbanner.blast.permissions";
    case "database": return "permissionbanner.blast.database";
    case "infrastructure": return "permissionbanner.blast.infrastructure";
    case "upload": return "permissionbanner.blast.upload";
    default: return undefined;
  }
}

/** One readable line per effect. Unknown kinds or scopes (a newer module) are
 * skipped, never shown raw. */
export function blastRadiusLines(radius: BlastRadius, translate: Translate, workspaceRoots: readonly string[] = []): BlastRadiusLine[] {
  const lines: BlastRadiusLine[] = [];
  for (const effect of radius.effects) {
    const key = effectKey(effect);
    if (!key) continue;
    const remote = effect.remote ?? known(translate, "permissionbanner.blast.upstream") ?? "";
    const target = effect.target === undefined ? "" : displayTarget(effect.target, workspaceRoots);
    const text = known(translate, key, { target, remote });
    if (!text) continue;
    const marked = target ? translate(key, { target: TARGET_MARK, remote }).split(TARGET_MARK) : [];
    const notes: string[] = [];
    // A push names its remote in the text; a workspace path needs no note
    // unless it is the whole workspace.
    if (effect.scope && effect.scope !== "workspace") {
      const scope = known(translate, `permissionbanner.blast.scope.${effect.scope}`);
      if (scope) notes.push(scope);
    }
    // Mirror pushes, pruning and "every stash" already say so in their text.
    const saysAll = effect.kind === "push" || effect.kind === "drop-stash" || (effect.kind === "delete-branch" && effect.target === undefined);
    if (effect.unbounded && !saysAll) {
      const unbounded = known(translate, "permissionbanner.blast.unbounded");
      if (unbounded) notes.push(unbounded);
    }
    lines.push(marked.length === 2
      ? { text, target: { before: marked[0]!, value: target, after: marked[1]! }, notes }
      : { text, notes });
  }
  if (radius.truncated) {
    const more = known(translate, "permissionbanner.blast.more");
    if (more) lines.push({ text: more, notes: [] });
  }
  return lines;
}

/** The roots a session may change, as far as the client knows them: its
 * runtime directory and isolated worktree. Without one, absolute paths count
 * as outside, as on the server. */
export function sessionWorkspaceRoots(session: {
  worktreePath?: string;
  runtimeBinding?: { location?: { directory?: string } };
} | undefined): string[] {
  const roots = [session?.runtimeBinding?.location?.directory, session?.worktreePath]
    .filter((root): root is string => typeof root === "string" && root.length > 0);
  return [...new Set(roots)];
}

/** Blast-radius lines for a high-risk card, computed from the request it
 * shows. Empty for anything else. */
export function permissionBlastRadius(
  p: Pick<PendingPermission, "permission" | "patterns" | "tool" | "preview">,
  workspaceRoots: readonly string[],
  translate: Translate,
): BlastRadiusLine[] {
  if (p.preview?.risk !== "high") return [];
  const radius = describeBlastRadius(
    { permission: p.permission, patterns: p.patterns, ...(p.tool ? { tool: p.tool } : {}) },
    { workspaceRoots },
  );
  return blastRadiusLines(radius, translate, workspaceRoots);
}
