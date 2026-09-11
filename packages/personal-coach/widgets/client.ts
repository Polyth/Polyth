import type { CoachApi, CoachCommitmentDto, CoachHomeDto } from "./api.ts";
import type { CoachJourneyApi, CoachSessionOptions, CoachSessionReply, CoachSetupPreferences } from "./journeyApi.ts";

export interface CoachClientSnapshot {
  status: "idle" | "loading" | "ready" | "error";
  home?: CoachHomeDto;
  error?: string;
  busy: ReadonlySet<string>;
  talkStage?: "starting" | "opening";
  sessionId?: string;
}

export interface CoachClient {
  getSnapshot(): CoachClientSnapshot;
  subscribe(listener: () => void): () => void;
  ensureLoaded(): Promise<void>;
  refresh(): Promise<void>;
  complete(id: string): Promise<void>;
  skip(id: string, reason?: string): Promise<void>;
  checkIn(energy: number, focus: number): Promise<void>;
  /** Open (or continue) the one Coach conversation, optionally with context. */
  talk(context?: string): Promise<void>;
  start(text: string, timeZone: string): Promise<boolean>;
  finishSetup(input: CoachSetupPreferences): Promise<boolean>;
  reschedule(id: string, plannedFor: number): Promise<boolean>;
  resolveRoutine(id: string, action: "done" | "skip" | "reopen", reason?: string): Promise<boolean>;
  dispose(): void;
}

type CommitmentBucket = "today" | "overdue" | "upcoming";
const BUCKETS: readonly CommitmentBucket[] = ["today", "overdue", "upcoming"];

/** The three semantic lists as flat arrays, so one optimistic path serves all
 *  of them instead of Today having rollback and the other two silently not. */
function bucketList(home: CoachHomeDto, bucket: CommitmentBucket): CoachCommitmentDto[] {
  if (bucket === "today") return home.today.actions;
  if (bucket === "overdue") return home.attention.overdue;
  return [...(home.upcoming.next ? [home.upcoming.next] : []), ...home.upcoming.items];
}

function withBucket(
  home: CoachHomeDto,
  bucket: CommitmentBucket,
  items: CoachCommitmentDto[],
  totalDelta: number,
): CoachHomeDto {
  if (bucket === "today") {
    // Focus is always today's first action. Completing the focus promotes the
    // next one; emptying the day shows the honest empty state rather than
    // reaching into upcoming work for something to display.
    const today = { ...home.today, actions: items, total: Math.max(items.length, home.today.total + totalDelta) };
    if (items[0]) today.focus = items[0];
    else delete today.focus;
    return { ...home, today };
  }
  if (bucket === "overdue") {
    return {
      ...home,
      attention: {
        ...home.attention,
        overdue: items,
        overdueTotal: Math.max(items.length, home.attention.overdueTotal + totalDelta),
      },
    };
  }
  const [next, ...rest] = items;
  const upcoming = {
    ...home.upcoming,
    items: rest,
    total: Math.max(items.length, home.upcoming.total + totalDelta),
  };
  if (next) upcoming.next = next;
  else delete upcoming.next;
  return { ...home, upcoming };
}

interface CommitmentSlot {
  bucket: CommitmentBucket;
  index: number;
  item: CoachCommitmentDto;
}

function locate(home: CoachHomeDto, id: string): CommitmentSlot | undefined {
  for (const bucket of BUCKETS) {
    const items = bucketList(home, bucket);
    const index = items.findIndex((item) => item.id === id);
    if (index >= 0) return { bucket, index, item: items[index]! };
  }
  return undefined;
}

function removeCommitment(home: CoachHomeDto, slot: CommitmentSlot): CoachHomeDto {
  const items = bucketList(home, slot.bucket).filter((item) => item.id !== slot.item.id);
  return withBucket(home, slot.bucket, items, -1);
}

function restoreCommitment(home: CoachHomeDto, slot: CommitmentSlot): CoachHomeDto {
  const items = bucketList(home, slot.bucket);
  if (items.some((item) => item.id === slot.item.id)) return home;
  const next = [...items];
  next.splice(Math.min(slot.index, next.length), 0, slot.item);
  return withBucket(home, slot.bucket, next, 1);
}

export function createCoachClient(input: {
  api: CoachApi & Partial<CoachJourneyApi>;
  openSession(sessionId: string): Promise<void>;
  friendlyError(action: string, cause: unknown): string;
  navigationToken?(): unknown;
}): CoachClient {
  const listeners = new Set<() => void>();
  let snapshot: CoachClientSnapshot = { status: "idle", busy: new Set() };
  let load: Promise<void> | null = null;
  let disposed = false;
  const publish = (next: CoachClientSnapshot): void => {
    if (disposed) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const setBusy = (key: string, value: boolean): void => {
    const busy = new Set(snapshot.busy);
    if (value) busy.add(key); else busy.delete(key);
    publish({ ...snapshot, busy });
  };
  const fail = (action: string, cause: unknown): void => publish({
    ...snapshot, status: snapshot.home ? "ready" : "error",
    error: input.friendlyError(action, cause),
  });
  const refresh = async (): Promise<void> => {
    if (disposed) return;
    if (load) return load;
    if (!snapshot.home) publish({ ...snapshot, status: "loading", error: undefined });
    load = input.api.home()
      .then((home) => publish({ ...snapshot, status: "ready", home, error: undefined }))
      .catch((cause) => fail("Load Personal Coach", cause))
      .finally(() => { load = null; });
    return load;
  };
  // A GET started before a mutation cannot satisfy that mutation's refresh.
  const reconcile = async () => { if (load) await load; await refresh(); };

  const mutateCommitment = async (id: string, run: () => Promise<unknown>, action: string) => {
    const before = snapshot.home;
    if (!before || disposed || snapshot.busy.has(`commitment:${id}`)) return;
    // The row may have been rendered from Today, from overdue attention, or
    // from Next up. Optimism and rollback follow wherever it actually lives.
    const slot = locate(before, id);
    if (slot) publish({ ...snapshot, home: removeCommitment(before, slot), error: undefined });
    setBusy(`commitment:${id}`, true);
    try { await run(); await reconcile(); }
    catch (cause) {
      // Roll back only this row, not a newer check-in or another mutation.
      const current = snapshot.home;
      if (current && slot) publish({ ...snapshot, home: restoreCommitment(current, slot) });
      fail(action, cause);
    } finally { setBusy(`commitment:${id}`, false); }
  };

  const launch = async (options: CoachSessionOptions, title?: string): Promise<boolean> => {
    if (disposed || snapshot.busy.has("talk")) return false;
    const navigation = input.navigationToken?.();
    publish({ ...snapshot, error: undefined, talkStage: "starting" });
    setBusy("talk", true);
    try {
      const result: CoachSessionReply = await input.api.createSession(title, options);
      if (disposed) return false;
      publish({ ...snapshot, sessionId: result.sessionId, talkStage: "opening" });
      // A slow provider must not drag the user away from a newer navigation.
      if (!result.startError && (!input.navigationToken || input.navigationToken() === navigation)) {
        await input.openSession(result.sessionId);
      }
      await reconcile();
      if (result.startError) {
        fail("Start Coach", new Error(result.startError));
        return false;
      }
      return true;
    } catch (cause) {
      fail("Open Coach chat", cause);
      return false;
    } finally {
      publish({ ...snapshot, talkStage: undefined });
      setBusy("talk", false);
    }
  };

  const client: CoachClient = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async ensureLoaded() { if (!snapshot.home) await refresh(); },
    refresh,
    complete: (id) => mutateCommitment(id, () => input.api.completeCommitment(id), "Complete commitment"),
    skip: (id, reason) => mutateCommitment(id, () => input.api.skipCommitment(id, reason), "Skip commitment"),
    async checkIn(energy, focus) {
      if (disposed || snapshot.busy.has("checkin")) return;
      setBusy("checkin", true);
      try {
        const checkIn = await input.api.recordCheckIn({ energy, focus });
        if (snapshot.home) publish({ ...snapshot, home: { ...snapshot.home, checkIn }, error: undefined });
      } catch (cause) { fail("Save check-in", cause); }
      finally { setBusy("checkin", false); }
    },
    // One resumable Coach conversation. Context travels as the message the user
    // is effectively sending, never as a second competing session.
    async talk(context) {
      await launch({ resume: true, ...(context ? { text: context } : {}) });
    },
    start: (text, timeZone) => launch({ resume: true, text, timeZone }),
    async finishSetup(preferences) {
      if (disposed || snapshot.busy.has("setup")) return false;
      setBusy("setup", true);
      try {
        if (!input.api.finishSetup) throw new Error("Update the Coach package to finish setup here.");
        const profile = await input.api.finishSetup(preferences);
        if (snapshot.home) publish({ ...snapshot, home: { ...snapshot.home, profile }, error: undefined });
        await reconcile();
        return true;
      } catch (cause) { fail("Finish Coach setup", cause); return false; }
      finally { setBusy("setup", false); }
    },
    async reschedule(id, plannedFor) {
      const key = `commitment:${id}`;
      if (disposed || snapshot.busy.has(key)) return false;
      setBusy(key, true);
      try {
        if (!input.api.rescheduleCommitment) throw new Error("Rescheduling is unavailable.");
        await input.api.rescheduleCommitment(id, plannedFor);
        await reconcile();
        return true;
      } catch (cause) { fail("Move commitment", cause); return false; }
      finally { setBusy(key, false); }
    },
    async resolveRoutine(id, action, reason) {
      const key = `routine:${id}`;
      if (disposed || snapshot.busy.has(key)) return false;
      setBusy(key, true);
      try {
        await input.api.resolveRoutineDay(id, action, reason);
        await reconcile();
        return true;
      } catch (cause) { fail("Update routine", cause); return false; }
      finally { setBusy(key, false); }
    },
    dispose() { disposed = true; listeners.clear(); },
  };
  return client;
}
