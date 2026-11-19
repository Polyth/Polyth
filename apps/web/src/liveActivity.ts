// Projects Polyth's running work onto the iOS Live Activity (Dynamic Island /
// Lock Screen). One activity for the whole app, and only for a chat that is
// working: its elapsed time and current task. What needs a person, finishes
// or fails reaches the phone as a notification, with the words and a row in
// Notification Centre, so the activity leaves at that moment instead of
// repeating it beside the notification. The snapshot is a presentation of
// canonical projections only; nothing here enters history. Updates are local
// and stop when iOS suspends the page (the socket closes the moment the page
// hides), so every update carries a stale date anchored to when the server
// last confirmed the store current: the activity turns stale shortly after
// that instead of pretending to be live.
// With push (the server confirmed this device's relay registration) the
// page also tells the server which chat the island shows; the server then
// pushes that chat's changes, without words, while iOS suspends the page
// (it ends the activity once the chat stops working), and the trust window
// grows to the server's heartbeat.
// DOM-free apart from the injected bridge and timers, so node:test covers it.
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import { LIVE_ACTIVITY_COUNTS, type LiveActivitySnapshot, type LiveActivityState, type LiveActivityTexts } from "@polyth/mobile/native";
import { tr } from "./i18n/index.ts";
import { lastTask, sessionTitleOf, tasksForIsland } from "./mobileIsland.ts";
import type { RenderModel } from "./reduce.ts";
import { resolveSessionStatus, type SessionStatusKind } from "./sessionStatus.ts";

export const LIVE_ACTIVITY_THROTTLE_MS = 1_000;
/** How long after the store was last confirmed current a snapshot still shows
 *  as live. Past it iOS marks the activity stale ("Open Polyth to update"):
 *  a turn may have ended or a question been answered elsewhere since. */
export const LIVE_ACTIVITY_TRUST_MS = 2 * 60_000;
/** While the store is confirmed current, the stale date moves on this often. */
export const LIVE_ACTIVITY_HEARTBEAT_MS = 30_000;
/** With push, the server re-sends live content every 4 minutes and pushes
 *  every change, so silence means "unchanged" for this long (the server's
 *  `LIVE_ACTIVITY_PUSH_TRUST_MS`). */
export const LIVE_ACTIVITY_PUSH_TRUST_MS = 10 * 60_000;
/** The server re-evaluates at most this many other chats for the line. */
const TRACKED_OTHERS = 20;

type LiveKind = Extract<SessionStatusKind, "needs-approval" | "needs-reply" | "working">;
const RANK: Record<LiveKind, number> = { "needs-approval": 0, "needs-reply": 1, working: 2 };
const isLive = (kind: SessionStatusKind): kind is LiveKind => kind in RANK;

export type LiveActivityModel = Pick<RenderModel, "tasks" | "messages">;

export interface LiveActivityInput {
  sessions: readonly SessionProjection[];
  activeSessionId: string | null;
  /** The active chat's render model, for its task list. */
  activeModel: LiveActivityModel | null;
  events: Record<string, readonly SessionEvent[] | undefined>;
  now?: number;
}

const recency = (session: SessionProjection): number => session.lastTurnAt ?? session.updatedAt ?? session.createdAt;

/** The same start the status resolver measures elapsed work from, but stable
 *  across calls (the system draws the timer, so it must not drift). */
function workStartedAt(session: SessionProjection): number | undefined {
  const background = (session.backgroundWork?.multirun ?? 0)
    + (session.backgroundWork?.fusion ?? 0)
    + (session.backgroundWork?.workflow ?? 0);
  const start = background > 0
    ? session.backgroundWork?.startedAt ?? session.lastTurnAt ?? session.updatedAt
    : session.lastTurnAt ?? session.updatedAt;
  return typeof start === "number" && start > 0 ? start : undefined;
}

/** Subagent and workflow children mirror their requests into the parent and
 *  are not navigator roots, so only root chats compete for the island. */
function rootChats(sessions: readonly SessionProjection[]): SessionProjection[] {
  return sessions.filter((session) => session.status !== "archived" && (!session.parentId || session.forkOf));
}

/** Which chat the island shows, the other chats its line counts and what it
 *  shows, without words: what the server keeps current by push. */
export interface LiveActivityTrack {
  sessionId: string;
  others: string[];
  shown: { state: LiveActivityState; startedAt?: number; waiting: number; working: number };
}

function liveRows(input: LiveActivityInput, now: number) {
  return rootChats(input.sessions)
    .map((session) => ({ session, status: resolveSessionStatus(session, now) }))
    .filter((row): row is typeof row & { status: { kind: LiveKind } } => isLive(row.status.kind))
    .sort((a, b) => {
      const byRank = RANK[a.status.kind] - RANK[b.status.kind];
      if (byRank !== 0) return byRank;
      if (a.session.id === input.activeSessionId) return -1;
      if (b.session.id === input.activeSessionId) return 1;
      return recency(b.session) - recency(a.session) || a.session.id.localeCompare(b.session.id);
    });
}

/** The island's chat and the other live chats its line counts. Only a chat
 *  that is working takes the island (the open one first, then the most
 *  recent); chats that wait for a person are counted in its line and never
 *  shown themselves, since a notification already says what they ask. */
function islandRows(input: LiveActivityInput, now: number) {
  const rows = liveRows(input, now);
  const focus = rows.find((row) => row.status.kind === "working");
  return focus ? { focus, others: rows.filter((row) => row !== focus) } : null;
}

export function liveActivityTrack(input: LiveActivityInput): LiveActivityTrack | null {
  const island = islandRows(input, input.now ?? Date.now());
  if (!island) return null;
  const { focus, others } = island;
  const working = others.filter((row) => row.status.kind === "working").length;
  const startedAt = workStartedAt(focus.session);
  return {
    sessionId: focus.session.id,
    others: others.slice(0, TRACKED_OTHERS).map((row) => row.session.id),
    shown: {
      state: focus.status.kind,
      ...(startedAt !== undefined ? { startedAt } : {}),
      waiting: Math.min(others.length - working, LIVE_ACTIVITY_COUNTS),
      working: Math.min(working, LIVE_ACTIVITY_COUNTS),
    },
  };
}

/** Words a push cannot carry, in this page's language (see `LiveActivityTexts`). */
export function liveActivityTexts(): LiveActivityTexts {
  const counts = Array.from({ length: LIVE_ACTIVITY_COUNTS }, (_, index) => index + 1);
  return {
    labels: {
      "needs-approval": tr("sessionStatus.approvalRequired"),
      "needs-reply": tr("sessionStatus.replyNeeded"),
      working: tr("sessionStatus.working"),
      failed: tr("sessionStatus.failed"),
      done: tr("liveActivity.done"),
    },
    waiting: counts.map((count) => tr("liveActivity.othersWaiting", { count })),
    working: counts.map((count) => tr("liveActivity.othersWorking", { count })),
  };
}

export function liveActivitySnapshot(input: LiveActivityInput): LiveActivitySnapshot | null {
  const now = input.now ?? Date.now();
  const island = islandRows(input, now);
  if (!island) return null;
  const { focus, others } = island;

  const working = others.filter((row) => row.status.kind === "working").length;
  const waiting = others.length - working;
  const summary = [
    waiting > 0 ? tr("liveActivity.othersWaiting", { count: waiting }) : "",
    working > 0 ? tr("liveActivity.othersWorking", { count: working }) : "",
  ].filter(Boolean).join(" · ");

  let detail = "";
  let done = 0;
  let total = 0;
  const model = focus.session.id === input.activeSessionId ? input.activeModel : null;
  if (model) {
    const tasks = tasksForIsland(model.tasks, model.messages);
    total = tasks.length;
    done = tasks.filter((task) => task.status === "done").length;
    detail = lastTask(tasks)?.text ?? "";
  }

  const snapshot: LiveActivitySnapshot = {
    state: "working",
    sessionId: focus.session.id,
    title: sessionTitleOf(focus.session, input.events),
    detail,
    label: focus.status.label,
    summary,
    staleHint: tr("liveActivity.staleHint"),
    done,
    total,
  };
  const startedAt = workStartedAt(focus.session);
  if (startedAt !== undefined) snapshot.startedAt = startedAt;
  return snapshot;
}

export interface LiveActivityBridge {
  /** `staleAt` (epoch ms) is when iOS should mark the snapshot stale; 0 means
   *  it is not confirmed at all and is stale at once. */
  update(snapshot: LiveActivitySnapshot, staleAt: number): Promise<boolean>;
  /** The activity leaves at once: nothing stays on the Lock Screen. */
  end(): Promise<void>;
}

export interface LiveActivityTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** The server half of push: told which chat the island shows (deduplicated
 *  here), and whether it accepted that, which earns the longer trust window. */
export interface LiveActivityTracker {
  track(track: LiveActivityTrack): void;
  untrack(): void;
  trusted(): boolean;
}

/** Whether the server confirms the store current (sync receipts) and when it
 *  last did: null before the first confirmation. */
export interface LiveActivityFreshness {
  current: boolean;
  confirmedAt: number | null;
}

/** Throttled, deduplicated, strictly ordered publisher. The first evaluation
 *  always reaches native, so an activity left by a previous page, process or
 *  server is replaced or ended instead of lingering. */
export class LiveActivityPublisher {
  private readonly bridge: LiveActivityBridge;
  private readonly evaluate: () => {
    snapshot: LiveActivitySnapshot | null;
    track?: LiveActivityTrack | null;
  };
  private readonly tracker: LiveActivityTracker | undefined;
  private trackedKey = "";
  private readonly timers: LiveActivityTimers;
  private readonly throttleMs: number;
  private readonly trustMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly freshness: () => LiveActivityFreshness;
  private published: LiveActivitySnapshot | null = null;
  private publishedKey: string | undefined;
  private publishedStaleAt = 0;
  private timer: unknown = null;
  private heartbeat: unknown = null;
  private lastRun = Number.NEGATIVE_INFINITY;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: {
    bridge: LiveActivityBridge;
    evaluate: LiveActivityPublisher["evaluate"];
    timers: LiveActivityTimers;
    tracker?: LiveActivityTracker;
    /** Defaults to always current, for hosts without sync receipts. */
    freshness?: () => LiveActivityFreshness;
    throttleMs?: number;
    trustMs?: number;
    heartbeatMs?: number;
    now?: () => number;
  }) {
    this.bridge = options.bridge;
    this.evaluate = options.evaluate;
    this.tracker = options.tracker;
    this.timers = options.timers;
    this.throttleMs = options.throttleMs ?? LIVE_ACTIVITY_THROTTLE_MS;
    this.trustMs = options.trustMs ?? LIVE_ACTIVITY_TRUST_MS;
    this.heartbeatMs = options.heartbeatMs ?? LIVE_ACTIVITY_HEARTBEAT_MS;
    this.now = options.now ?? Date.now;
    this.freshness = options.freshness ?? (() => ({ current: true, confirmedAt: this.now() }));
  }

  /** Coalesce store changes into at most one evaluation per throttle window. */
  schedule(): void {
    if (this.disposed || this.timer !== null) return;
    const wait = Math.max(0, this.lastRun + this.throttleMs - this.now());
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  flush(): Promise<void> {
    if (this.disposed) return this.chain;
    const now = this.now();
    this.lastRun = now;
    const { snapshot, track } = this.evaluate();
    const key = snapshot ? JSON.stringify(snapshot) : "";
    const trackKey = snapshot && track ? JSON.stringify(track) : "";
    if (this.tracker && trackKey !== this.trackedKey) {
      this.trackedKey = trackKey;
      if (trackKey) this.tracker.track(track!);
      else this.tracker.untrack();
    }
    const { current, confirmedAt } = this.freshness();
    const anchor = current ? now : confirmedAt;
    const trust = this.tracker?.trusted() ? LIVE_ACTIVITY_PUSH_TRUST_MS : this.trustMs;
    const staleAt = anchor === null ? 0 : anchor + trust;
    // Only a confirmed live snapshot moves its stale date on; an unconfirmed
    // one keeps the date its last confirmation earned.
    this.armHeartbeat(snapshot !== null && current);
    const moved = Math.abs(staleAt - this.publishedStaleAt) >= this.heartbeatMs;
    if (key === this.publishedKey && (!snapshot || !moved)) return this.chain;
    this.published = snapshot;
    this.publishedKey = key;
    this.publishedStaleAt = snapshot ? staleAt : 0;
    this.chain = this.chain.then(async () => {
      if (snapshot) await this.bridge.update(snapshot, staleAt);
      else await this.bridge.end();
    }).catch(() => undefined);
    return this.chain;
  }

  private armHeartbeat(on: boolean): void {
    if (this.heartbeat !== null) this.timers.clear(this.heartbeat);
    this.heartbeat = on
      ? this.timers.set(() => {
          this.heartbeat = null;
          this.schedule();
        }, this.heartbeatMs)
      : null;
  }

  /** The chat the activity currently shows (tap target check). */
  currentSessionId(): string | undefined {
    return this.published?.sessionId;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.timers.clear(this.timer);
    if (this.heartbeat !== null) this.timers.clear(this.heartbeat);
    this.timer = null;
    this.heartbeat = null;
  }
}
