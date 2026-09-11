// Repository worktree topology changes without asking us: an agent runs
// `git worktree add`, a shell removes one, another app prunes. Rather than
// watch every registered repository or poll on a timer, ride along on the Git
// interactions the UI already makes and compare a cheap fingerprint.
import { stat } from "node:fs/promises";
import { join } from "node:path";

/** Git keeps one administrative directory per linked worktree under the
 *  repository's git dir, so that parent directory's mtime moves whenever a
 *  worktree is added, removed or pruned. One stat, no process spawn.
 *
 *  `none` covers both "no linked worktrees yet" and "this path is itself a
 *  linked worktree" (whose `.git` is a file). Callers must therefore always
 *  fingerprint a project's main checkout, never a session's worktree, or the
 *  value would flap between a real reading and `none`. */
export async function worktreeTopologyFingerprint(root: string): Promise<string> {
  try {
    const st = await stat(join(root, ".git", "worktrees"));
    return String(st.mtimeMs);
  } catch {
    return "none";
  }
}

export interface WorktreeTopologyWatch {
  /** Compare `root`'s topology against the last reading for `projectId` and
   *  report a change. The first reading only records: a server that has never
   *  looked has not observed a change, and must not announce one. */
  observe(projectId: string, root: string): Promise<void>;
  /** Record the current topology WITHOUT reporting — for a change this server
   *  just made and already announced, so the next observation is not a
   *  duplicate announcement of the same event. */
  settle(projectId: string, root: string): Promise<void>;
  forget(projectId: string): void;
}

/** Tracks the last seen fingerprint per project. Bounded by the number of
 *  registered projects (one short string each), so it needs no eviction — a
 *  project that goes away is forgotten explicitly. */
export function createWorktreeTopologyWatch(
  onChange: (projectId: string) => void,
): WorktreeTopologyWatch {
  const seen = new Map<string, string>();
  return {
    async observe(projectId, root) {
      if (!projectId) return;
      const now = await worktreeTopologyFingerprint(root);
      const before = seen.get(projectId);
      seen.set(projectId, now);
      if (before !== undefined && before !== now) onChange(projectId);
    },
    async settle(projectId, root) {
      if (!projectId) return;
      seen.set(projectId, await worktreeTopologyFingerprint(root));
    },
    forget(projectId) {
      seen.delete(projectId);
    },
  };
}
