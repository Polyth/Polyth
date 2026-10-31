// Summary pages are ordered by update time, so a delegated child (a subagent,
// a workflow unit) can arrive pages before its parent. The navigator withholds
// such a child instead of listing it as a chat of its own; this module reads
// each missing parent once so the child can nest under it. A parent that
// cannot be read settles as gone, and its child then stands on its own.
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { SessionProjection } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { upsertSessions, useStore } from "./store.ts";

const MAX_IN_FLIGHT = 4;
const settled = new Set<string>();
const inFlight = new Set<string>();
const queued = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function pump(): void {
  for (const id of queued) {
    if (inFlight.size >= MAX_IN_FLIGHT) return;
    queued.delete(id);
    inFlight.add(id);
    void api.getSession(id)
      .then((parent) => { if (parent?.id === id) upsertSessions([parent]); })
      .catch(() => undefined)
      .finally(() => {
        inFlight.delete(id);
        settled.add(id);
        notify();
        pump();
      });
  }
}

/** Read the parents of `children` that are neither loaded nor already read. */
export function requestSessionParents(
  children: readonly Pick<SessionProjection, "parentId">[],
  loaded: ReadonlySet<string>,
): void {
  let added = false;
  for (const child of children) {
    const id = child.parentId;
    if (!id || loaded.has(id) || settled.has(id) || inFlight.has(id) || queued.has(id)) continue;
    queued.add(id);
    added = true;
  }
  if (added) pump();
}

/** Whether a child's parent may still arrive: it is not loaded and has not
 *  been read yet. Reads the missing parents of `children` as a side effect. */
export function useSessionParentPending(
  children: readonly Pick<SessionProjection, "parentId">[],
): (parentId: string) => boolean {
  const tick = useSyncExternalStore(subscribe, () => version);
  const sessions = useStore((state) => state.sessions);
  const loaded = useMemo(() => new Set(sessions.map((session) => session.id)), [sessions]);
  useEffect(() => {
    requestSessionParents(children, loaded);
  }, [children, loaded]);
  return useCallback(
    (parentId: string) => !loaded.has(parentId) && !settled.has(parentId),
    // `tick` re-creates the predicate once a read settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loaded, tick],
  );
}

/** Test seam: forget every read. */
export function resetSessionParentReads(): void {
  settled.clear();
  inFlight.clear();
  queued.clear();
  notify();
}
