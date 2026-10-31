import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionEvent, SessionProjection } from "@polyth/contracts";
import { fmtCost, fmtDuration, fmtTokens } from "../format.ts";
import { tr, formatNumber } from "../i18n/index.ts";
import { contextUsageLabel, latestRequestExcerpt, reportedSessionUsage, sessionDurationMs, sessionMessageCounts } from "../sessionMetrics.ts";
import { useUiSettings } from "../uiPrefs.ts";
import { contextTone, formatContextPercent, type ContextGauge, type RenderModel, type TaskListState } from "../reduce.ts";
import { TabPanel, Tabs } from "./ui/index.ts";
import "./SessionActivityDetails.css";

type SessionTask = TaskListState["items"][number];
type DetailTab = "stats" | "content";

export interface SessionActivityDetailsProps {
  sessionTitle: string;
  /** Desktop status already supplies the identity row above the details. */
  showIdentity?: boolean;
  prompt?: string;
  modelName?: string | null;
  tasks: readonly SessionTask[];
  session: SessionProjection | null;
  model: RenderModel;
  usageEvents?: readonly SessionEvent[];
  gauge?: ContextGauge | null;
  contextNotice?: string | null;
}

/** Measure unclamped text so the largest readable size fits in two lines. */
function SessionActivityTitle({ title }: { title: string }) {
  const titleRef = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    const element = titleRef.current;
    if (!element) return;
    let disposed = false;
    const fit = () => {
      if (disposed || element.clientWidth === 0) return;
      element.style.removeProperty("font-size");
      const preferredSize = Number.parseFloat(getComputedStyle(element).fontSize);
      // Resolve the floor through CSS, including the user's text-size setting.
      element.style.fontSize = "var(--font-label)";
      const minimumSize = Math.min(preferredSize, Number.parseFloat(getComputedStyle(element).fontSize));
      element.style.webkitLineClamp = "unset";
      const fits = (size: number) => {
        element.style.fontSize = `${size}px`;
        const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
        return element.scrollHeight <= lineHeight * 2 + 1 && element.scrollWidth <= element.clientWidth;
      };
      let lower = minimumSize;
      let upper = preferredSize;
      if (fits(upper)) lower = upper;
      else {
        // A bounded search avoids a layout pass for every pixel of text size.
        for (let step = 0; step < 8; step += 1) {
          const size = (lower + upper) / 2;
          if (fits(size)) lower = size;
          else upper = size;
        }
      }
      element.style.fontSize = `${lower}px`;
      element.style.removeProperty("-webkit-line-clamp");
    };
    fit();
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    resize?.observe(element);
    // Font swaps and preference changes can change wrapping without a resize.
    const preferences = typeof MutationObserver === "function" ? new MutationObserver(fit) : null;
    preferences?.observe(document.body, { attributes: true, attributeFilter: ["style", "class"] });
    document.fonts?.addEventListener("loadingdone", fit);
    void document.fonts?.ready.then(fit);
    return () => {
      disposed = true;
      resize?.disconnect();
      preferences?.disconnect();
      document.fonts?.removeEventListener("loadingdone", fit);
    };
  }, [title]);

  return <h3 ref={titleRef} className="session-activity-title" title={title}>{title}</h3>;
}

function progressOf(tasks: readonly SessionTask[]): { done: number; failed: number; percent: number } {
  const done = tasks.filter((task) => task.status === "done").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  return { done, failed, percent: tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0 };
}

function TaskMark({ status }: { status: SessionTask["status"] }) {
  if (status === "done") return <span className="session-activity-task-mark is-done" aria-hidden="true">✓</span>;
  if (status === "failed") return <span className="session-activity-task-mark is-failed" aria-hidden="true">×</span>;
  if (status === "active") return <span className="session-activity-task-mark is-active" aria-hidden="true"><i /></span>;
  return <span className="session-activity-task-mark is-pending" aria-hidden="true" />;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="session-activity-stat">
      <span className="session-activity-stat-label">{label}</span>
      <strong className="session-activity-stat-value">{value}</strong>
    </div>
  );
}

/** The context-window card: used/limit, percent and a level-tinted meter.
 *  Shared by the session overview and the composer's context pie so both
 *  surfaces word and color the same gauge identically. */
export function ContextUsageCard({
  gauge,
  contextNotice,
  modelName,
}: Pick<SessionActivityDetailsProps, "gauge" | "contextNotice" | "modelName">) {
  const contextPercent = gauge?.percent ?? null;
  const contextPercentLabel = gauge ? formatContextPercent(gauge) : null;
  const contextValue = contextUsageLabel(gauge, contextPercentLabel, contextNotice, tr("common.unavailable"), fmtTokens);
  return (
    <div className="session-activity-context-card">
      <div className="session-activity-context-head">
        <div>
          <span className="session-activity-section-label">{tr("capabilities.context")}</span>
          <strong>{contextValue}</strong>
        </div>
        {contextPercentLabel && contextPercentLabel !== contextValue && <span className="session-activity-context-percent">{contextPercentLabel}</span>}
      </div>
      <div
        className={`session-activity-meter level-${gauge ? contextTone(gauge) : "unknown"}`}
        role="progressbar"
        aria-label={tr("capabilities.context")}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(contextPercentLabel && contextPercent !== null ? { "aria-valuenow": Math.min(100, Math.max(0, contextPercent)) } : { "aria-valuetext": contextValue })}
      >
        <span style={{ width: contextPercent === null ? "0%" : `${contextPercent}%` }} />
      </div>
      {modelName && <span className="session-activity-context-model">{modelName}</span>}
    </div>
  );
}

function UsagePanel({
  gauge,
  contextNotice,
  model,
  usageEvents,
  modelName,
  duration,
}: Pick<SessionActivityDetailsProps, "gauge" | "contextNotice" | "model" | "usageEvents" | "modelName"> & { duration: string }) {
  const usage = useMemo(() => reportedSessionUsage(model.totals, usageEvents), [model.totals, usageEvents]);
  const messageCount = sessionMessageCounts(model).visible;
  const tokenValue = (value: number | null) => value === null ? "—" : fmtTokens(value);
  return (
    <div className="session-activity-panel session-activity-usage">
      <ContextUsageCard gauge={gauge} contextNotice={contextNotice} modelName={modelName} />
      <div className="session-activity-stat-grid">
        <Stat label={tr("chatmetrics.tokens")} value={tokenValue(usage.tokens)} />
        <Stat label={tr("chatmetrics.messages")} value={formatNumber(messageCount)} />
        <Stat label={tr("timeline.input")} value={tokenValue(usage.input)} />
        <Stat label={tr("timeline.output")} value={tokenValue(usage.output)} />
        <Stat label={tr("sessionActivity.cacheRead")} value={tokenValue(usage.cacheRead)} />
        <Stat label={tr("sessionActivity.cacheWrite")} value={tokenValue(usage.cacheWrite)} />
        <Stat label={tr("chatmetrics.duration")} value={duration} />
        <Stat label={tr("timeline.cost")} value={usage.cost === null ? "—" : fmtCost(usage.cost)} />
      </div>
    </div>
  );
}

function ContentPanel({ prompt, tasks }: Pick<SessionActivityDetailsProps, "prompt" | "tasks">) {
  const latestRequest = latestRequestExcerpt(prompt);
  const progress = progressOf(tasks);
  return (
    <div className="session-activity-panel session-activity-content">
      <section className="session-activity-intent">
        <span className="session-activity-section-label">{tr("sessionActivity.latestRequestExcerpt")}</span>
        <p>{latestRequest || tr("mobile.island.noPrompt")}</p>
      </section>
      {tasks.length > 0 && (
        <section className="session-activity-plan">
          <div className="session-activity-section-head">
            <div>
              <span className="session-activity-section-label">{tr("timeline.currentTaskPlan")}</span>
              <strong>{`${formatNumber(progress.done)}/${formatNumber(tasks.length)} ${tr("timeline.completed").toLowerCase()}${progress.failed > 0 ? ` · ${formatNumber(progress.failed)} ${tr("timeline.failed")}` : ""}`}</strong>
            </div>
            <span className="session-activity-plan-percent">{progress.percent}%</span>
          </div>
          <div className="session-activity-meter session-activity-plan-meter" role="progressbar" aria-label={tr("timeline.currentTaskPlan")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
            <span style={{ width: `${progress.percent}%` }} />
          </div>
          <ul className="session-activity-task-list">
            {tasks.map((task) => (
              <li key={task.id} className={`is-${task.status}`}>
                <TaskMark status={task.status} />
                <span>{task.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export default function SessionActivityDetails({
  sessionTitle,
  showIdentity = true,
  prompt,
  modelName,
  tasks,
  session,
  model,
  usageEvents,
  gauge,
  contextNotice,
}: SessionActivityDetailsProps) {
  const prefs = useUiSettings();
  const [tab, setTab] = useState<DetailTab>("stats");
  const [now, setNow] = useState(() => Date.now());
  const tabsId = useId().replace(/:/g, "");
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const durationMs = sessionDurationMs(session, model, now);
  const duration = durationMs === null ? "—" : fmtDuration(durationMs);

  useEffect(() => {
    if (model.turn?.status !== "working" || model.messages.length === 0) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [model.turn?.status, model.turn?.startedAt, model.messages.length]);

  const showTabs = prefs.sessionActivityDetails === "tabs";
  const renderUsage = () => (
    <UsagePanel
      gauge={gauge}
      contextNotice={contextNotice}
      model={model}
      usageEvents={usageEvents}
      modelName={modelName}
      duration={duration}
    />
  );
  const renderContent = () => <ContentPanel prompt={prompt} tasks={tasks} />;

  return (
    <div
      className={`session-activity-details${showTabs ? " has-tabs" : " is-combined"}`}
    >
      {showIdentity && (
        <header className="session-activity-hero">
          <SessionActivityTitle title={sessionTitle} />
        </header>
      )}
      {showTabs ? (
        <>
          <Tabs
            idBase={tabsId}
            label={tr("timeline.activityDetail")}
            value={tab}
            tabs={[
              { id: "stats", label: tr("sessionActivity.usageTab") },
              { id: "content", label: tr("sessionActivity.contentTab") },
            ]}
            onChange={(value) => {
              if (value === "stats" || value === "content") setTab(value);
            }}
            className="session-activity-tabs"
            size="md"
          />
          <div
            className="session-activity-swipe-content"
            onPointerDown={(event) => {
              if (event.pointerType !== "touch" || (event.target as Element).closest("button, a, input, select, textarea")) return;
              touchStart.current = { x: event.clientX, y: event.clientY };
            }}
            onPointerUp={(event) => {
              const start = touchStart.current;
              touchStart.current = null;
              if (event.pointerType !== "touch" || !start) return;
              const dx = event.clientX - start.x;
              const dy = event.clientY - start.y;
              if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy) * 1.25) return;
              setTab(dx < 0 ? "content" : "stats");
            }}
            onPointerCancel={() => { touchStart.current = null; }}
          >
            {tab === "stats" ? (
              <TabPanel idBase={tabsId} tabId="stats" active className="session-activity-tab-panel">
                {renderUsage()}
              </TabPanel>
            ) : (
              <TabPanel idBase={tabsId} tabId="content" active className="session-activity-tab-panel">
                {renderContent()}
              </TabPanel>
            )}
          </div>
        </>
      ) : (
        <div className="session-activity-combined">
          {renderUsage()}
          {renderContent()}
        </div>
      )}
    </div>
  );
}
