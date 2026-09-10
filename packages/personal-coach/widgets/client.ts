import type { CoachApi, CoachHomeDto } from "./api.ts";
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
  talk(title?: string, text?: string): Promise<void>;
  start(text: string, timeZone: string): Promise<boolean>;
  finishSetup(input: CoachSetupPreferences): Promise<boolean>;
  reschedule(id: string, plannedFor: number): Promise<boolean>;
  dispose(): void;
}

function withoutCommitment(home: CoachHomeDto, id: string): CoachHomeDto {
  const commitments = home.today.commitments.filter((item) => item.id !== id);
  const today: CoachHomeDto["today"] = { ...home.today, commitments };
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
    publish({ ...snapshot, home: withoutCommitment(before, id), error: undefined });
    setBusy(`commitment:${id}`, true);
    try { await run(); await reconcile(); }
    catch (cause) {
      // Roll back only this row, not a newer check-in or another mutation.
      const current = snapshot.home;
      const original = before.today.commitments.find((item) => item.id === id);
      if (current && original && !current.today.commitments.some((item) => item.id === id)) {
        const commitments = [...current.today.commitments];
        const index = Math.min(before.today.commitments.indexOf(original), commitments.length);
        commitments.splice(index, 0, original);
        publish({ ...snapshot, home: {
          ...current,
          today: { ...current.today, commitments,
            ...(before.today.mainFocus?.id === id ? { mainFocus: original } : {}),
          },
          ...(before.nextAction?.id === id ? { nextAction: original } : {}),
        } });
      }
      fail(action, cause);
    } finally { setBusy(`commitment:${id}`, false); }
  };

  const launch = async (title?: string, options: CoachSessionOptions = { resume: true }): Promise<boolean> => {
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
        const lastCheckIn = await input.api.recordCheckIn({ energy, focus });
        if (snapshot.home) publish({ ...snapshot, home: { ...snapshot.home, lastCheckIn }, error: undefined });
      } catch (cause) { fail("Save check-in", cause); }
      finally { setBusy("checkin", false); }
    },
    async talk(title, text) {
      await launch(title, title || text ? {
        resume: false,
        text: text ?? "Let's review the past week. Read my Coach context, help me reflect on what happened, and propose only evidence-backed adjustments.",
      } : { resume: true });
    },
    start: (text, timeZone) => launch(undefined, { resume: true, text, timeZone }),
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
    dispose() { disposed = true; listeners.clear(); },
  };
  return client;
}
