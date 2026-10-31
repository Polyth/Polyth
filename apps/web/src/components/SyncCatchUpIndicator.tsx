import { useEffect, useState } from "react";
import { tr } from "../i18n/index.ts";
import type { CatchUpIndicator } from "../syncCatchUp.ts";
import Spinner from "./ui/Spinner.tsx";

/** Leaving lasts as long as the fade; the pill keeps its last text meanwhile. */
const LEAVE_MS = 180;

/** A small glass pill at the top edge saying the screen is catching up. It
 *  never takes pointer events or focus and never moves layout: what is under
 *  it stays readable and usable. Announced politely, once per change. */
export default function SyncCatchUpIndicator({ indicator }: { indicator: CatchUpIndicator }) {
  const [shown, setShown] = useState<Exclude<CatchUpIndicator, "hidden"> | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (indicator !== "hidden") {
      setShown(indicator);
      setLeaving(false);
      return;
    }
    if (shown === null) return;
    setLeaving(true);
    const timer = setTimeout(() => { setShown(null); setLeaving(false); }, LEAVE_MS);
    return () => clearTimeout(timer);
  }, [indicator]);

  if (shown === null) return null;
  const label = shown === "updating" ? tr("app.syncUpdating") : tr("app.syncReconnecting");
  return (
    <div
      className="sync-catch-up"
      data-state={leaving ? "leaving" : "shown"}
      data-phase={shown}
      role="status"
      aria-live="polite"
    >
      <Spinner size="sm" className="sync-catch-up-spinner" />
      <span className="sync-catch-up-label">{label}</span>
    </div>
  );
}
