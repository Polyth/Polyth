// The personal project (`Project.personal`): a person's private, non-Git
// folder in Space storage that lets a new account start chatting without
// choosing a folder first. The server owns it (POST /api/projects/personal);
// this module holds the shell's pure reading of it.
//
// While the personal project is the ONLY project in the registry the shell is
// "projectless": no project row or rail icon in the Navigator, no project or
// branch picker above the composer, no project name in the greeting and no
// code-only starters. Adding a real project turns it back into an ordinary
// project group.
import type { Project } from "@polyth/contracts";

export const isPersonalProject = (project: Pick<Project, "personal"> | null | undefined): boolean =>
  project?.personal === true;

/** The personal project when it is the only one, else null. */
export function soloPersonalProject<T extends Pick<Project, "personal">>(projects: readonly T[]): T | null {
  return projects.length === 1 && isPersonalProject(projects[0]) ? projects[0]! : null;
}

/** What a Personal project's tablet shortcut rail ends with. */
export const PERSONAL_TRAILING_SHORTCUTS: readonly string[] = ["notification-centre", "settings"];

/** A Personal project's tablet shortcuts: the launchers its own rails carry,
 *  in `resolved` order (anything it keeps under More stays there), then
 *  Notifications and Settings once each — not the account's pinned set,
 *  which belongs to project work (Git, Terminal…). */
export function personalShortcutIds(
  resolved: readonly { id: string; tier: string }[],
  isLauncher: (id: string) => boolean,
): string[] {
  return [
    ...resolved
      .filter(({ id, tier }) => tier !== "technical" && isLauncher(id) && !PERSONAL_TRAILING_SHORTCUTS.includes(id))
      .map(({ id }) => id),
    ...PERSONAL_TRAILING_SHORTCUTS,
  ];
}

// ---- per-document first-run attempt ---------------------------------------------

let attempted = false;

/** First caller per document wins: a refused or failed request falls back to
 *  the folder picker instead of retrying on every project refresh. */
export function claimPersonalProjectAttempt(): boolean {
  if (attempted) return false;
  attempted = true;
  return true;
}

/** Test seam only. */
export function resetPersonalProjectAttemptForTest(): void {
  attempted = false;
}
