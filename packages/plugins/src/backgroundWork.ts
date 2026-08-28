import type {
  BackgroundWorkKind,
  SessionProjection,
} from "@polyth/contracts";
import type { ServerPackageHost } from "./serverPackage.ts";

export type BackgroundWorkTransition =
  | { phase: "started"; id: string }
  | { phase: "completed"; id: string; status: "completed" | "failed" };

const activeCount = (projection: SessionProjection): number =>
  (projection.backgroundWork?.multirun ?? 0)
  + (projection.backgroundWork?.fusion ?? 0);

/** Pure projection transition shared by autonomous workflow packages. */
export function transitionBackgroundWork(
  projection: SessionProjection,
  kind: BackgroundWorkKind,
  transition: BackgroundWorkTransition,
  now = Date.now(),
): SessionProjection {
  const current = projection.backgroundWork ?? {};
  const before = activeCount(projection);
  const count = current[kind] ?? 0;
  const nextCount = transition.phase === "started"
    ? count + 1
    : Math.max(0, count - 1);
  const backgroundWork = {
    ...current,
    ...(nextCount > 0 ? { [kind]: nextCount } : {}),
    ...(transition.phase === "started"
      ? { startedAt: before > 0 ? current.startedAt ?? now : now }
      : {
          lastResult: {
            id: transition.id,
            kind,
            status: transition.status,
            at: now,
          },
        }),
  };
  if (nextCount === 0) delete backgroundWork[kind];
  const remaining = (backgroundWork.multirun ?? 0) + (backgroundWork.fusion ?? 0);
  if (remaining === 0) delete backgroundWork.startedAt;
  return { ...projection, backgroundWork, updatedAt: now };
}

/** Atomically persist then broadcast the exact committed projection. */
export async function publishBackgroundWork(
  host: Pick<ServerPackageHost, "store" | "broadcast">,
  sessionId: string,
  kind: BackgroundWorkKind,
  transition: BackgroundWorkTransition,
): Promise<void> {
  if (!host.store.patchProjection) return;
  const next = await host.store.patchProjection(
    sessionId,
    (current) => transitionBackgroundWork(current, kind, transition),
  );
  if (next) host.broadcast.projection(next);
}
