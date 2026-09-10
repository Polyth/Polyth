import { useEffect, useSyncExternalStore } from "react";
import type { CoachApi, CoachHomeDto } from "./api.ts";

export interface CoachClientSnapshot {
  status: "idle" | "loading" | "ready" | "error";
  home?: CoachHomeDto;
  error?: string;
  busy: ReadonlySet<string>;
}

export interface CoachClient {
  getSnapshot(): CoachClientSnapshot;
  subscribe(listener: () => void): () => void;
  ensureLoaded(): Promise<void>;
  refresh(): Promise<void>;
  complete(id: string): Promise<void>;
  skip(id: string, reason?: string): Promise<void>;
  checkIn(energy: number, focus: number): Promise<void>;
  talk(title?: string): Promise<void>;
}

function withoutCommitment(home: CoachHomeDto, id: string): CoachHomeDto {
  const commitments = home.today.commitments.filter((item) => item.id !== id);
  const removedVisible = commitments.length !== home.today.commitments.length;
  const today: CoachHomeDto["today"] = {
    ...home.today,
    commitments,
    overflowCount: removedVisible ? Math.max(0, home.today.overflowCount - 1) : home.today.overflowCount,
  };
  if (today.mainFocus?.id === id) {
    if (commitments[0]) today.mainFocus = commitments[0];
    else delete today.mainFocus;
  }
  const next: CoachHomeDto = { ...home, today };
  if (next.nextAction?.id === id) {
    if (commitments[0]) next.nextAction = commitments[0];
    else delete next.nextAction;
  }
  return next;
}

export function createCoachClient(input: {
  api: CoachApi;
  openSession(sessionId: string): Promise<void>;
  friendlyError(action: string, cause: unknown): string;
}): CoachClient {
  const listeners = new Set<() => void>();
  let snapshot: CoachClientSnapshot = { status: "idle", busy: new Set() };
  let load: Promise<void> | null = null;

  const publish = (next: CoachClientSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const setBusy = (key: string, value: boolean): void => {
    const busy = new Set(snapshot.busy);
    if (value) busy.add(key);
    else busy.delete(key);
    publish({ ...snapshot, busy });
  };
  const fail = (action: string, cause: unknown, fallback?: CoachClientSnapshot): void => {
    const error = input.friendlyError(action, cause);
    publish(fallback
      ? { ...fallback, error, busy: snapshot.busy }
      : { ...snapshot, status: snapshot.home ? "ready" : "error", error });
  };

  const refresh = async (): Promise<void> => {
    if (load) return load;
    if (!snapshot.home) publish({ ...snapshot, status: "loading", error: undefined });
    load = input.api.home()
      .then((home) => publish({ status: "ready", home, busy: snapshot.busy }))
      .catch((cause) => fail("Load Personal Coach", cause))
      .finally(() => { load = null; });
    return load;
  };

  const client: CoachClient = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async ensureLoaded() {
      if (snapshot.home) return;
      return refresh();
    },
    refresh,
    async complete(id) {
      const before = snapshot;
      if (!snapshot.home || snapshot.busy.has(`commitment:${id}`)) return;
      publish({ ...snapshot, home: withoutCommitment(snapshot.home, id), error: undefined });
      setBusy(`commitment:${id}`, true);
      try {
        await input.api.completeCommitment(id);
        await refresh();
      } catch (cause) {
        fail("Complete commitment", cause, before);
      } finally {
        setBusy(`commitment:${id}`, false);
      }
    },
    async skip(id, reason) {
      const before = snapshot;
      if (!snapshot.home || snapshot.busy.has(`commitment:${id}`)) return;
      publish({ ...snapshot, home: withoutCommitment(snapshot.home, id), error: undefined });
      setBusy(`commitment:${id}`, true);
      try {
        await input.api.skipCommitment(id, reason);
        await refresh();
      } catch (cause) {
        fail("Skip commitment", cause, before);
      } finally {
        setBusy(`commitment:${id}`, false);
      }
    },
    async checkIn(energy, focus) {
      if (snapshot.busy.has("checkin")) return;
      setBusy("checkin", true);
      try {
        const lastCheckIn = await input.api.recordCheckIn({ energy, focus });
        if (snapshot.home) {
          publish({ ...snapshot, home: { ...snapshot.home, lastCheckIn }, error: undefined });
        }
      } catch (cause) {
        fail("Save check-in", cause);
      } finally {
        setBusy("checkin", false);
      }
    },
    async talk(title) {
      if (snapshot.busy.has("talk")) return;
      setBusy("talk", true);
      try {
        const { sessionId } = await input.api.createSession(title);
        await input.openSession(sessionId);
      } catch (cause) {
        fail("Open Coach chat", cause);
      } finally {
        setBusy("talk", false);
      }
    },
  };
  return client;
}

export function useCoach(client: CoachClient): CoachClientSnapshot {
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useEffect(() => { void client.ensureLoaded(); }, [client]);
  return snapshot;
}
