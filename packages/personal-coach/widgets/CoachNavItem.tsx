import { useSyncExternalStore } from "react";
import { coachNavStatus } from "./navStatus.ts";
import type { CoachClient } from "./store.ts";
import { useCoach } from "./store.ts";
import { t } from "./strings.ts";

/** Coach as a peer of the user's projects in the primary navigation: one row,
 *  one optional status line, and no Git or worktree semantics anywhere. */
export default function CoachNavItem({ client, expanded, onOpen, isActive, subscribe }: {
  client: CoachClient;
  expanded: boolean;
  onOpen(): void;
  isActive(): boolean;
  /** Host store subscription — the sidebar does not re-render on every
   *  navigation change, so the row watches for its own selected state. */
  subscribe(listener: () => void): () => void;
}) {
  const snapshot = useCoach(client);
  const active = useSyncExternalStore(subscribe, isActive, () => false);
  const status = coachNavStatus(snapshot.home);
  return <div className="personal-coach-root coach-nav">
    <button
      type="button"
      className={`coach-nav-item${active ? " active" : ""}`}
      aria-current={active ? "true" : undefined}
      title={t("coach.workspace.title")}
      onClick={onOpen}
    >
      <span className="coach-nav-glyph" aria-hidden="true">◎</span>
      {expanded && <span className="coach-nav-copy">
        <span className="coach-nav-title">{t("coach.workspace.title")}</span>
        {status && <span className="coach-nav-status">{status}</span>}
      </span>}
    </button>
  </div>;
}
