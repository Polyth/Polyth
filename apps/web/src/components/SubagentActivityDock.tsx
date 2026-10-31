// The open chat's delegated subagents hang from its status line above the
// composer: one island holds the agent's own line and, on a thread dropped
// from its mark, a row per active subagent with its state, ask or action,
// time and model. A row opens its chat; Pause and Stop act on it. One that
// needs the person carries its decision (Allow / Deny as the zone's only
// primary); one a person paused stays listed with Continue until it goes on
// or is stopped.
//
// The branch outlives the agent's own turn: while the agent idles, the
// island's first line says it waits for its subagents. State comes from the
// canonical child projections (`parentId`), so agent.spawn children, workflow
// units and adopted native subagents read the same. A child's permission ask
// is its mirror in the parent's log (`sourceSessionId`); a working child's
// action comes from an OpenCode task snapshot or a passive read of the tail of
// its own log while its row is on screen.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import type { SessionProjection } from "@polyth/contracts";
import { resolveModelPresentation } from "@polyth/contracts/model-presentation";
import { useHarnessColors } from "@polyth/models/runtime-catalog";
import { api } from "@polyth/session/web-api";
import ProviderLogo from "../../../../packages/models/widgets/ProviderLogo.tsx";
import { fmtDuration } from "../format.ts";
import { guardedMayAllow, useGuardrails } from "../guardrails.ts";
import { tr } from "../i18n/index.ts";
import { Icon } from "../icons.tsx";
import { continuePausedSession, openSession, pauseSession } from "../init.ts";
import { currentActionOf } from "../liveAction.ts";
import { motionDurationMs } from "../motionPresence.ts";
import { buildModel, type PendingPermission, type RenderModel } from "../reduce.ts";
import { childrenByParent } from "../sessionTree.ts";
import { resolveSessionStatus, type SessionRowStatus } from "../sessionStatus.ts";
import { toggleSessionStatusPopover } from "../sessionStatusPopover.ts";
import { friendlyError } from "../settings.ts";
import { useSpaces } from "../spaces.ts";
import { setUiError, useStore } from "../store.ts";
import {
  activeDescendants,
  sessionActivityState,
  subagentActivity,
  subagentActivityTone,
  subtreeActivityState,
  type SubagentActivity,
  type SubagentActivityState,
  type SubagentTree,
} from "../subagentActivity.ts";
import { subagentActivityLabel } from "./sidebar/SubagentCount.tsx";
import { AgentStatusDock, Button, IconButton } from "./ui/index.ts";
import UiIcon from "./ui/Icon.tsx";
import { PauseIcon, PlayIcon, ShieldAlertIcon, StopIcon } from "./ui/icons.ts";
import PausedMark from "./PausedMark.tsx";
import "./SubagentActivityDock.css";

/** Rows the branch lists before "+n more". */
const LISTED_ROWS = 4;
/** Newest events read from a working child's log for its current action. */
const PEEK_EVENTS = 40;
const PEEK_MS = 4000;
/** Working children whose action is read at once (the visible rows). */
const PEEK_LIMIT = 6;

/** What a waiting row asks of the person. */
type BranchAsk =
  /** Its own permission request, mirrored into the parent's log. */
  | { kind: "permission"; request: PendingPermission; text: string; decide: boolean }
  /** A question, or a permission whose mirror is not in the parent's log. */
  | { kind: "reply"; text: string }
  /** Something below it waits; the row only knows that. */
  | { kind: "nested"; text: string };

/** A row's state: its subtree's activity, or paused by a person. */
type BranchRowState = SubagentActivityState | "paused";

/** An ask comes first. A pause keeps its place, so the row the person just
 *  paused or continued never jumps away from under their finger. */
const ROW_RANK: Record<BranchRowState, number> = { waiting: 0, paused: 1, working: 1 };

interface BranchRow {
  child: SessionProjection;
  /** What the row shows: a Pause or Continue on its way already shows its
   *  outcome (`pending`) until the projection confirms it. */
  state: BranchRowState;
  pending?: "pausing" | "continuing";
  status: SessionRowStatus;
  ask?: BranchAsk;
  /** Active subagents of this subagent, folded into its row. */
  nested: number;
  title: string;
}

interface ModelBadge {
  name: string;
  providerID?: string;
  providerName?: string;
  harnessId?: string;
}

interface BranchState {
  sessionId: string;
  parent: SessionProjection | undefined;
  rows: BranchRow[];
  activity: SubagentActivity;
  tone: BranchRowState;
  showAll: boolean;
  setShowAll: (value: boolean) => void;
  /** Harness profile colors by harness id. */
  harnessColors: ReadonlyMap<string, string>;
  modelOf: (child: SessionProjection) => ModelBadge | undefined;
  actionOf: (child: SessionProjection) => string | undefined;
  reply: (request: PendingPermission, action: "once" | "reject") => void;
  stop: (child: SessionProjection) => void;
  pause: (child: SessionProjection) => void;
  resume: (child: SessionProjection) => void;
}

const BranchContext = createContext<BranchState | null>(null);

/** One shared clock while a working subagent shows its run time. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** The current action of each working child on screen, read from a passive
 *  tail of its own log (prefetch: no runtime is woken) every few seconds
 *  while the tab is visible, and at once when it shows again. A child that
 *  cannot be read shows none. */
function useSubagentPeek(ids: readonly string[]): ReadonlyMap<string, string> {
  const key = ids.join("\n");
  const [actions, setActions] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    if (!key) return;
    const list = key.split("\n");
    const controller = new AbortController();
    let timer: number | undefined;
    let reading = false;
    const tick = async () => {
      reading = true;
      const read = await Promise.all(list.map(async (id) => {
        try {
          const events = await api.getEvents(id, 0, { limit: PEEK_EVENTS, prefetch: true }, { signal: controller.signal });
          return [id, currentActionOf(buildModel(events))] as const;
        } catch {
          return [id, undefined] as const;
        }
      }));
      reading = false;
      if (controller.signal.aborted) return;
      setActions((previous) => {
        const next = new Map<string, string>();
        for (const [id, action] of read) if (action) next.set(id, action);
        const same = next.size === previous.size && [...next].every(([id, action]) => previous.get(id) === action);
        return same ? previous : next;
      });
      schedule();
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState !== "hidden") timer = window.setTimeout(() => { void tick(); }, PEEK_MS);
    };
    // A hidden tab stops reading; showing it again reads at once.
    const onVisibility = () => {
      window.clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState !== "hidden" && !reading) void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState !== "hidden") void tick();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [key]);
  return key ? actions : EMPTY_ACTIONS;
}
const EMPTY_ACTIONS: ReadonlyMap<string, string> = new Map();

/** A permission ask in one line: the tool and what it would run or touch. */
function permissionText(request: PendingPermission): string {
  const what = (request.tool || request.permission || request.preview?.title || "").trim()
    .replace(/[-_]+/g, " ")
    .replace(/^\w/, (letter) => letter.toUpperCase());
  const detail = (request.preview?.lines[0] ?? request.patterns[0] ?? "").trim();
  return [what, detail].filter(Boolean).join(" · ") || tr("sessionStatus.approvalRequired");
}

/**
 * Owns the open chat's subagent branch for the composer's status zone: the
 * rows, the replies in flight and the action reads. Every status line inside
 * it (the live dock, the startup dock, the idle line) hangs the same branch,
 * so a shown-in-full list survives the agent starting or ending a turn.
 */
export function SubagentBranchScope({ sessionId, model, children }: {
  sessionId: string | null;
  /** The open chat's model: its mirrored subagent requests and task snapshot. */
  model: RenderModel;
  children?: ReactNode;
}) {
  const sessions = useStore((state) => state.sessions);
  const models = useStore((state) => state.models);
  const mayAllow = guardedMayAllow(useGuardrails());
  const [showAll, setShowAll] = useState(false);
  // Replies sent from the branch: the ask leaves at the click, before the
  // resolved mirror arrives; a failed reply brings it back.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  // Pause / Continue sent from the branch: the row shows the outcome at the
  // click and holds it until the child's projection confirms it (or the
  // request fails).
  const [pausing, setPausing] = useState<ReadonlySet<string>>(() => new Set());
  const [continuing, setContinuing] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    setShowAll(false);
    setAnswered(new Set());
    setPausing(new Set());
    setContinuing(new Set());
  }, [sessionId]);

  const byParent = useMemo(
    () => childrenByParent(sessions.filter((session) => session.status !== "archived")),
    [sessions],
  );
  const tree = useMemo<SubagentTree<SessionProjection>>(() => ({
    idOf: (session) => session.id,
    childrenOf: (session) => byParent.get(session.id) ?? [],
    stateOf: sessionActivityState,
  }), [byParent]);
  const parent = sessionId ? sessions.find((session) => session.id === sessionId) : undefined;
  const harnessColors = useHarnessColors(parent?.projectId, useSpaces().activeSpaceId ?? "");
  const childSessions = sessionId ? byParent.get(sessionId) ?? [] : [];
  // A confirmed pause (or a run that ended anyway) and a confirmed continue
  // release their optimistic rows.
  useEffect(() => {
    const byId = new Map(childSessions.map((child) => [child.id, child]));
    setPausing((previous) => without(previous, (id) => {
      const child = byId.get(id);
      return !child || child.paused !== undefined || resolveSessionStatus(child).kind !== "working";
    }));
    setContinuing((previous) => without(previous, (id) => byId.get(id)?.paused === undefined));
  }, [childSessions]);
  const activity = subagentActivity(childSessions, tree);
  // Paused children keep the branch up: they wait for the person too.
  const tone: BranchRowState | undefined = subagentActivityTone(activity)
    ?? (childSessions.some((child) => child.paused) ? "paused" : undefined);
  // A child shows its own run time even while something below it waits, so
  // the clock follows the children's own runs, not the rolled-up tone.
  const running = childSessions.some((child) => resolveSessionStatus(child).kind === "working");
  const now = useNow(Boolean(tone) && running);

  const mirrored = model.permissions.filter((request) => request.status === "pending" && request.sourceSessionId !== undefined);
  const pending = mirrored.filter((request) => !answered.has(request.requestId));
  // A child decided here whose mirror is not resolved yet still shows the
  // shield in its projection; it waits for nobody now.
  const deciding = new Set(mirrored.filter((request) => answered.has(request.requestId)).map((request) => request.sourceSessionId));
  const rows: BranchRow[] = childSessions
    .map((child) => {
      const active = subtreeActivityState(child, tree);
      const inFlight = pausing.has(child.id) ? "pausing" as const : continuing.has(child.id) ? "continuing" as const : undefined;
      // A pause holds the row until the person continues or stops it; only
      // someone below that waits for a person outranks it.
      const paused = inFlight === "pausing" || (child.paused !== undefined && inFlight !== "continuing");
      const state: BranchRowState | undefined = active === "waiting"
        ? active
        : paused ? "paused" : inFlight === "continuing" ? "working" : active;
      return { child, state, inFlight };
    })
    .filter((row): row is { child: SessionProjection; state: BranchRowState; inFlight: "pausing" | "continuing" | undefined } => row.state !== undefined)
    // The rows that need the person first, then in delegation order.
    .sort((left, right) =>
      ROW_RANK[left.state] - ROW_RANK[right.state]
      || left.child.createdAt - right.child.createdAt)
    .map(({ child, state, inFlight }) => {
      const status = resolveSessionStatus(child, now);
      const title = child.title || tr("sidebar.sessionlist.session");
      const nested = activeDescendants(child, tree).length;
      let ask: BranchAsk | undefined;
      if (state === "waiting") {
        const request = pending.find((candidate) => candidate.sourceSessionId === child.id);
        if (!request && deciding.has(child.id)) {
          // Decided here a moment ago; the canonical events have not caught up.
        } else if (request) {
          ask = {
            kind: "permission",
            request,
            text: permissionText(request),
            // A high-risk request is read in full on its card, never
            // allowed blind from one line.
            decide: mayAllow && request.preview?.risk !== "high" && !request.manual,
          };
        } else if (status.kind === "needs-approval" || status.kind === "needs-reply") {
          ask = { kind: "reply", text: status.label };
        } else {
          ask = { kind: "nested", text: tr("subagentdock.nestedWaiting") };
        }
      }
      return { child, state, status, title, nested, ...(inFlight ? { pending: inFlight } : {}), ...(ask ? { ask } : {}) };
    });

  // A child without its own model runs on the parent's (it inherits it).
  const modelOf = useCallback((child: SessionProjection): ModelBadge | undefined => {
    const ref = child.model ?? parent?.model;
    if (!ref) return undefined;
    const presentation = resolveModelPresentation(ref, models, child.resolvedHarnessId ?? parent?.resolvedHarnessId);
    return {
      name: presentation.name,
      providerID: presentation.descriptor?.providerID ?? ref.providerID,
      ...(presentation.descriptor?.providerName ? { providerName: presentation.descriptor.providerName } : {}),
      ...((presentation.descriptor?.harnessId ?? child.resolvedHarnessId ?? parent?.resolvedHarnessId)
        ? { harnessId: presentation.descriptor?.harnessId ?? child.resolvedHarnessId ?? parent?.resolvedHarnessId }
        : {}),
    };
  }, [models, parent?.model, parent?.resolvedHarnessId]);

  const snapshot = model.subagents;
  const snapshotTask = (child: SessionProjection): string | undefined => snapshot?.agents.find((agent) =>
    agent.sessionId === child.id || (child.backendSessionId !== undefined && agent.sessionId === child.backendSessionId),
  )?.currentTask?.trim() || undefined;
  // Only the listed rows are read; a native task snapshot already names its
  // task.
  const shown = showAll ? rows : rows.slice(0, LISTED_ROWS);
  const peekIds = shown
    .filter((row) => row.status.kind === "working" && !snapshotTask(row.child))
    .slice(0, PEEK_LIMIT)
    .map((row) => row.child.id);
  const peeked = useSubagentPeek(tone ? peekIds : []);
  const actionOf = (child: SessionProjection) => snapshotTask(child) ?? peeked.get(child.id);

  const reply = useCallback((request: PendingPermission, action: "once" | "reject") => {
    setAnswered((previous) => new Set([...previous, request.requestId]));
    // The mirror lives in the parent's log; the server forwards the answer.
    void api.replyPermission(request.sessionId, request.requestId, action).catch((error: unknown) => {
      setAnswered((previous) => {
        const next = new Set(previous);
        next.delete(request.requestId);
        return next;
      });
      setUiError(friendlyError(tr("common.error"), error));
    });
  }, []);
  const stop = useCallback((child: SessionProjection) => {
    void api.abort(child.id, "subagent-dock").catch((error: unknown) =>
      setUiError(friendlyError(tr("common.stop"), error)));
  }, []);
  const pause = useCallback((child: SessionProjection) => {
    setPausing((previous) => new Set([...previous, child.id]));
    void pauseSession(child.id, "subagent-dock").then((ok) => {
      if (!ok) setPausing((previous) => without(previous, (id) => id === child.id));
    });
  }, []);
  const resume = useCallback((child: SessionProjection) => {
    setContinuing((previous) => new Set([...previous, child.id]));
    void continuePausedSession(child.id, "subagent-dock").then((ok) => {
      if (!ok) setContinuing((previous) => without(previous, (id) => id === child.id));
    });
  }, []);

  const value: BranchState | null = sessionId && tone ? {
    sessionId,
    parent,
    rows,
    // The branch counts the subagents it shows: the active ones.
    activity: { ...activity, total: rows.length },
    tone,
    showAll,
    setShowAll,
    harnessColors,
    modelOf,
    actionOf,
    reply,
    stop,
    pause,
    resume,
  } : null;
  return <BranchContext.Provider value={value}>{children}</BranchContext.Provider>;
}

/** The set minus the ids `drop` picks; the same set when none is dropped. */
function without(set: ReadonlySet<string>, drop: (id: string) => boolean): ReadonlySet<string> {
  if (![...set].some(drop)) return set;
  return new Set([...set].filter((id) => !drop(id)));
}

/** The row's state mark. Keyed by what it shows, so a change mounts the new
 *  mark and it grows in over the old one's place (CSS). */
function RowMark({ row }: { row: BranchRow }) {
  return <span className="subagent-branch-glyph">{markOf(row)}</span>;
}
const markKey = (row: BranchRow): string => row.state === "waiting" ? `waiting:${row.status.kind}` : row.state;
function markOf(row: BranchRow): ReactNode {
  if (row.state === "paused") return <PausedMark />;
  if (row.state === "working") return <span className="session-lead-spinner" aria-hidden="true" />;
  if (row.status.kind === "needs-approval") return <UiIcon icon={ShieldAlertIcon} size="sm" />;
  if (row.status.kind === "needs-reply") return <span className="subagent-branch-question" aria-hidden="true"><Icon.question /></span>;
  // A nested subagent waits: the row only knows someone below needs a person.
  return <span className="subagent-activity-dot waiting" aria-hidden="true" />;
}

/** The ask's decision: Allow / Deny where it can be decided from one line,
 *  else the chat that holds the full request. */
function AskActions({ row, branch }: { row: BranchRow; branch: BranchState }) {
  const ask = row.ask;
  if (!ask) return null;
  if (ask.kind === "permission" && ask.decide) {
    return (
      <span className="subagent-branch-actions subagent-branch-actions--ask">
        <Button
          variant="primary"
          size="sm"
          aria-label={`${tr("subagentdock.allow")}: ${row.title}`}
          onClick={() => branch.reply(ask.request, "once")}
        >{tr("subagentdock.allow")}</Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${tr("subagentdock.deny")}: ${row.title}`}
          onClick={() => branch.reply(ask.request, "reject")}
        >{tr("subagentdock.deny")}</Button>
      </span>
    );
  }
  return (
    <span className="subagent-branch-actions subagent-branch-actions--ask">
      <Button
        variant="quiet"
        size="sm"
        aria-label={`${tr("subagentdock.review")}: ${row.title}`}
        onClick={() => openChild(row.child.id)}
      >{tr("subagentdock.review")}</Button>
    </span>
  );
}

/** A row's media controls: Pause or Continue, then Stop, then the way into
 *  its chat. Running rows show them on hover (always on touch); a paused row
 *  keeps them in view, Continue in the accent. Keyed by state, so a change
 *  fades the new set in. */
function RowActions({ row, branch }: { row: BranchRow; branch: BranchState }) {
  if (row.ask) return <AskActions row={row} branch={branch} />;
  const paused = row.state === "paused";
  return (
    <span className={`subagent-branch-actions subagent-branch-actions--${paused ? "paused" : "hover"}`}>
      {paused
        ? (
          <IconButton
            icon={PlayIcon}
            size="sm"
            className="subagent-branch-continue"
            label={`${tr("subagentdock.continue")}: ${row.title}`}
            // A pause still on its way has nothing to continue yet.
            disabled={row.pending === "pausing"}
            onClick={() => branch.resume(row.child)}
          />
        )
        // Only a run of its own can pause; work below it pauses on its own row.
        // A continue on its way holds the slot, not pausable yet.
        : (row.status.kind === "working" || row.pending === "continuing") && (
          <IconButton
            icon={PauseIcon}
            size="sm"
            className="subagent-branch-pause"
            label={`${tr("subagentdock.pause")}: ${row.title}`}
            disabled={row.pending === "continuing"}
            onClick={() => branch.pause(row.child)}
          />
        )}
      <IconButton
        icon={StopIcon}
        size="sm"
        className="subagent-branch-stop"
        label={`${tr("common.stop")}: ${row.title}`}
        onClick={() => branch.stop(row.child)}
      />
      <span className="subagent-branch-go" aria-hidden="true"><Icon.chevronRight /></span>
    </span>
  );
}

function openChild(id: string): void {
  void openSession(id).catch((error: unknown) => setUiError(friendlyError(tr("common.error"), error)));
}

/** One piece of a row's detail line. */
interface DetailPart { text: string; kind: "ask" | "action" | "meta" | "model" }

/** "Edit · queue.ts · 3:12 · Opus 5.5 · Nested: 2": what a row shows under
 *  its title. The action gives way first; the model never truncates (on a
 *  phone a running row leaves it out instead). */
function rowDetail(row: BranchRow, branch: BranchState): DetailPart[] {
  const parts: DetailPart[] = [];
  if (row.ask) parts.push({ text: row.ask.text, kind: "ask" });
  else if (row.pending) parts.push({ text: tr(row.pending === "pausing" ? "subagentdock.pausing" : "subagentdock.continuing"), kind: "action" });
  else if (row.state === "paused") parts.push({ text: tr("subagentdock.paused"), kind: "action" });
  else parts.push({ text: branch.actionOf(row.child) ?? tr("sessionStatus.working"), kind: "action" });
  // Only the child's own run has a clock (in the agent line's own format); a
  // nested run has none here.
  if (row.status.kind === "working") parts.push({ text: fmtDuration(row.status.elapsedMs), kind: "meta" });
  const model = branch.modelOf(row.child)?.name;
  if (model) parts.push({ text: model, kind: "model" });
  if (row.nested > 0) parts.push({ text: tr("subagentdock.nested", { count: row.nested }), kind: "meta" });
  return parts;
}

function Detail({ parts, className }: { parts: readonly DetailPart[]; className: string }) {
  return (
    <span className={className}>
      {parts.map((part, index) => (
        <span key={index} className={`subagent-branch-${part.kind}`}>{part.text}</span>
      ))}
    </span>
  );
}

/** A listed row with the detail line it showed. */
interface ShownRow { row: BranchRow; detail: readonly DetailPart[] }
/** A row that left the list, held for its exit at its last place and height. */
interface LeavingRow extends ShownRow { index: number; height: number }

/** Rows that just left the list stay a moment to fold away (`data-leaving`)
 *  from the height and with the words they had; none when motion is
 *  reduced. */
function useLeavingRows(shown: readonly ShownRow[], list: RefObject<HTMLUListElement | null>): readonly LeavingRow[] {
  const [leaving, setLeaving] = useState<readonly LeavingRow[]>([]);
  const last = useRef<{ rows: readonly ShownRow[]; heights: ReadonlyMap<string, number> }>({ rows: shown, heights: new Map() });
  const timers = useRef(new Set<number>());
  const key = shown.map(({ row }) => row.child.id).join("\n");
  useLayoutEffect(() => {
    const present = new Set(shown.map(({ row }) => row.child.id));
    const gone = last.current.rows.flatMap((entry, index) => present.has(entry.row.child.id)
      ? []
      : [{ ...entry, index, height: last.current.heights.get(entry.row.child.id) ?? 0 }]);
    const duration = motionDurationMs("--motion-surface");
    if (gone.length === 0 || duration === 0) return;
    const ids = new Set(gone.map((entry) => entry.row.child.id));
    setLeaving((current) => [...current.filter((entry) => !ids.has(entry.row.child.id)), ...gone]);
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setLeaving((current) => current.filter((entry) => !ids.has(entry.row.child.id)));
    }, duration);
    timers.current.add(timer);
  }, [key]);
  // After the diff above: the next change compares against this commit's
  // rows and their rendered heights.
  useLayoutEffect(() => {
    const heights = new Map<string, number>();
    for (const item of list.current?.querySelectorAll<HTMLElement>(":scope > [data-row]:not([data-leaving])") ?? []) {
      heights.set(item.dataset.row!, item.getBoundingClientRect().height);
    }
    last.current = { rows: shown, heights };
  });
  useEffect(() => () => {
    for (const timer of timers.current) window.clearTimeout(timer);
  }, []);
  return leaving;
}

/** The branch: a row per active subagent on the thread, the ones waiting for
 *  the person first. Rows that arrive after the list first painted rise in,
 *  rows that leave fold away, and a state change swaps the mark and controls
 *  in place. */
function BranchList({ branch }: { branch: BranchState }) {
  const list = useRef<HTMLUListElement>(null);
  const listed = branch.showAll ? branch.rows : branch.rows.slice(0, LISTED_ROWS);
  const hidden = branch.rows.length - listed.length;
  const current: ShownRow[] = listed.map((row) => ({ row, detail: rowDetail(row, branch) }));
  const present = new Set(listed.map((row) => row.child.id));
  const leaving = useLeavingRows(current, list).filter((entry) => !present.has(entry.row.child.id));
  const shown: Array<ShownRow & { leaving?: LeavingRow }> = [...current];
  for (const entry of [...leaving].sort((left, right) => left.index - right.index)) {
    shown.splice(Math.min(entry.index, shown.length), 0, { ...entry, leaving: entry });
  }
  // The rows of the first paint do not animate; later ones do.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <ul ref={list} className="subagent-branch-list" data-settled={settled ? "" : undefined} aria-label={subagentActivityLabel(branch.activity)}>
      {shown.map(({ row, detail, leaving: gone }) => (
        <li
          key={row.child.id}
          className="subagent-branch-item"
          data-row={row.child.id}
          data-state={row.state}
          data-ask={row.ask ? "" : undefined}
          data-leaving={gone ? "" : undefined}
          inert={gone ? true : undefined}
          aria-hidden={gone ? true : undefined}
          style={gone ? { "--branch-leave-height": `${gone.height}px` } as CSSProperties : undefined}
        >
          <div className="subagent-branch-cell">
            <div className="subagent-branch-row" data-ask={row.ask ? "" : undefined}>
              <button
                type="button"
                className="subagent-branch-open"
                aria-label={`${tr("sidebar.sessionlist.openValue", { displayTitle: row.title })}, ${detail.map((part) => part.text).join(" · ")}`}
                onClick={() => openChild(row.child.id)}
              >
                <span className="subagent-branch-mark" data-state={row.state}><RowMark key={markKey(row)} row={row} /></span>
                <span className="subagent-branch-copy" aria-hidden="true">
                  <bdi className="subagent-branch-title" dir="auto">{row.title}</bdi>
                  <Detail parts={detail} className="subagent-branch-detail" />
                </span>
              </button>
              <RowActions key={row.ask ? "ask" : row.state} row={row} branch={branch} />
            </div>
          </div>
        </li>
      ))}
      {hidden > 0 && (
        <li className="subagent-branch-item subagent-branch-item--more">
          <button type="button" className="subagent-branch-show-all" onClick={() => branch.setShowAll(true)}>
            {tr("subagentdock.more", { count: hidden })}
          </button>
        </li>
      )}
    </ul>
  );
}

/**
 * Hangs the open chat's active subagents from a status line. Outside a
 * SubagentBranchScope (the dock placed elsewhere) or with no active subagent
 * it returns the line unchanged.
 */
export function SubagentBranchIsland({ children }: { children: ReactElement }) {
  const branch = useContext(BranchContext);
  if (!branch) return children;
  return (
    <section
      className="subagent-island"
      data-tone={branch.tone}
      aria-label={tr("sidebar.sessionlist.subagentsTitle")}
    >
      <div className="subagent-island-line">{children}</div>
      <BranchList branch={branch} />
    </section>
  );
}

/** The agent's own line while it idles and its subagents still work. */
export default function SubagentActivityDock() {
  const branch = useContext(BranchContext);
  const models = useStore((state) => state.models);
  if (!branch) return null;
  const ref = branch.parent?.model;
  const presentation = ref
    ? resolveModelPresentation(ref, models, branch.parent?.resolvedHarnessId)
    : { descriptor: undefined, name: tr("timeline.agent") };
  // Only paused subagents left: nothing runs until the person continues one.
  const status = tr(branch.tone === "paused" ? "subagentdock.subagentsPaused" : "subagentdock.waitingForSubagents");
  const profileId = branch.parent?.resolvedHarnessId ?? presentation.descriptor?.harnessId;
  return (
    <SubagentBranchIsland>
      <AgentStatusDock
        idle
        icon={<ProviderLogo
          providerID={presentation.descriptor?.providerID ?? ref?.providerID}
          providerName={presentation.descriptor?.providerName}
          harnessId={presentation.descriptor?.harnessId ?? branch.parent?.resolvedHarnessId}
          size="regular"
          tint={profileId ? branch.harnessColors.get(profileId) : undefined}
        />}
        model={presentation.name}
        status={status}
        label={`${presentation.name}: ${status}`}
        onClick={(event) => toggleSessionStatusPopover(event.currentTarget, "dock")}
      />
    </SubagentBranchIsland>
  );
}
