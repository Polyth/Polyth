import { useEffect, useState } from "react";
import { api, type GithubStatusDto } from "@polyth/session/web-api";

/** The GitHub account behind the user menu's picture. */
export type ProfileAccount = NonNullable<GithubStatusDto["user"]>;

export interface ProfileAccountTiming {
  /** A window that returns to the foreground asks again once its answer is this old. */
  refreshMs: number;
  /** An empty answer is asked once more after this, and again on return to the foreground. */
  retryMs: number;
  now: () => number;
}

export const PROFILE_ACCOUNT_TIMING: ProfileAccountTiming = { refreshMs: 5 * 60_000, retryMs: 45_000, now: Date.now };

/**
 * Who is signed in to GitHub for this project's header avatar. The server
 * answers from its per-account memory without a repository lookup, so asking is
 * cheap: it is done when the project changes, once more after an empty answer
 * (gh may have been unreachable for a moment) and when a window left in the
 * background comes back.
 *
 * Only the first answer for a project may remove the avatar. Later answers
 * only replace it: a dropped connection or a slow `gh` must not turn a known
 * avatar into the placeholder, and an answer for a project that is no longer
 * current is ignored.
 */
export function useProfileAccount(projectId: string | null, timing: ProfileAccountTiming = PROFILE_ACCOUNT_TIMING): ProfileAccount | null {
  const [user, setUser] = useState<ProfileAccount | null>(null);
  useEffect(() => {
    if (!projectId) {
      setUser(null);
      return;
    }
    let stale = false;
    let asking = false;
    let answered = false;
    let known = false;
    let retried = false;
    let askedAt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const ask = () => {
      if (asking) return;
      asking = true;
      askedAt = timing.now();
      void api.githubStatus(projectId, true).then((status) => {
        asking = false;
        if (stale) return;
        const next = status.authenticated ? status.user : null;
        if (next) {
          known = true;
          retried = false;
          setUser(next);
        } else if (!answered) {
          setUser(null);
        }
        answered = true;
        if (!next && !known && !retried) {
          retried = true;
          retry = setTimeout(ask, timing.retryMs);
        }
      });
    };
    const returned = () => {
      if (document.visibilityState === "hidden") return;
      if (timing.now() - askedAt >= (known ? timing.refreshMs : timing.retryMs)) ask();
    };

    ask();
    document.addEventListener("visibilitychange", returned);
    window.addEventListener("focus", returned);
    return () => {
      stale = true;
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", returned);
      window.removeEventListener("focus", returned);
    };
  }, [projectId, timing]);
  return user;
}
