import { useEffect, useSyncExternalStore } from "react";
import type { CoachClient, CoachClientSnapshot } from "./client.ts";
export { createCoachClient } from "./client.ts";
export type { CoachClient, CoachClientSnapshot } from "./client.ts";

export function useCoach(client: CoachClient): CoachClientSnapshot {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useEffect(() => { void client.ensureLoaded(); }, [client]);
  return snapshot;
}
