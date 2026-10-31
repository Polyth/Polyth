// One client store for every custom-action surface in this tab: the action
// library, the caller's permissions, live runs and short-lived launch
// feedback. Widgets, the window and the settings page subscribe to the same
// snapshot, so pressing an icon anywhere lights up every copy of it.
import { useSyncExternalStore } from "react";
import type {
  ActionRunDto,
  CustomActionDto,
  CustomActionInput,
} from "../src/actionModel.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { actionApi } from "./api.ts";
import { confirmRun } from "./confirmRun.ts";
import { actionHost } from "./host.ts";

export type LoadStatus = "idle" | "loading" | "ready" | "error";

/** Client-side feedback for a press that has no server run (yet). */
export interface Launch {
  state: "starting" | "opened" | "failed";
  at: number;
  error?: string;
}

export interface ActionsSnapshot {
  status: LoadStatus;
  error: string | null;
  actions: readonly CustomActionDto[];
  canManage: boolean;
  canRun: boolean;
  canChat: boolean;
  blocked: string | null;
  /** Newest first. */
  runs: readonly ActionRunDto[];
  launches: Readonly<Record<string, Launch>>;
  /** Finished runs whose result the person has already looked at. */
  seen: ReadonlySet<string>;
  /** A run the window should open (set from a notice). */
  focusRunId: string | null;
  /** Runs shown as floating result cards, oldest first. */
  cards: readonly string[];
}

export interface RunContext {
  projectId: string;
  sessionId: string | null;
}

export const actionKey = (actionId: string, projectId: string): string => `${actionId}@${projectId}`;

const CHANNEL = "polyth.custom-action";
/** Result cards on screen at once; the oldest makes room for a new one. */
export const MAX_CARDS = 3;
const STALE_MS = 20_000;

const initial: ActionsSnapshot = {
  status: "idle",
  error: null,
  actions: [],
  canManage: false,
  canRun: false,
  canChat: false,
  blocked: null,
  runs: [],
  launches: {},
  seen: new Set(),
  focusRunId: null,
  cards: [],
};

let snapshot: ActionsSnapshot = initial;
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let loadedAt = 0;
let generation = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by every local run change; older list reads are discarded. */
let runsGeneration = 0;
let polling = false;
let channel: BroadcastChannel | null = null;
let attached = false;
/** Runs started from this tab, with the navigation they started from. */
const launchedHere = new Map<string, { projectId: string; sessionId: string | null }>();

function set(patch: Partial<ActionsSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

const message = (cause: unknown): string => {
  const host = actionHost();
  if (host) return host.errors.friendly(tr("customaction.error.generic"), cause);
  return cause instanceof Error ? cause.message : String(cause);
};

const reason = (cause: unknown): string => cause instanceof Error && cause.message ? cause.message : String(cause);

function announceChange(kind: "actions" | "runs"): void {
  try { channel?.postMessage({ kind }); } catch { /* closed channel */ }
}

function onVisible(): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (snapshot.status === "ready" && Date.now() - loadedAt > STALE_MS) void refresh();
  void pollRuns();
}

function attach(): void {
  if (attached || typeof window === "undefined") return;
  attached = true;
  if (typeof BroadcastChannel === "function") {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<{ kind?: string }>) => {
      if (event.data?.kind === "actions") void refresh();
      if (event.data?.kind === "runs") void pollRuns();
    };
  }
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
}

// ---- library --------------------------------------------------------------------

export function refresh(): Promise<void> {
  attach();
  if (loading) return loading;
  const ticket = ++generation;
  if (snapshot.status !== "ready") set({ status: "loading", error: null });
  loading = actionApi.list()
    .then((list) => {
      if (ticket !== generation) return;
      loadedAt = Date.now();
      set({
        status: "ready",
        error: null,
        actions: list.actions,
        canManage: list.canManage,
        canRun: list.canRun,
        canChat: list.canChat,
        blocked: list.blocked,
      });
    })
    .catch((cause) => {
      if (ticket !== generation) return;
      // A failed refresh keeps the last good library on screen.
      set(snapshot.status === "ready" ? { error: message(cause) } : { status: "error", error: message(cause) });
    })
    .finally(() => { loading = null; });
  return loading.then(() => pollRuns());
}

export function ensureLoaded(): void {
  if (snapshot.status === "idle") void refresh();
}

/** Create (no id) or replace an action; resolves the saved record. */
export async function saveAction(input: CustomActionInput, id?: string): Promise<CustomActionDto> {
  const { action } = id ? await actionApi.update(id, input) : await actionApi.create(input);
  generation += 1; // an in-flight list read predates this write
  const actions = id
    ? snapshot.actions.map((item) => item.id === id ? action : item)
    : [...snapshot.actions, action];
  set({ actions });
  announceChange("actions");
  return action;
}

export async function deleteAction(id: string): Promise<void> {
  const before = snapshot.actions;
  set({ actions: before.filter((action) => action.id !== id) });
  try {
    await actionApi.remove(id);
    generation += 1;
    announceChange("actions");
  } catch (cause) {
    set({ actions: before });
    throw cause;
  }
}

/** Optimistically apply a new order; restores the previous one on refusal. */
export async function reorderActions(ids: readonly string[]): Promise<void> {
  const before = snapshot.actions;
  const byId = new Map(before.map((action) => [action.id, action]));
  const listed = new Set(ids);
  set({ actions: [...ids.flatMap((id) => byId.get(id) ?? []), ...before.filter((action) => !listed.has(action.id))] });
  try {
    const { actions } = await actionApi.reorder(ids);
    generation += 1;
    set({ actions });
    announceChange("actions");
  } catch (cause) {
    set({ actions: before });
    throw cause;
  }
}

// ---- runs -----------------------------------------------------------------------

const isActive = (run: ActionRunDto) => run.status === "running";
const failedStatus = (run: ActionRunDto) => run.status === "failed" || run.status === "error" || run.status === "timed-out";

export function latestRun(runs: readonly ActionRunDto[], actionId: string, projectId: string): ActionRunDto | undefined {
  return runs.find((run) => run.actionId === actionId && run.projectId === projectId);
}

function finished(run: ActionRunDto): void {
  const origin = launchedHere.get(run.id);
  launchedHere.delete(run.id);
  if (!origin) return;
  const host = actionHost();
  if (!host) return;
  if (run.chatSessionId && run.status === "succeeded") {
    // Land in the new chat unless the person has moved on since the press.
    const now = host.store.getSnapshot();
    if (now.activeProjectId === origin.projectId && now.activeSessionId === origin.sessionId) {
      void host.conversation.openSession(run.chatSessionId).catch(() => undefined);
    }
    return;
  }
  // A result card on screen already says how it ended.
  if (failedStatus(run) && !snapshot.cards.includes(run.id)) {
    const text = run.status === "timed-out"
      ? tr("customaction.notice.timedOut", { name: run.name })
      : run.status === "error"
        ? tr("customaction.notice.error", { name: run.name, reason: run.error ?? "" })
        : tr("customaction.notice.failed", { name: run.name, code: String(run.exitCode ?? "?") });
    host.errors.show?.(text, { label: tr("customaction.showOutput"), run: () => focusRun(run.id) });
  }
}

function applyRuns(runs: readonly ActionRunDto[]): void {
  const previous = new Map(snapshot.runs.map((run) => [run.id, run]));
  const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt);
  set({ runs: sorted });
  for (const run of sorted) {
    const before = previous.get(run.id);
    if (!isActive(run) && (!before || isActive(before))) finished(run);
  }
  // A run the server no longer knows (it restarted) has nothing left to report.
  const known = new Set(sorted.map((run) => run.id));
  for (const id of [...launchedHere.keys()]) if (!known.has(id)) launchedHere.delete(id);
}

function schedulePoll(delay: number): void {
  if (pollTimer) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void pollRuns();
  }, delay);
}

export async function pollRuns(): Promise<void> {
  if (polling) return;
  polling = true;
  const ticket = runsGeneration;
  try {
    const { runs } = await actionApi.runs();
    // A list read before a press of this tab must not hide the run it started.
    if (ticket === runsGeneration) applyRuns(runs);
    else schedulePoll(0);
  } catch {
    // Keep showing the last known state; the next poll retries.
  } finally {
    polling = false;
  }
  if (snapshot.runs.some(isActive) || launchedHere.size > 0) {
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    schedulePoll(hidden ? 4_000 : 900);
  }
}

function setLaunch(key: string, launch: Launch | null): void {
  const launches = { ...snapshot.launches };
  if (launch) launches[key] = launch;
  else delete launches[key];
  set({ launches });
}

/** Ask an open Terminal view to adopt and focus a new tab. The view may still
 *  be mounting, so the (idempotent) announcement repeats briefly. */
function announceTerminal(detail: { terminalId: string; projectId: string; sessionId: string | null; title: string }): void {
  const send = () => window.dispatchEvent(new CustomEvent("polyth:terminal-created", {
    detail: { terminalId: detail.terminalId, projectId: detail.projectId, title: detail.title, ...(detail.sessionId ? { sessionId: detail.sessionId } : {}) },
  }));
  send();
  for (const delay of [300, 1_000]) setTimeout(send, delay);
}

export type StartResult =
  | { kind: "terminal" }
  | { kind: "run"; run: ActionRunDto; joined: boolean }
  /** The action asks before running and the person declined. */
  | { kind: "cancelled" };

export interface StartOptions {
  /** Show the run in a floating result card (presses from rails and toolbars). */
  card?: boolean;
}

/** Press an action in a project. Terminal actions open a Terminal tab; the
 *  others start (or rejoin) a server run that keeps going without this tab.
 *  An action that asks before running asks first; rejoining a run in
 *  progress starts nothing, so it does not ask. */
export async function startAction(action: CustomActionDto, context: RunContext, options: StartOptions = {}): Promise<StartResult> {
  const host = actionHost();
  const key = actionKey(action.id, context.projectId);
  if (action.mode === "terminal") {
    if (!(await confirmRun(action))) return { kind: "cancelled" };
    setLaunch(key, { state: "starting", at: Date.now() });
    try {
      const { terminalId } = await actionApi.openTerminal({ projectId: context.projectId, sessionId: context.sessionId, cmd: action.command });
      void actionApi.renameTerminal(terminalId, action.name).catch(() => undefined);
      host?.navigation.openWorkspacePane("terminal");
      announceTerminal({ terminalId, projectId: context.projectId, sessionId: context.sessionId, title: action.name });
      setLaunch(key, { state: "opened", at: Date.now() });
      return { kind: "terminal" };
    } catch (cause) {
      setLaunch(key, { state: "failed", at: Date.now(), error: reason(cause) });
      throw cause;
    }
  }
  const running = latestRun(snapshot.runs, action.id, context.projectId);
  if (running && isActive(running)) {
    if (options.card) showCard(running.id);
    return { kind: "run", run: running, joined: true };
  }
  if (!(await confirmRun(action))) return { kind: "cancelled" };
  setLaunch(key, { state: "starting", at: Date.now() });
  try {
    const launchedFrom = host?.store.getSnapshot();
    const started = await actionApi.run(action.id, context);
    if (!started.joined) {
      launchedHere.set(started.run.id, {
        projectId: launchedFrom?.activeProjectId ?? context.projectId,
        sessionId: launchedFrom?.activeSessionId ?? null,
      });
    }
    setLaunch(key, null);
    if (options.card) showCard(started.run.id);
    runsGeneration += 1;
    const others = snapshot.runs.filter((run) => run.id !== started.run.id);
    applyRuns([started.run, ...others]);
    announceChange("runs");
    schedulePoll(400);
    return { kind: "run", run: started.run, joined: started.joined };
  } catch (cause) {
    setLaunch(key, { state: "failed", at: Date.now(), error: reason(cause) });
    throw cause;
  }
}

export async function stopRun(runId: string): Promise<void> {
  const { run } = await actionApi.stop(runId);
  runsGeneration += 1;
  applyRuns(snapshot.runs.map((item) => item.id === run.id ? run : item));
  announceChange("runs");
}

export function markSeen(runId: string): void {
  if (snapshot.seen.has(runId)) return;
  const seen = new Set(snapshot.seen);
  seen.add(runId);
  set({ seen });
}

export function clearLaunch(actionId: string, projectId: string): void {
  setLaunch(actionKey(actionId, projectId), null);
}

/** Float a run's result card (again); it moves to the newest place. */
export function showCard(runId: string): void {
  const cards = [...snapshot.cards.filter((id) => id !== runId), runId];
  set({ cards: cards.slice(-MAX_CARDS) });
}

/** The person closed the card (or it timed out): its result counts as seen. */
export function dismissCard(runId: string): void {
  if (!snapshot.cards.includes(runId)) return;
  const run = snapshot.runs.find((item) => item.id === runId);
  set({ cards: snapshot.cards.filter((id) => id !== runId) });
  if (run && !isActive(run)) markSeen(runId);
}

/** Show one run's output in the Custom actions window. */
export function focusRun(runId: string | null): void {
  set({ focusRunId: runId });
  if (runId) actionHost()?.navigation.openWorkspacePane("custom-action");
}

// ---- subscription -----------------------------------------------------------------

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const getSnapshot = (): ActionsSnapshot => snapshot;

export function useActions(): ActionsSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Package disable: forget everything and stop background work. */
export function resetActionStore(): void {
  generation += 1;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  launchedHere.clear();
  if (attached && typeof window !== "undefined") {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
  }
  channel?.close();
  channel = null;
  attached = false;
  loading = null;
  loadedAt = 0;
  snapshot = initial;
  for (const listener of listeners) listener();
}
