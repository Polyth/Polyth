import { useEffect, useRef, useState } from "react";
import "./timelineCard.css";
import type { WorkflowRunDto, WorkflowRunNodeDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { openSession } from "../../../apps/web/src/init.ts";
import { Icon } from "../../../apps/web/src/icons.tsx";
import { getState, openWorkspacePane, setUiError } from "../../../apps/web/src/store.ts";
import { listSurfaces, useSurfaceVersion } from "../../../apps/web/src/surfaces.ts";
import { handOffWorkflowLaunch } from "./workflowLaunch.ts";
import { publishWorkflowRun } from "./workflowMonitor.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import {
  fresherWorkflowRun,
  workflowDisplayText,
  workflowFinishedCount,
  workflowHumanWait,
  workflowNeedsFix,
  workflowNodeDetail,
  workflowSentBackRoles,
  workflowNeedsDecision,
  workflowStatusLabel,
  workflowTimelineNodes,
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
  StopIcon,
  TreeViewIcon,
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
  return !!node.model?.modelID || !!node.agent || node.harness?.mode === "pinned"
    || typeof node.startedAt === "number" || detail.length > 48;
}

function NodeFacts({ node, detail }: { node: WorkflowRunNodeDto; detail: string }) {
  const facts: Array<[string, string]> = [];
  if (node.model?.modelID) facts.push([tr("workflowview.model"), node.model.modelID]);
  if (node.agent) facts.push([tr("workflowview.agent"), node.agent]);
  if (node.harness?.mode === "pinned") facts.push([tr("workflowview.harness"), node.harness.harnessId]);
  return (
    <div className="workflow-timeline-node-details">
      {detail && <p>{detail}</p>}
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
    </div>
  );
}

export default function WorkflowTimelineCard({ run }: { run: WorkflowRunDto }) {
  // History can render before the lazy workflow package registers its surface.
  // Keep the handoff unavailable until the shared host can accept it.
  useSurfaceVersion();
  const canViewWorkflow = listSurfaces().some((surface) => surface.id === "workflow"
    && surface.presentation?.kind === "workspace");
  const [stopping, setStopping] = useState(false);
  const [retryingNode, setRetryingNode] = useState("");
  const [apiRun, setApiRun] = useState<WorkflowRunDto | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [openingSessionId, setOpeningSessionId] = useState("");
  const [openDetails, setOpenDetails] = useState<ReadonlySet<string>>(() => new Set());
  const [requestOpen, setRequestOpen] = useState(false);
  const retryKey = useRef<{ runId: string; nodeId: string; clientOperationId: string } | null>(null);
  const pendingAction = useRef(false);
  const generation = useRef(0);
  const shownRun = fresherWorkflowRun(apiRun, run) ?? run;
  useEffect(() => {
    setApiRun(null);
    setExpanded(false);
    setOpeningSessionId("");
    setOpenDetails(new Set());
    setRequestOpen(false);
    setRetryingNode("");
    retryKey.current = null;
    pendingAction.current = false;
    generation.current += 1;
    return () => { generation.current += 1; };
  }, [run.id]);
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
  const waiting = shownRun.nodes.filter(needsHuman);
  const visibleWindow = workflowTimelineNodes(shownRun, expanded);
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

  const retryNode = (node: WorkflowRunNodeDto) => {
    if (pendingAction.current || !node.retryable) return;
    pendingAction.current = true;
    const currentGeneration = generation.current;
    const previous = retryKey.current;
    const clientOperationId = previous?.runId === shownRun.id && previous.nodeId === node.id
      ? previous.clientOperationId
      : (() => {
      const id = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `workflow-retry-${Date.now()}`;
      retryKey.current = { runId: shownRun.id, nodeId: node.id, clientOperationId: id };
      return id;
    })();
    setRetryingNode(node.id);
    void api.retryWorkflowRun(shownRun.id, { nodeId: node.id, clientOperationId })
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

  const viewWorkflow = () => {
    const projectId = shownRun.projectId ?? getState().activeProjectId;
    if (projectId) {
      handOffWorkflowLaunch({
        projectId,
        ...(shownRun.parentSessionId ? { sessionId: shownRun.parentSessionId } : {}),
        workflowId: shownRun.workflowId,
        input: shownRun.input,
        run: shownRun,
      });
    }
    openWorkspacePane("workflow");
  };

  return (
    <section
      className={`workflow-timeline-card status-${shownRun.status}${waiting.length ? " has-attention" : ""}`}
      aria-label={tr("workflowtimeline.valueLabel", {
        name: shownRun.name,
        status: workflowStatusLabel(shownRun.status),
      })}
    >
      <header>
        <span className="workflow-timeline-icon" aria-hidden="true"><Icon.workflow /></span>
        <span className="workflow-timeline-title">
          <small>
            {tr("workflowtimeline.workflow")}
            <Elapsed from={shownRun.startedAt} to={shownRun.status === "running" ? undefined : shownRun.finishedAt ?? shownRun.startedAt} />
          </small>
          <strong title={shownRun.name}>{shownRun.name}</strong>
        </span>
        <b className={`workflow-timeline-pill status-${shownRun.status}`} role="status" aria-live="polite">
          <i aria-hidden="true" />
          {workflowStatusLabel(shownRun.status)}
        </b>
      </header>
      {longRequest ? (
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
      )}
      <div className="workflow-timeline-overview">
        <div
          className="workflow-timeline-progress"
          role="progressbar"
          aria-label={tr("workflowtimeline.progress")}
          aria-valuemin={0}
          aria-valuemax={shownRun.nodes.length}
          aria-valuenow={complete}
          aria-valuetext={tr("workflowtimeline.nodesFinished", { complete, total: shownRun.nodes.length })}
        >
          {shownRun.nodes.map((node) => (
            <i key={node.id} className={`tone-${nodeSegmentTone(node)}`} />
          ))}
        </div>
        <div className="workflow-timeline-summary">
          <span>{tr("workflowtimeline.nodesFinished", { complete, total: shownRun.nodes.length })}</span>
          {reworkRound > 1 && waiting.length === 0 && (
            <em>{tr("workflowtimeline.reworkRound", { round: reworkRound })}</em>
          )}
          {waiting.length > 0 && (
            <strong>
              {tr(waiting.length === 1 ? "workflowtimeline.waitingOne" : "workflowtimeline.waitingOther", {
                count: waiting.length,
              })}
            </strong>
          )}
        </div>
      </div>
      <ul
        className="workflow-timeline-nodes"
        aria-label={expanded ? tr("workflowtimeline.allNodes") : tr("workflowtimeline.focusedNodes")}
      >
        {visibleWindow.nodes.map((node) => {
          const held = workflowNeedsFix(node) && shownRun.status === "running";
          // The decision card lives in the run view; the card points there.
          const decide = workflowNeedsDecision(node) && shownRun.status === "running";
          const human = needsHuman(node);
          const detail = nodeDetail(node);
          const hasDetails = nodeHasDetails(node, detail);
          const detailsOpen = hasDetails && openDetails.has(node.id);
          // A held unit is fixed in the run view (another model, kept for later
          // runs if wanted); a settled run's unit retries from here.
          const retry = node.retryable && node.status === "error" && shownRun.status !== "running";
          const primary = Boolean(node.sessionId && human && !held && !decide) || Boolean(retry) || held || decide;
          return (
            <li
              key={node.id}
              className={`status-${node.status}${human ? " needs-human" : ""}${held ? " needs-fix" : ""}${
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
                  {held && (
                    <Button
                      size="sm"
                      variant="primary"
                      iconStart={WrenchIcon}
                      disabled={!canViewWorkflow}
                      aria-label={tr("workflowtimeline.fixValue", { role: node.role })}
                      onClick={viewWorkflow}
                    >
                      {tr("workflowtimeline.fix")}
                    </Button>
                  )}
                  {decide && (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!canViewWorkflow}
                      aria-label={tr("workflowtimeline.decideValue", { role: node.role })}
                      onClick={viewWorkflow}
                    >
                      {tr("workflowtimeline.decide")}
                    </Button>
                  )}
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
                      onClick={() => retryNode(node)}
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
              {detailsOpen && <NodeFacts node={node} detail={detail} />}
            </li>
          );
        })}
      </ul>
      {result && (
        <div className="workflow-timeline-result">
          <strong>{tr("workflowtimeline.result")}</strong>
          <p>{result}</p>
        </div>
      )}
      {shownRun.nodes.length > 6 && (
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
      <footer>
        <Button
          size="sm"
          variant="quiet"
          iconStart={TreeViewIcon}
          disabled={!!openingSessionId || !canViewWorkflow}
          onClick={viewWorkflow}
        >
          {tr("workflowtimeline.viewWorkflow")}
        </Button>
        {shownRun.status === "running" && (
          <Button
            size="sm"
            variant="danger"
            iconStart={StopIcon}
            busy={stopping}
            disabled={stopping}
            aria-label={tr("workflowtimeline.stopValue", { name: shownRun.name })}
            onClick={stop}
          >
            {tr("workflowtimeline.stopRun")}
          </Button>
        )}
      </footer>
    </section>
  );
}
