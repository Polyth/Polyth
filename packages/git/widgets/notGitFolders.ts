import { useSyncExternalStore } from "react";

/**
 * Checkout folders a status read has reported as not a Git repository, for
 * this page's lifetime. Source control uses it to skip a multi-repository
 * project's plain root folder; a later read that finds Git there (after
 * `git init`, say) clears the mark again.
 */
let paths: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

const publish = (next: ReadonlySet<string>) => {
  paths = next;
  for (const listener of listeners) listener();
};

export function markGitFolder(path: string, isRepo: boolean): void {
  if (!path || paths.has(path) === !isRepo) return;
  const next = new Set(paths);
  if (isRepo) next.delete(path);
  else next.add(path);
  publish(next);
}

export function notGitFolders(): ReadonlySet<string> {
  return paths;
}

export function useNotGitFolders(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    notGitFolders,
    notGitFolders,
  );
}
