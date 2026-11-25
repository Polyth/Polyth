import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "./timelineCard.css";
import type { WorkflowRunDto, WorkflowRunNodeDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { openSession } from "../../../apps/web/src/init.ts";
import { Icon } from "../../../apps/web/src/icons.tsx";
import { getState, openWorkspacePane, setUiError, useStore } from "../../../apps/web/src/store.ts";
import { modelSupportsTextWorkflow } from "../../../apps/web/src/composer/discovery.ts";
import { listSurfaces, useSurfaceVersion } from "../../../apps/web/src/surfaces.ts";
import { handOffWorkflowLaunch } from "./workflowLaunch.ts";
import { publishWorkflowRun, subscribeWorkflowRuns } from "./workflowMonitor.ts";
import { ReviewDecision, ReviewFindings } from "./ReviewFindings.tsx";
import { WorkflowRunOutcome } from "./WorkflowRunOutcome.tsx";
import { RetryControls, type RetryFn } from "./WorkflowRunUnits.tsx";
import { workflowRunRouteText } from "./workflowLabels.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import {
  fresherWorkflowRun,
  workflowDisplayText,
  workflowFinishedCount,
  workflowHumanWait,
  workflowNeedsFix,
  workflowNodeDetail,
  workflowNodeFinished,
  workflowSentBackRoles,
  workflowNeedsDecision,
  workflowRoundLabel,
  workflowStatusLabel,
  workflowTimelineNodes,
  workflowUncertainReviews,
  workflowUnresolvedReviews,
} from "./workflowRun.ts";
import { formatNumber, tr } from "../../../apps/web/src/i18n/index.ts";
import {
  Button,
  ChatIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  IconButton,
  RefreshIcon,
  ShieldAlertIcon,
  Spinner,

  UndoIcon,
  WarningIcon,
  WrenchIcon,
} from "../../../apps/web/src/components/ui/index.ts";

/** A person is needed: an approval or answer in the unit's chat, a fix
 * (another route) for a unit the run holds, or a call on a review whose
 * rounds ran out. */
const needsHuman = (node: WorkflowRunNodeDto): boolean =>
  workflowHumanWait(node) !== null || workflowNeedsFix(node) || workflowNeedsDecision(node);

function TimelineStatusIcon({ node }: { node: WorkflowRunNodeDto }) {
  // A wait on a person is neither progress (spinner) nor done (check).
  const wait = workflowHumanWait(node);
  if (wait === "permission") return <ShieldAlertIcon aria-hidden="true" />;
  if (wait === "answer") return <Icon.question />;
  if (workflowNeedsFix(node)) return <WrenchIcon aria-hidden="true" />;
  if (workflowNeedsDecision(node)) return <WarningIcon aria-hidden="true" />;
  if (node.status === "done") return node.verdict === "changes-requested" ? <UndoIcon /> : node.judgment?.verdict === "uncertain" ? <Icon.question /> : <Icon.check />;
  if (node.status === "error") return <Icon.close />;
  if (node.status === "stopped") return <Icon.stop />;
  if (node.status === "skipped") return <Icon.branch />;
  if (node.status === "running") return <Spinner size="sm" />;
  return <Icon.clock />;
}

/** Long requests stay a calm two-line preview until the reader asks for more. */
const LONG_REQUEST = 140;

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (value: number) => formatNumber(value, { minimumIntegerDigits: 2 });
  return hours > 0
    ? `${formatNumber(hours)}:${two(minutes)}:${two(seconds)}`
    : `${formatNumber(minutes)}:${two(seconds)}`;
}

/** Ticks once a second only while something is live, so a settled card never
 * re-renders on a timer. Isolated so the clock does not re-render the rows. */
function Elapsed({ from, to }: { from?: number; to?: number }) {
  const live = typeof from === "number" && to === undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  if (typeof from !== "number") return null;
  return <time className="workflow-timeline-elapsed">{formatElapsed((to ?? now) - from)}</time>;
}

function nodeSegmentTone(node: WorkflowRunNodeDto): string {
  if (needsHuman(node)) return "attention";
  if (node.status === "done" && node.verdict === "changes-requested") return "rework";
  if (node.status === "done" && node.judgment?.verdict === "uncertain") return "attention";
  return node.status;
}

/** A row offers details only when they add something the one-line summary hides. */
function nodeHasDetails(node: WorkflowRunNodeDto, detail: string): boolean {
  return !!node.routedRole || !!node.findings?.length || (!!node.decision && node.decision !== "another-round") || !!workflowDisplayText(node.output)
    || !!node.model?.modelID || !!node.agent || node.harness?.mode === "pinned"
    || typeof node.startedAt === "number" || detail.length > 48;
}

function NodeFacts({ node, detail, decide }: { node: WorkflowRunNodeDto; detail: string; decide: boolean }) {
  const route = workflowRunRouteText(node);
  const output = workflowDisplayText(node.output);
  const facts: Array<[string, string]> = [];
  if (node.model?.modelID) facts.push([tr("workflowview.model"), node.model.modelID]);
  if (node.agent) facts.push([tr("workflowview.agent"), node.agent]);
  if (node.harness?.mode === "pinned") facts.push([tr("workflowview.harness"), node.harness.harnessId]);
  return (
    <div className="workflow-timeline-node-details">
      {detail && <p>{detail}</p>}
      {route && <p>{route}</p>}
      {node.decision && node.decision !== "another-round" && (
        <p>{tr(node.decision === "accepted" ? "workflowview.reviewAccepted" : "workflowview.reviewTimedOut")}</p>
      )}
      {(facts.length > 0 || typeof node.startedAt === "number") && (
        <dl>
          {facts.map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
          ))}
          {typeof node.startedAt === "number" && (
            <div>
              <dt>{tr("workflowtimeline.elapsed")}</dt>
              <dd><Elapsed from={node.startedAt} to={node.finishedAt ?? (node.status === "running" ? undefined : node.startedAt)} /></dd>
            </div>
          )}
        </dl>
      )}
      {node.status === "done" && node.findings && node.findings.length > 0 && (
        <ReviewFindings findings={decide ? node.findings.filter((finding) => finding.severity !== "blocker") : node.findings} />
      )}
      {/* The report reads at once with the unit's details: opening the card
          and the unit are the two steps, never a third fold. */}
      {output && (
        <section className="workflow-run-unit-report" aria-label={tr("workflowview.report")}>
          <h4>{tr("workflowview.report")}</h4>
          <pre className="workflow-node-output">{output}</pre>
        </section>
      )}
    </div>
  );
}

export default function WorkflowTimelineCard({ run, harnessSlot }: {
  run: WorkflowRunDto;
  /** The composer's harness picker, offered where a held unit gets another route. */
  harnessSlot?: (context: Record<string, unknown>) => ReactNode;
}) {
  // History can render before the lazy workflow package registers its surface.
  // Keep the handoff unavailable until the shared host can accept it.
  useSurfaceVersion();
  const canViewWorkflow = listSurfaces().some((surface) => surface.id === "workflow"
    && surface.presentation?.kind === "workspace");
  const [stopping, setStopping] = useState(false);
  const [retryingNode, setRetryingNode] = useState("");
  const [apiRun, setApiRun] = useState<WorkflowRunDto | null>(null);
  const [expanded, setExpanded] = useState(false);
  // The card folds to its header and one summary line until someone opens it.
  const [open, setOpen] = useState(false);
  const [openingSessionId, setOpeningSessionId] = useState("");
  const [openDetails, setOpenDetails] = useState<ReadonlySet<string>>(() => new Set());
  const [requestOpen, setRequestOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const globalModels = useStore((state) => state.models);
  const textModels = useMemo(() => globalModels.filter(modelSupportsTextWorkflow), [globalModels]);
  const spaceId = useStore((state) =>
    state.projectRegistry.projects.find((project) => project.id === (run.projectId ?? state.activeProjectId))?.spaceId) ?? "";
  const retryKey = useRef<{ intent: string; clientOperationId: string } | null>(null);
  const startKey = useRef<string | null>(null);
  const pendingAction = useRef(false);
  const generation = useRef(0);
  const freshest = fresherWorkflowRun(apiRun, run) ?? run;
  // A record or decision the person just made shows at once; the event that
  // confirms it replaces it a moment later.
  const shownRun = apiRun?.id === freshest.id && apiRun.outcome && (!freshest.outcome || apiRun.outcome.at > freshest.outcome.at)
    ? { ...freshest, outcome: apiRun.outcome }
    : freshest;
  useEffect(() => {
    setApiRun(null);
    setExpanded(false);
    setOpen(false);
    setOpeningSessionId("");
    setOpenDetails(new Set());
    setRequestOpen(false);
    setRetryingNode("");
    setStarting(false);
    retryKey.current = null;
    startKey.current = null;
    pendingAction.current = false;
    generation.current += 1;
    return () => { generation.current += 1; };
  }, [run.id]);
  // Outcome and decision calls made inside the card publish their result.
  useEffect(() => subscribeWorkflowRuns((next) => { if (next.id === run.id) setApiRun(next); }), [run.id]);
  useEffect(() => {
    if (shownRun.status !== "running") return;
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    let inFlight = false;
    const poll = () => {
      if (!active || inFlight) return;
      inFlight = true;
      void api.getWorkflowRun(shownRun.id).then((fresh) => {
        if (!active || fresh.id !== shownRun.id) return;
        setApiRun(fresh);
        publishWorkflowRun(fresh);
        if (fresh.status !== "running" && timer) clearInterval(timer);
      }).catch(() => { /* WebSocket/event replay remains authoritative. */ })
        .finally(() => { inFlight = false; });
    };
    poll();
    timer = setInterval(poll, 5000);
    window.addEventListener("focus", poll);
    window.addEventListener("online", poll);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", poll);
      window.removeEventListener("online", poll);
    };
  }, [shownRun.id, shownRun.status]);
  const complete = workflowFinishedCount(shownRun);
  const result = workflowDisplayText(shownRun.result);
  const running = shownRun.status === "running";
  // The chat's agent started this run and is woken to steer it: fixes and
  // review calls are its job, so the card stays an observer's line. An
  // approval or answer inside a unit's chat still needs the person.
  const agentSteered = shownRun.wake === true;
  const personNeeded = (node: WorkflowRunNodeDto): boolean =>
    agentSteered ? workflowHumanWait(node) !== null : needsHuman(node);
  const waiting = running ? shownRun.nodes.filter(personNeeded) : [];
  const agentHandling = running && agentSteered ? shownRun.nodes.filter((node) => needsHuman(node) && !personNeeded(node)) : [];
  // Rows a person must see without opening the card: the ones waiting on
  // them, or a settled run's failed units that can be retried.
  const attentionNodes = running
    ? waiting
    : shownRun.nodes.filter((node) => node.retryable && node.status === "error");
  const focusNode = shownRun.nodes.find((node) => node.status === "running")
    ?? shownRun.nodes.find((node) => !workflowNodeFinished(node));
  // A failed run says why without being opened: the first failed unit that is
  // not already shown as a row to retry.
  const failedNode = !running && shownRun.status === "error"
    ? shownRun.nodes.find((node) => node.status === "error" && !attentionNodes.includes(node))
    : undefined;
  const unresolved = workflowUnresolvedReviews(shownRun);
  const uncertain = workflowUncertainReviews(shownRun);
  const visibleWindow = workflowTimelineNodes(shownRun, expanded);
  const listedNodes = open ? visibleWindow.nodes : attentionNodes;
  const toggleDetails = (nodeId: string) => setOpenDetails((current) => {
    const next = new Set(current);
    if (!next.delete(nodeId)) next.add(nodeId);
    return next;
  });
  const longRequest = shownRun.input.length > LONG_REQUEST || shownRun.input.includes("\n");
  // A review that sent work back shows as the round the units are now on.
  const reworkRound = shownRun.status === "running"
    ? Math.max(0, ...shownRun.nodes.filter((node) => node.status === "running").map((node) => node.round ?? 1))
    : 0;
  const nodeDetail = (node: WorkflowRunNodeDto): string => {
    if (agentSteered && running && (workflowNeedsFix(node) || workflowNeedsDecision(node))) {
      const round = (node.round ?? 1) > 1 ? `${workflowRoundLabel(node.round!)} · ` : "";
      return round + tr(workflowNeedsFix(node) ? "workflowtimeline.heldForFix" : "workflowtimeline.roundsUsedUp");
    }
    if (workflowNeedsFix(node) && shownRun.status === "running") return tr("workflowtimeline.waitingForYourFix");
    const detail = workflowNodeDetail(node);
    const sentBack = node.status === "done" ? workflowSentBackRoles(shownRun, node) : [];
    return sentBack.length ? `${detail} · ${tr("workflowview.sentBackTo", { roles: sentBack.join(", ") })}` : detail;
  };

  const stop = () => {
    if (pendingAction.current || shownRun.status !== "running") return;
    pendingAction.current = true;
    const currentGeneration = generation.current;
    setStopping(true);
    void api.stopWorkflowRun(shownRun.id)
      .then((stopped) => {
        if (generation.current !== currentGeneration) return;
        setApiRun(stopped);
        publishWorkflowRun(stopped);
      })
      .catch((cause) => {
        if (generation.current === currentGeneration) setUiError(friendlyError(tr("workflowview.stopRun"), cause));
      })
      .finally(() => {
        if (generation.current !== currentGeneration) return;
        pendingAction.current = false;
        setStopping(false);
      });
  };

  const retryNode: RetryFn = (nodeId, replacement, saveToWorkflow) => {
    const node = shownRun.nodes.find((candidate) => candidate.id === nodeId);
    if (pendingAction.current || !node?.retryable) return;
    pendingAction.current = true;
    const currentGeneration = generation.current;
    const intent = JSON.stringify([shownRun.id, node.id, replacement, !!saveToWorkflow]);
    const clientOperationId = retryKey.current?.intent === intent
      ? retryKey.current.clientOperationId
      : (() => {
      const id = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `workflow-retry-${Date.now()}`;
      retryKey.current = { intent, clientOperationId: id };
      return id;
    })();
    setRetryingNode(node.id);
    void api.retryWorkflowRun(shownRun.id, {
      nodeId: node.id,
      clientOperationId,
      ...(replacement ? { replacement } : {}),
      ...(replacement && saveToWorkflow ? { saveToWorkflow: true } : {}),
    })
      .then((retried) => {
        if (generation.current !== currentGeneration) return;
        retryKey.current = null;
        setApiRun(retried);
        publishWorkflowRun(retried);
      })
      .catch((cause) => {
        if (generation.current === currentGeneration) setUiError(friendlyError(tr("trackspanel.retryStep"), cause));
      })
      .finally(() => {
        if (generation.current !== currentGeneration) return;
        pendingAction.current = false;
        setRetryingNode("");
      });
  };

  /** A done run starts again with its own request, here in this chat. A failed
   * or stopped run offers no one-click replay: the next run is a new request
   * from the composer. */
  const runAgain = () => {
    if (pendingAction.current || shownRun.status !== "done" || !shownRun.parentSessionId) return;
    pendingAction.current = true;
    const currentGeneration = generation.current;
    const clientOperationId = startKey.current ?? (startKey.current = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `workflow-run-${Date.now()}`);
    setStarting(true);
    void api.runWorkflow(shownRun.workflowId, shownRun.parentSessionId, shownRun.input, shownRun.options, {
      clientOperationId,
      context: "request",
    })
      .then((started) => {
        if (generation.current !== currentGeneration) return;
        startKey.current = null;
        publishWorkflowRun(started);
      })
      .catch((cause) => {
        if (generation.current === currentGeneration) setUiError(friendlyError(tr("workflowview.couldNotStartWorkflow"), cause));
      })
      .finally(() => {
        if (generation.current !== currentGeneration) return;
        pendingAction.current = false;
        setStarting(false);
      });
  };

  const openChildSession = async (sessionId: string) => {
    if (openingSessionId) return;
    setOpeningSessionId(sessionId);
    try {
      await openSession(sessionId);
    } catch (cause) {
      setUiError(friendlyError(tr("workflowview.openSession"), cause));
      setOpeningSessionId("");
    }
  };

  const openSettings = () => {
    const projectId = shownRun.projectId ?? getState().activeProjectId;
    if (projectId) {
      handOffWorkflowLaunch({ projectId, workflowId: shownRun.workflowId });
    }
    openWorkspacePane("workflow");
  };

  // One summary line under the header says where the run stands.
  const firstAgentWait = agentHandling[0];
  const summary: ReactNode = running
    ? waiting.length > 0
      ? (
        <strong className="workflow-timeline-waiting">
          {tr(waiting.length === 1 ? "workflowtimeline.waitingOne" : "workflowtimeline.waitingOther", { count: waiting.length })}
        </strong>
      )
      : firstAgentWait
        ? (
          <span className="workflow-timeline-agent">
            {`${tr("workflowtimeline.agentOnIt")} · ${firstAgentWait.role}: ${tr(workflowNeedsFix(firstAgentWait) ? "workflowtimeline.heldForFix" : "workflowtimeline.roundsUsedUp")}`}
          </span>
        )
        : focusNode
          ? <span className="workflow-timeline-now" title={workflowNodeDetail(focusNode)}>{`${focusNode.role} · ${workflowNodeDetail(focusNode)}`}</span>
          : null
    : null;
  const totalLabel = tr("workflowtimeline.nodesFinished", { complete, total: shownRun.nodes.length });
  // A settled run's record reads as text; the choice is asked of the person
  // who started it, and of an agent-steered run's reader only while nothing
  // was recorded. Change waits in the opened card when the agent recorded it.
  const outcomeReadOnly = !open && agentSteered && !!shownRun.outcome;
  const tone = waiting.length > 0 ? "attention" : agentHandling.length > 0 ? "agent" : shownRun.status;

  return (
    <section
      className={`workflow-timeline-card status-${shownRun.status} tone-${tone}${waiting.length ? " has-attention" : ""}${
        agentSteered ? " is-agent-steered" : ""}${open ? " is-open" : ""}`}
      aria-label={tr("workflowtimeline.valueLabel", {
        name: shownRun.name,
        status: workflowStatusLabel(shownRun.status),
      })}
    >
      <header>
        <span className="workflow-timeline-icon" aria-hidden="true"><Icon.workflow /></span>
        <span className="workflow-timeline-title">
          <strong title={shownRun.name}>{shownRun.name}</strong>
          <b className={`workflow-timeline-pill status-${shownRun.status}`} role="status" aria-live="polite">
            {workflowStatusLabel(shownRun.status)}
          </b>
        </span>
        <Elapsed from={shownRun.startedAt} to={running ? undefined : shownRun.finishedAt ?? shownRun.startedAt} />
        <IconButton
          size="sm"
          variant="ghost"
          icon={ChevronDownIcon}
          className="workflow-timeline-toggle"
          label={tr("workflowtimeline.showRunValue", { name: shownRun.name })}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        />
      </header>
      {running && (
        <div className="workflow-timeline-overview">
          <div className="workflow-timeline-summary">
            {summary}
            {reworkRound > 1 && waiting.length === 0 && !firstAgentWait && (
              <em>{tr("workflowtimeline.reworkRound", { round: reworkRound })}</em>
            )}
            {firstAgentWait && !open && (
              <Button
                size="sm"
                variant="ghost"
                className="workflow-timeline-step-in"
                onClick={() => setOpen(true)}
              >
                {tr("workflowtimeline.stepIn")}
              </Button>
            )}
            <span className="workflow-timeline-count" aria-label={totalLabel} title={totalLabel}>
              {`${formatNumber(complete)}/${formatNumber(shownRun.nodes.length)}`}
            </span>
          </div>
          <div
            className="workflow-timeline-progress"
            role="progressbar"
            aria-label={tr("workflowtimeline.progress")}
            aria-valuemin={0}
            aria-valuemax={shownRun.nodes.length}
            aria-valuenow={complete}
            aria-valuetext={totalLabel}
          >
            {shownRun.nodes.map((node) => (
              <i key={node.id} className={`tone-${agentSteered && !personNeeded(node) && needsHuman(node) ? "running" : nodeSegmentTone(node)}`} />
            ))}
          </div>
        </div>
      )}
      {failedNode && !open && (
        <div className="workflow-timeline-overview">
          <div className="workflow-timeline-summary">
            <span className="workflow-timeline-now" title={failedNode.error?.trim() || undefined}>
              {`${failedNode.role} · ${failedNode.error?.trim().replace(/\s+/g, " ") || workflowNodeDetail(failedNode)}`}
            </span>
          </div>
        </div>
      )}
      {result && (
        <div className="workflow-timeline-result">
          <p>{result}</p>
        </div>
      )}
      {open && (longRequest ? (
        <button
          type="button"
          className="workflow-timeline-input"
          aria-expanded={requestOpen}
          onClick={() => setRequestOpen((current) => !current)}
        >
          <span>{shownRun.input}</span>
          <ChevronDownIcon aria-hidden="true" />
        </button>
      ) : (
        <p className="workflow-timeline-input">{shownRun.input}</p>
      ))}
      {open && unresolved.length > 0 && (
        <p className="workflow-timeline-note" role="status">
          {tr("workflowview.reviewUnresolvedValue", { roles: unresolved.map((node) => node.role).join(", ") })}
        </p>
      )}
      {open && uncertain.length > 0 && (
        <p className="workflow-timeline-note" role="status">
          {tr("workflowview.reviewUncertainValue", { roles: uncertain.map((node) => node.role).join(", ") })}
        </p>
      )}
      {listedNodes.length > 0 && (
      <ul
        className="workflow-timeline-nodes"
        aria-label={expanded ? tr("workflowtimeline.allNodes") : tr("workflowtimeline.focusedNodes")}
      >
        {listedNodes.map((node) => {
          const held = workflowNeedsFix(node) && running;
          // The decision card opens right under its row while a gate waits.
          const decide = workflowNeedsDecision(node) && running;
          const human = running && personNeeded(node);
          const handledByAgent = running && agentSteered && needsHuman(node) && !human;
          const detail = nodeDetail(node);
          const hasDetails = nodeHasDetails(node, detail);
          const detailsOpen = hasDetails && openDetails.has(node.id);
          // A held unit is fixed right under its row (another route, kept for
          // later runs if wanted); a settled run's unit retries from here.
          const retry = node.retryable && node.status === "error" && !running;
          const primary = Boolean(node.sessionId && human && !held && !decide) || Boolean(retry);
          return (
            <li
              key={node.id}
              className={`status-${node.status}${human ? " needs-human" : ""}${held ? " needs-fix" : ""}${handledByAgent ? " agent-handling" : ""}${
                node.status === "done" && (node.verdict ?? (node.judgment?.verdict === "uncertain" ? "uncertain" : undefined)) ? ` verdict-${node.verdict ?? "uncertain"}` : ""}${
                detailsOpen ? " details-open" : ""}${primary ? " has-primary" : ""}`}
            >
              <span className="workflow-timeline-status-icon" aria-hidden="true">
                <TimelineStatusIcon node={node} />
              </span>
              <span className="workflow-timeline-node-copy">
                <strong>{node.role}</strong>
                <small title={detail}>{detail}</small>
              </span>
              {primary && (
                <span className="workflow-timeline-node-actions">
                  {node.sessionId && human && !held && !decide && (
                    <Button
                      size="sm"
                      variant="primary"
                      iconStart={ChatIcon}
                      disabled={!!openingSessionId}
                      busy={openingSessionId === node.sessionId}
                      aria-label={tr("workflowtimeline.reviewAndRespondValue", { role: node.role })}
                      onClick={() => void openChildSession(node.sessionId!)}
                    >
                      {tr("workflowtimeline.reviewAndRespond")}
                    </Button>
                  )}
                  {retry && (
                    <Button
                      size="sm"
                      variant="quiet"
                      iconStart={RefreshIcon}
                      busy={retryingNode === node.id}
                      disabled={!!retryingNode}
                      onClick={() => retryNode(node.id)}
                    >
                      {tr("trackspanel.retryStep")}
                    </Button>
                  )}
                </span>
              )}
              <span className="workflow-timeline-node-tools">
                {node.sessionId && (!human || held || decide) && (
                  <IconButton
                    size="sm"
                    variant="ghost"
                    icon={ChatIcon}
                    className="workflow-timeline-open"
                    label={tr("workflowtimeline.openChildValue", { role: node.role })}
                    disabled={!!openingSessionId}
                    busy={openingSessionId === node.sessionId}
                    onClick={() => void openChildSession(node.sessionId!)}
                  />
                )}
                {hasDetails && (
                  <IconButton
                    size="sm"
                    variant="ghost"
                    icon={ChevronDownIcon}
                    className="workflow-timeline-details-toggle"
                    label={tr("workflowtimeline.detailsValue", { role: node.role })}
                    aria-expanded={detailsOpen}
                    onClick={() => toggleDetails(node.id)}
                  />
                )}
              </span>
              {detailsOpen && <NodeFacts node={node} detail={detail} decide={decide} />}
              {((held && node.retryable) || decide) && (
                <div className="workflow-timeline-node-body">
                  {held && node.error && <p className="workflow-timeline-node-reason">{node.error}</p>}
                  {held && node.retryable && (
                    <RetryControls
                      node={node}
                      runStatus={shownRun.status}
                      busy={!!retryingNode}
                      models={textModels}
                      {...(harnessSlot ? { harnessSlot } : {})}
                      projectId={shownRun.projectId ?? ""}
                      spaceId={spaceId}
                      onRetry={retryNode}
                      primary={!agentSteered}
                    />
                  )}
                  {decide && <ReviewDecision run={shownRun} node={node} primary={!agentSteered} />}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      )}
      <WorkflowRunOutcome run={shownRun} readOnly={outcomeReadOnly} />
      {open && shownRun.nodes.length > 6 && (
        <div className="workflow-timeline-disclosure">
          <span className="workflow-timeline-range">
            {tr("workflowtimeline.nodeRange", {
              start: visibleWindow.start,
              end: visibleWindow.end,
              total: visibleWindow.total,
            })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="workflow-timeline-nodes-toggle"
            iconStart={expanded ? ChevronUpIcon : ChevronDownIcon}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded
              ? tr("workflowtimeline.showFocused")
              : tr("workflowtimeline.showAllValue", { count: shownRun.nodes.length })}
          </Button>
        </div>
      )}
      {open && (
        <footer>
          <Button
            size="sm"
            variant="ghost"
            disabled={!!openingSessionId || !canViewWorkflow}
            onClick={openSettings}
          >
            {tr("workflowtimeline.workflowSettings")}
          </Button>
          {shownRun.status === "done" && shownRun.parentSessionId && (
            <Button
              size="sm"
              variant="ghost"
              busy={starting}
              disabled={starting}
              onClick={runAgain}
            >
              {tr("workflowview.runAgain")}
            </Button>
          )}
          {running && (
            <Button
              size="sm"
              variant="ghost"
              className="workflow-timeline-stop"
              busy={stopping}
              disabled={stopping}
              aria-label={tr("workflowtimeline.stopValue", { name: shownRun.name })}
              onClick={stop}
            >
              {tr("workflowtimeline.stopRun")}
            </Button>
          )}
        </footer>
      )}
    </section>
  );
}
