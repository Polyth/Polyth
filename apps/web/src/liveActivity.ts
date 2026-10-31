// Projects Polyth's attention and work onto the iOS Live Activity (Dynamic
// Island / Lock Screen). One activity for the whole app: the chat that most
// needs a person (approval, then question), otherwise the one working. The
// snapshot is a presentation of canonical projections only; nothing here
// enters history. Updates are local and stop when iOS suspends the page; the
// native side marks the last snapshot stale instead of pretending it is live.
// DOM-free apart from the injected bridge and timers, so node:test covers it.
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import type { LiveActivitySnapshot, LiveActivityState } from "@polyth/mobile/native";
import { tr } from "./i18n/index.ts";
import { lastTask, questionLabel, requestLabel, sessionTitleOf, tasksForIsland } from "./mobileIsland.ts";
import type { RenderModel } from "./reduce.ts";
import { resolveSessionStatus, type SessionStatusKind } from "./sessionStatus.ts";

export const LIVE_ACTIVITY_THROTTLE_MS = 1_000;

type LiveKind = Extract<SessionStatusKind, "needs-approval" | "needs-reply" | "working">;
const RANK: Record<LiveKind, number> = { "needs-approval": 0, "needs-reply": 1, working: 2 };
const isLive = (kind: SessionStatusKind): kind is LiveKind => kind in RANK;

export type LiveActivityModel = Pick<RenderModel, "permissions" | "questions" | "tasks" | "messages">;

export interface LiveActivityInput {
  sessions: readonly SessionProjection[];
  activeSessionId: string | null;
  /** The active chat's render model, already filtered by its auto-accept
   *  policy, so only requests that need a person are named. */
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
  return sessions.filter((session) => session.status !== "archived" && !session.parentId);
}

export function liveActivitySnapshot(input: LiveActivityInput): LiveActivitySnapshot | null {
  const now = input.now ?? Date.now();
  const rows = rootChats(input.sessions)
    .map((session) => ({ session, status: resolveSessionStatus(session, now) }))
    .filter((row): row is typeof row & { status: { kind: LiveKind } } => isLive(row.status.kind))
    .sort((a, b) => {
      const byRank = RANK[a.status.kind] - RANK[b.status.kind];
      if (byRank !== 0) return byRank;
      if (a.session.id === input.activeSessionId) return -1;
      if (b.session.id === input.activeSessionId) return 1;
      return recency(b.session) - recency(a.session) || a.session.id.localeCompare(b.session.id);
    });
  const focus = rows[0];
  if (!focus) return null;

  const others = rows.slice(1);
  const working = others.filter((row) => row.status.kind === "working").length;
  const waiting = others.length - working;
  const summary = [
    waiting > 0 ? tr("liveActivity.othersWaiting", { count: waiting }) : "",
    working > 0 ? tr("liveActivity.othersWorking", { count: working }) : "",
  ].filter(Boolean).join(" · ");

  const kind = focus.status.kind;
  let detail = "";
  let done = 0;
  let total = 0;
  const model = focus.session.id === input.activeSessionId ? input.activeModel : null;
  if (model) {
    if (kind === "needs-approval") {
      const permission = model.permissions.find((item) => item.status === "pending");
      detail = permission ? requestLabel(permission) : "";
    } else if (kind === "needs-reply") {
      const question = model.questions.find((item) => item.status === "pending");
      detail = question ? questionLabel(question) : "";
    }
    const tasks = tasksForIsland(model.tasks, model.messages);
    total = tasks.length;
    done = tasks.filter((task) => task.status === "done").length;
    if (kind === "working") detail = lastTask(tasks)?.text ?? "";
  }

  const snapshot: LiveActivitySnapshot = {
    state: kind,
    sessionId: focus.session.id,
    title: sessionTitleOf(focus.session, input.events),
    detail,
    label: focus.status.label,
    summary,
    staleHint: tr("liveActivity.staleHint"),
    done,
    total,
  };
  if (kind === "working") {
    const startedAt = workStartedAt(focus.session);
    if (startedAt !== undefined) snapshot.startedAt = startedAt;
  }
  return snapshot;
}

/** What the activity says once nothing is live any more: the last chat it
 *  showed finished or failed. A chat that vanished ends it without a word. */
export function liveActivityFinal(
  previous: LiveActivitySnapshot,
  sessions: readonly SessionProjection[],
  now = Date.now(),
): LiveActivitySnapshot | undefined {
  const session = sessions.find((candidate) => candidate.id === previous.sessionId);
  if (!session || session.status === "archived") return undefined;
  const status = resolveSessionStatus(session, now);
  const state: LiveActivityState = status.kind === "failed" ? "failed" : "done";
  const { startedAt: _startedAt, ...rest } = previous;
  return {
    ...rest,
    state,
    label: state === "failed" ? status.label : tr("liveActivity.done"),
    detail: state === "failed" ? previous.detail : "",
    summary: "",
  };
}

export interface LiveActivityBridge {
  update(snapshot: LiveActivitySnapshot): Promise<boolean>;
  end(final?: LiveActivitySnapshot): Promise<void>;
}

export interface LiveActivityTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** Throttled, deduplicated, strictly ordered publisher. The first evaluation
 *  always reaches native, so an activity left by a previous page, process or
 *  server is replaced or ended instead of lingering. */
export class LiveActivityPublisher {
  private readonly bridge: LiveActivityBridge;
  private readonly evaluate: () => { snapshot: LiveActivitySnapshot | null; final: (previous: LiveActivitySnapshot) => LiveActivitySnapshot | undefined };
  private readonly timers: LiveActivityTimers;
  private readonly throttleMs: number;
  private readonly now: () => number;
  private published: LiveActivitySnapshot | null = null;
  private publishedKey: string | undefined;
  private timer: unknown = null;
  private lastRun = Number.NEGATIVE_INFINITY;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: {
    bridge: LiveActivityBridge;
    evaluate: LiveActivityPublisher["evaluate"];
    timers: LiveActivityTimers;
    throttleMs?: number;
    now?: () => number;
  }) {
    this.bridge = options.bridge;
    this.evaluate = options.evaluate;
    this.timers = options.timers;
    this.throttleMs = options.throttleMs ?? LIVE_ACTIVITY_THROTTLE_MS;
    this.now = options.now ?? Date.now;
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
    this.lastRun = this.now();
    const { snapshot, final } = this.evaluate();
    const key = snapshot ? JSON.stringify(snapshot) : "";
    if (key === this.publishedKey) return this.chain;
    const previous = this.published;
    this.published = snapshot;
    this.publishedKey = key;
    this.chain = this.chain.then(async () => {
      if (snapshot) await this.bridge.update(snapshot);
      else await this.bridge.end(previous ? final(previous) : undefined);
    }).catch(() => undefined);
    return this.chain;
  }

  /** The chat the activity currently shows (tap target check). */
  currentSessionId(): string | undefined {
    return this.published?.sessionId;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}
