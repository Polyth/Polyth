import "./styles.css";
import { Fragment, useCallback, useEffect, useState, useId, useSyncExternalStore, type ReactNode } from "react";
import type {
  HarnessRosterItem,
  HarnessSelection,
  HarnessSnapshot,
  HarnessTransition,
  SessionEvent,
  SessionProjection,
} from "@polyth/contracts";
import { createApiTransport, defineWebPackage, type WebPackageHost } from "@polyth/web-sdk";
import { formatDate } from "@polyth/web/i18n";
import { Button, ChevronRightIcon, ComposerNoticeRow, ErrorIcon, Icon, NewChatIcon, Notice, RefreshIcon, Spinner, Tabs, Tooltip } from "../../../apps/web/src/components/ui/index.ts";
import ProviderLogo from "@polyth/models/provider-logo";
import { resetRuntimeCatalogMemory } from "@polyth/models/runtime-catalog";

import { compactionContext, compactionHandoffDraft, type CompactionMessage } from "./compactionHandoff.ts";
import { hostTranslate, type Translate } from "./englishTranslate.ts";
import { compactionRequestState } from "./compactionProgress.ts";
import { canExecute, useHarnesses } from "./harnessData.ts";
import { HarnessSettings } from "./HarnessSettingsPage.tsx";
import { harnessDisplayName, harnessProfileName, harnessTint as tint } from "./presentation.ts";

export { HarnessSettings };

const api = createApiTransport();

/** Fills `{token}` placeholders of a message with elements (a logo beside a
 *  name) while the translator keeps word order: the message is translated
 *  with markers, then split on them. */
const withNodes = (t: Translate, key: string, values: Record<string, string>, nodes: Record<string, ReactNode>): ReactNode => {
  const markers = Object.fromEntries(Object.keys(nodes).map((name) => [name, `\u0001${name}\u0002`]));
  return t(key, { ...values, ...markers }).split(/\u0001(\w+)\u0002/).map((part, index) =>
    index % 2 === 1 ? <Fragment key={index}>{nodes[part]}</Fragment> : part);
};

export function HarnessTabs({
  host,
  projectId,
  sessionId,
  harnessSelection,
  resolvedHarnessId,
  transition,
  pendingHarnessSelection,
  onSelectHarness,
  projectHarnessDefault,
  spaceId,
}: {
  host: WebPackageHost;
  projectId?: string;
  sessionId?: string;
  harnessSelection?: HarnessSelection;
  resolvedHarnessId?: string;
  transition?: HarnessTransition;
  pendingHarnessSelection?: HarnessSelection;
  onSelectHarness?: (selection: HarnessSelection) => void;
  projectHarnessDefault?: HarnessSelection | null;
  spaceId?: string;
}) {
  const { rows, roster, error, unreachable, loading, retry } = useHarnesses(projectId, spaceId);
  const t = hostTranslate(host.ui.locale.translate);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [draftSelection, setDraftSelection] = useState<HarnessSelection>(() =>
    projectId ? host.executionDraft.get(projectId).harnessSelection : { mode: "auto" });
  const [draftExplicit, setDraftExplicit] = useState(() =>
    projectId ? host.executionDraft.get(projectId).harnessSelectionExplicit === true : false);
  useEffect(() => {
    const sync = () => {
      const config = projectId ? host.executionDraft.get(projectId) : undefined;
      setDraftSelection(config?.harnessSelection ?? { mode: "auto" });
      setDraftExplicit(config?.harnessSelectionExplicit === true);
    };
    sync();
    return host.executionDraft.subscribe(sync);
  }, [host, projectId]);
  // A caller that owns harness state and passes `onSelectHarness` is fully
  // controlled, with or without a canonical session. Otherwise a fresh
  // conversation reads/writes the composer's project draft.
  const controlled = onSelectHarness !== undefined || sessionId !== undefined;
  const selection = controlled
    ? harnessSelection ?? { mode: "auto" }
    : !draftExplicit && projectHarnessDefault
      ? projectHarnessDefault
      : draftSelection;
  const target = transition
    ? rows.find((row) => row.identity.id === transition.targetHarnessId)
      ?? roster.find((row) => row.identity.id === transition.targetHarnessId)
    : undefined;
  const reportFailure = (message: string) => {
    if (host.errors.show) host.errors.show(message);
    else setFailure(message);
  };
  useEffect(() => {
    if (error) host.errors.show?.(error);
  }, [error, host.errors]);

  const perform = async (next: HarnessSelection, timing: "after-turn" | "stop-now") => {
    if (!sessionId) return;
    setBusy(true);
    setFailure("");
    try {
      const result = await api.post<SessionProjection>(`/api/harnesses/sessions/${encodeURIComponent(sessionId)}`, {
        selection: next,
        timing,
      });
      host.sessions.upsert(result);
      // Keep the composer's staged model/profile scoped to the route the
      // server accepted. A retarget must not leave a model from the old
      // transition selected while the new target starts.
      onSelectHarness?.(result.harnessTransition?.selection ?? result.harness
        ?? (result.resolvedHarnessId ? { mode: "pinned", harnessId: result.resolvedHarnessId } : { mode: "auto" }));
      const destinationId = result.harnessTransition?.targetHarnessId ?? result.resolvedHarnessId;
      const destination = rows.find((row) => row.identity.id === destinationId)?.identity.name
        ?? destinationId ?? t("runtime.selectedHarness");
      setAnnouncement(t(result.harnessTransition ? "runtime.switchScheduled" : "runtime.nowUsing", { destination }));
    } catch (cause) {
      reportFailure(host.errors.friendly(t("runtime.changeAction"), cause));
    } finally {
      setBusy(false);
    }
  };

  const choose = (next: HarnessSelection) => {
    if (!projectId && !onSelectHarness) return;
    const nextHarnessId = next.mode === "pinned" ? next.harnessId : undefined;
    const nextName = nextHarnessId
      ? (roster.find((row) => row.identity.id === nextHarnessId)
          ?? rows.find((row) => row.identity.id === nextHarnessId))?.identity.name ?? nextHarnessId
      : undefined;
    if (sessionId) {
      if (transition) {
        setAnnouncement(nextName ? t("runtime.pendingTarget", { name: nextName }) : t("runtime.pendingTargetAuto"));
        void perform(next, transition.timing);
        return;
      }
      onSelectHarness?.(next);
      setAnnouncement(nextName ? t("runtime.selectedNextMessage", { name: nextName }) : t("runtime.autoNextMessage"));
      return;
    }
    // Controlled without a session (for example a planned task): the owner
    // persists the choice and the shared composer draft stays untouched.
    if (onSelectHarness) {
      onSelectHarness(next);
      setAnnouncement(nextName ? t("runtime.selectedNextRun", { name: nextName }) : t("runtime.autoNextRun"));
      return;
    }
    if (!projectId) return;
    const previous = host.executionDraft.get(projectId);
    const config = host.executionDraft.update(projectId, {
      harnessSelection: next,
      harnessSelectionExplicit: true,
      ...(previous.model && (!nextHarnessId || previous.model.harnessId !== nextHarnessId) ? { model: undefined } : {}),
      ...(previous.agent && (!nextHarnessId || previous.agent.harnessId !== nextHarnessId) ? { agent: undefined } : {}),
    });
    setDraftSelection(config.harnessSelection);
    setDraftExplicit(true);
    setAnnouncement(nextName ? t("runtime.selectedNewConversation", { name: nextName }) : t("runtime.autoNewConversation"));
  };

  const cancel = async () => {
    if (!sessionId) return;
    setBusy(true);
    setFailure("");
    try {
      const result = await api.post<SessionProjection>(`/api/harnesses/sessions/${encodeURIComponent(sessionId)}/cancel`, {});
      host.sessions.upsert(result);
      onSelectHarness?.(result.harness
        ?? (result.resolvedHarnessId ? { mode: "pinned", harnessId: result.resolvedHarnessId } : { mode: "auto" }));
      setAnnouncement(t("runtime.switchCancelled"));
    } catch (cause) {
      reportFailure(host.errors.friendly(t("runtime.cancelAction"), cause));
    } finally {
      setBusy(false);
    }
  };

  const activeSelection = transition?.selection ?? pendingHarnessSelection ?? selection;
  const snapshots = new Map(rows.map((row) => [row.identity.id, row]));
  type PickerRow = HarnessRosterItem & { snapshot?: HarnessSnapshot };
  const pickerRows: PickerRow[] = [
    ...roster.map((row) => {
      const snapshot = snapshots.get(row.identity.id);
      return { ...row, ...(snapshot ? { snapshot } : {}) };
    }),
    ...rows.filter((row) => !roster.some((item) => item.identity.id === row.identity.id))
      .map((row) => ({ identity: row.identity, policy: row.policy, snapshot: row })),
  ];
  const ordered = pickerRows.toSorted((a, b) => a.policy.priority - b.policy.priority || a.identity.name.localeCompare(b.identity.name));
  // A harness is offered by the model picker only when the user enabled it and
  // it can actually run here (installed, healthy and authorized). Roster
  // metadata is process-free and arrives before per-harness probes, so a row
  // without a snapshot yet stays visible while that probe settles; once a
  // snapshot exists, an unusable harness (disabled, not installed,
  // unauthenticated or setup-incomplete) is not rendered at all. There is no
  // exception for the currently resolved, pinned or pending target: a harness
  // that cannot be used must not appear in the picker.
  const visibleRows = ordered.filter((row) => row.policy.enabled && (row.snapshot === undefined || canExecute(row.snapshot)));
  const resolvedTab = resolvedHarnessId && visibleRows.some((row) => row.identity.id === resolvedHarnessId)
    ? resolvedHarnessId
    : undefined;
  const requestedTab = activeSelection.mode === "pinned" ? activeSelection.harnessId : resolvedTab;
  const activeTab = requestedTab && visibleRows.some((row) => row.identity.id === requestedTab)
    ? requestedTab
    : "";
  const tabs = visibleRows.map((row) => ({
    id: row.identity.id,
    label: <Tooltip content={harnessProfileName(row.identity)}>
      <span className="pkg-harnesses-tab-mark" data-tinted={row.identity.color || row.identity.accountLabel ? "true" : undefined} style={tint(row.identity)}>
        <ProviderLogo providerID={row.identity.id} providerName={row.identity.defaultName ?? row.identity.name} size="compact" />
        <span className="sr-only">{harnessProfileName(row.identity)}</span>
      </span>
    </Tooltip>,
    disabled: activeTab !== row.identity.id && busy,
  }));
  // A session or pin can still point at a harness that became unusable. Its
  // tab is gone, so keep the recovery path without naming the hidden harness:
  // the next turn can move to any visible tab, and Settings can finish setup.
  const boundId = activeSelection.mode === "pinned" ? activeSelection.harnessId : resolvedHarnessId;
  const boundHidden = Boolean(boundId) && !activeTab && !transition
    && ordered.some((row) => row.identity.id === boundId);
  const chooseTab = (id: string) => {
    const next: HarnessSelection = { mode: "pinned", harnessId: id };
    if (id === activeTab) return;
    choose(next);
  };

  return <section className="pkg-harnesses pkg-harnesses-picker-tabs" aria-label={t("runtime.ariaPicker")} aria-busy={busy || loading}>
    <div className="pkg-harnesses-picker-tabs-head">
      <Tabs tabs={tabs} value={activeTab} onChange={chooseTab} label={t("runtime.ariaPicker")} size="sm" className="pkg-harnesses-tablist" />
    </div>
    <>
        {transition?.phase === "requested" && <div className="pkg-harnesses-transition" role="status">
          <span>{withNodes(t, "runtime.waiting", {}, { target: <><ProviderLogo providerID={target?.identity.id ?? transition.targetHarnessId} providerName={target?.identity.defaultName ?? target?.identity.name} size="compact" />{target?.identity.name ?? transition.targetHarnessId}</> })}</span>
          <Button size="sm" busy={busy} onClick={() => void perform(transition.selection, "stop-now")}>{t("runtime.switchNow")}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>{t("runtime.cancel")}</Button>
        </div>}
        {transition?.phase === "released" && <div className="pkg-harnesses-transition" role="status"><ProviderLogo providerID={target?.identity.id ?? transition.targetHarnessId} providerName={target?.identity.defaultName ?? target?.identity.name} size="compact" />{t("runtime.starting", { target: target?.identity.name ?? transition.targetHarnessId })}</div>}
        {transition?.phase === "failed" && !host.errors.show && <Notice tone="error" role="alert" heading={t("runtime.couldntStart", { name: target?.identity.name ?? transition.targetHarnessId })} actions={<Button size="sm" busy={busy} onClick={() => void perform(transition.selection, "after-turn")}>{t("runtime.retry")}</Button>}>
          {t("runtime.previousStopped", { message: transition.error?.message ?? t("runtime.chooseAnotherTab") })}
        </Notice>}
        {transition?.phase === "failed" && host.errors.show && (
          <div className="pkg-harnesses-transition">
            <Button size="sm" busy={busy} onClick={() => void perform(transition.selection, "after-turn")}>{t("runtime.retryNamed", { name: target?.identity.name ?? transition.targetHarnessId })}</Button>
          </div>
        )}
        {boundHidden && <p className="pkg-harnesses-picker-state" role="status">{t("runtime.boundHidden")}</p>}
        {unreachable && tabs.length === 0 && <p className="pkg-harnesses-picker-state pkg-harnesses-picker-retry" role="status">
          <span>{host.ui.locale.translate("harnessruntime.picker.unreachable")}</span>
          <Button size="sm" variant="ghost" onClick={retry}>{host.ui.locale.translate("common.retry")}</Button>
        </p>}
      </>
    {(failure || error) && !host.errors.show && <Notice tone="error" role="alert">{failure || error}</Notice>}
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
  </section>;
}

export function HarnessTransitionStatus({
  host,
  sessionId,
  resolvedHarnessId,
  transition,
}: {
  host: WebPackageHost;
  sessionId?: string;
  resolvedHarnessId?: string;
  transition?: HarnessTransition;
}) {
  const t = hostTranslate(host.ui.locale.translate);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const update = useCallback(async (timing: "after-turn" | "stop-now") => {
    if (!transition || !sessionId) return;
    setBusy(true);
    setFailure("");
    try {
      host.sessions.upsert(await api.post<SessionProjection>(`/api/harnesses/sessions/${encodeURIComponent(sessionId)}`, {
        selection: transition.selection,
        timing,
      }));
    } catch (cause) {
      const message = host.errors.friendly(t("runtime.changeAction"), cause);
      if (host.errors.show) host.errors.show(message);
      else setFailure(message);
    } finally {
      setBusy(false);
    }
  }, [host, sessionId, transition]);
  const cancel = useCallback(async () => {
    if (!sessionId) return;
    setBusy(true);
    setFailure("");
    try {
      host.sessions.upsert(await api.post<SessionProjection>(`/api/harnesses/sessions/${encodeURIComponent(sessionId)}/cancel`, {}));
    } catch (cause) {
      const message = host.errors.friendly(t("runtime.cancelAction"), cause);
      if (host.errors.show) host.errors.show(message);
      else setFailure(message);
    } finally {
      setBusy(false);
    }
  }, [host, sessionId]);
  const transitionFailure = transition?.phase === "failed"
    ? host.errors.friendly(t("runtime.couldntStart", { name: transition.targetHarnessId }), transition.error?.message ?? t("runtime.chooseAnotherHarness"))
    : "";
  useEffect(() => {
    if (!transitionFailure || !host.errors.show) return;
    host.errors.show(transitionFailure, {
      label: t("runtime.retry"),
      run: () => update("after-turn"),
    });
  }, [host.errors, transitionFailure, update]);

  const mode = transitionStatusMode(transition, resolvedHarnessId);

  if (!transition || !sessionId || (transition.phase === "failed" && host.errors.show)) return <ComposerNoticeRow open={false} />;
  if (mode === "hidden") {
    return failure
      ? <ComposerNoticeRow open><div className="pkg-harnesses pkg-harnesses-transition-status"><Notice tone="error" role="alert">{failure}</Notice></div></ComposerNoticeRow>
      : <ComposerNoticeRow open={false} />;
  }

  const target = harnessDisplayName(transition.targetHarnessId) || transition.targetHarnessId;
  return <ComposerNoticeRow open><div className="pkg-harnesses pkg-harnesses-transition-status">
    {transition.phase === "requested" && <div className="pkg-harnesses-transition" role="status">
      <span>{withNodes(t, "runtime.afterResponse", {}, {
        from: <><ProviderLogo providerID={resolvedHarnessId} size="compact" />{harnessDisplayName(resolvedHarnessId ?? "") || resolvedHarnessId || t("runtime.current")}</>,
        to: <><ProviderLogo providerID={transition.targetHarnessId} size="compact" />{target}</>,
      })}</span>
      <Button size="sm" busy={busy} onClick={() => void update("stop-now")}>{t("runtime.switchNow")}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>{t("runtime.cancel")}</Button>
    </div>}
    {transition.phase === "failed" && <Notice tone="error" role="alert" heading={t("runtime.couldntStart", { name: transition.targetHarnessId })} actions={<Button size="sm" busy={busy} onClick={() => void update("after-turn")}>{t("runtime.retry")}</Button>}>
      {transition.error?.message ?? t("runtime.openPicker")}
    </Notice>}
    {failure && <Notice tone="error" role="alert">{failure}</Notice>}
  </div></ComposerNoticeRow>;
}

/** Only a deferred, cross-harness request needs a persistent composer row.
 * Submit-time switches and released legs are already represented by the live
 * activity dock and the single timeline marker that follows the handoff. */
export function transitionStatusMode(
  transition: HarnessTransition | undefined,
  resolvedHarnessId: string | undefined,
): "actionable" | "hidden" {
  if (!transition) return "hidden";
  if (transition.phase === "failed") return "actionable";
  return transition.phase === "requested"
    && transition.timing === "after-turn"
    && transition.targetHarnessId !== resolvedHarnessId
    ? "actionable"
    : "hidden";
}

export function isVisibleHarnessSwitch(from: string, to: string): boolean {
  return from.length > 0 && to.length > 0 && from !== to;
}

function SwitchMarker({ event, host }: { event: SessionEvent; host: WebPackageHost }) {
  const t = hostTranslate(host.ui.locale.translate);
  if (event.type !== "harness/switched") return null;
  const from = String(event.data.from || "");
  const to = String(event.data.to || "");
  // A fresh leg on the same harness is runtime bookkeeping, not a switch the
  // reader made: the conversation simply continues.
  if (!isVisibleHarnessSwitch(from, to)) return null;
  const fromLabel = harnessDisplayName(from) || t("runtime.previousHarness");
  const toLabel = harnessDisplayName(to) || t("runtime.newHarness");
  const closed = event.data.closedLeg as Record<string, unknown> | undefined;
  const leg = event.data.leg as Record<string, unknown> | undefined;
  return <details className="pkg-harnesses-switch-marker">
    <summary aria-label={t("runtime.switchedAria", { from: fromLabel, to: toLabel })}>
      <span className="pkg-harnesses-switch-marker-label">
        <span className="pkg-harnesses-switch-marker-leg"><ProviderLogo providerID={from} providerName={fromLabel} size="compact" /><span className="pkg-harnesses-switch-marker-name">{fromLabel}</span></span>
        <span className="pkg-harnesses-switch-marker-arrow" aria-hidden="true">→</span>
        <span className="pkg-harnesses-switch-marker-leg"><ProviderLogo providerID={to} providerName={toLabel} size="compact" /><span className="pkg-harnesses-switch-marker-name">{toLabel}</span></span>
      </span>
    </summary>
    <dl><dt>{t("runtime.started")}</dt><dd><time dateTime={new Date(event.time).toISOString()}>{formatDate(new Date(event.time), { timeStyle: "medium" })}</time></dd><dt>{t("runtime.continuity")}</dt><dd>{t("runtime.canonicalHistory")}</dd>{Boolean(closed?.nativeSessionId) && <><dt>{t("runtime.previousNative")}</dt><dd>{String(closed!.nativeSessionId)}</dd></>}{Boolean(leg?.nativeSessionId) && <><dt>{t("runtime.newNative")}</dt><dd>{String(leg!.nativeSessionId)}</dd></>}{Boolean(leg?.bootstrap) && <><dt>{t("runtime.bootstrap")}</dt><dd>{String(leg!.bootstrap)}</dd></>}</dl>
  </details>;
}

/** A native harness compaction is not dialogue and must not disappear with the
 * context gauge update. Keep it as a durable, readable timeline message so a
 * reader can see exactly where the harness condensed earlier context. It
 * expands to what carried over — the harness's own summary when it shared
 * one, never shown as assistant prose — and can seed a fresh chat with it.
 * The expanded body mounts only while open. */
export function CompactionMarker({ event, host, sessionId, projectId }: { event: SessionEvent; host: WebPackageHost; sessionId?: string; projectId?: string }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  if (event.type !== "session/compacted") return null;
  const time = new Date(event.time);
  const translate = host.ui.locale.translate;
  const source = sessionId ?? event.sessionId;
  const targetProject = open ? projectId ?? host.sessions.get(source)?.projectId : undefined;
  const context = open ? compactionContext(host.sessions.events(source), event) : undefined;
  const roleLabel = (message: CompactionMessage) =>
    translate(message.role === "user" ? "harnessruntime.compaction.roleUser" : "harnessruntime.compaction.roleAssistant");
  const startNewChat = () => {
    if (!targetProject) return;
    const full = compactionContext(host.sessions.events(source), event);
    const title = host.sessions.get(source)?.title?.trim() ?? "";
    host.conversation.startNewSession(targetProject, {
      ...(title ? { title: translate("harnessruntime.compaction.newChatTitle", { title }) } : {}),
      draft: compactionHandoffDraft(full, {
        intro: title
          ? translate("harnessruntime.compaction.draftIntro", { title, sessionId: source })
          : translate("harnessruntime.compaction.draftIntroUntitled", { sessionId: source }),
        summary: translate("harnessruntime.compaction.summaryHeading"),
        pinned: translate("harnessruntime.compaction.pinnedHeading"),
        recent: translate("harnessruntime.compaction.recentHeading"),
        user: translate("harnessruntime.compaction.draftUser"),
        assistant: translate("harnessruntime.compaction.draftAssistant"),
      }),
    });
  };
  return (
    <article className="pkg-harnesses-compaction-marker" data-event-seq={event.seq} data-open={open ? "true" : undefined} aria-label={translate("harnessruntime.compaction.ariaLabel")}>
      <button type="button" className="pkg-harnesses-compaction-toggle" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => setOpen((value) => !value)}>
        <span className="pkg-harnesses-compaction-icon" aria-hidden="true"><Icon icon={RefreshIcon} size="sm" /></span>
        <span className="pkg-harnesses-compaction-copy">
          <span className="pkg-harnesses-compaction-heading">
            <strong>{translate("harnessruntime.compaction.heading")}</strong>
            <time dateTime={time.toISOString()}>{formatDate(time, { timeStyle: "short" })}</time>
          </span>
          <span className="pkg-harnesses-compaction-description">{translate("harnessruntime.compaction.description")}</span>
        </span>
        <span className="pkg-harnesses-compaction-chevron" aria-hidden="true"><Icon icon={ChevronRightIcon} size="sm" /></span>
      </button>
      {context && <div id={bodyId} className="pkg-harnesses-compaction-body">
        {context.summary
          ? <section className="pkg-harnesses-compaction-section">
              <h4>{translate("harnessruntime.compaction.summaryHeading")}</h4>
              <div className="pkg-harnesses-compaction-summary"><host.ui.components.MarkdownDoc text={context.summary} keyBase={`compaction-${event.seq}`} /></div>
            </section>
          : <p className="pkg-harnesses-compaction-note">{translate("harnessruntime.compaction.noSummary")}</p>}
        {context.recent.length > 0 && <section className="pkg-harnesses-compaction-section">
          <h4>{translate("harnessruntime.compaction.recentHeading")}</h4>
          <ol className="pkg-harnesses-compaction-recent">
            {context.recent.map((message, index) => <li key={index} data-role={message.role}>
              <span className="pkg-harnesses-compaction-role">{roleLabel(message)}</span>
              <span className="pkg-harnesses-compaction-excerpt">{message.text}</span>
            </li>)}
          </ol>
        </section>}
        {targetProject && <div className="pkg-harnesses-compaction-actions">
          <Button size="sm" iconStart={NewChatIcon} onClick={startNewChat}>{translate("harnessruntime.compaction.startNewChat")}</Button>
        </div>}
      </div>}
    </article>
  );
}

/** A requested compaction until its marker lands: "Compacting…" while the
 *  summary is written, or why it failed. A settled request renders nothing;
 *  the `session/compacted` marker is the lasting record. */
export function CompactionProgress({ event, host, sessionId }: { event: SessionEvent; host: WebPackageHost; sessionId?: string }) {
  const source = sessionId ?? event.sessionId;
  // A string snapshot: re-render only when the request's state changes.
  const snapshot = useSyncExternalStore(host.sessions.subscribe, () =>
    JSON.stringify(compactionRequestState(host.sessions.events(source), event, Date.now())));
  if (event.type !== "session/compaction-requested") return null;
  const state = JSON.parse(snapshot) as ReturnType<typeof compactionRequestState>;
  if (state.kind === "settled") return null;
  const translate = host.ui.locale.translate;
  const failed = state.kind === "failed";
  return (
    <article className="pkg-harnesses-compaction-marker pkg-harnesses-compaction-progress" data-event-seq={event.seq} data-state={state.kind} role="status" aria-live="polite">
      <div className="pkg-harnesses-compaction-toggle">
        <span className="pkg-harnesses-compaction-icon" aria-hidden="true">
          {failed ? <Icon icon={ErrorIcon} size="sm" /> : <Spinner size="sm" />}
        </span>
        <span className="pkg-harnesses-compaction-copy">
          <span className="pkg-harnesses-compaction-heading">
            <strong>{translate(failed ? "harnessruntime.compaction.failedHeading" : "harnessruntime.compaction.pendingHeading")}</strong>
          </span>
          {failed && state.error && <span className="pkg-harnesses-compaction-description">{state.error}</span>}
          <span className="pkg-harnesses-compaction-description">
            {translate(failed ? "harnessruntime.compaction.failedDescription" : "harnessruntime.compaction.pendingDescription")}
          </span>
        </span>
      </div>
    </article>
  );
}

export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({ id: "harnesses", packageId: "harness-runtime", label: "Harnesses", group: "Engineering", order: 15, icon: "cpu", component: ({ settingsTarget }) => <HarnessSettings host={host} settingsTarget={settingsTarget}/> }),
    host.slots.register({ id: "harnesses.model-tabs", slot: "modelPicker.header", order: 10, render: (props) => <HarnessTabs host={host} spaceId={props.spaceId as string | undefined} projectId={props.projectId as string | undefined} sessionId={props.sessionId as string | undefined} harnessSelection={props.harnessSelection as HarnessSelection | undefined} resolvedHarnessId={props.resolvedHarnessId as string | undefined} transition={props.harnessTransition as HarnessTransition | undefined} pendingHarnessSelection={props.pendingHarnessSelection as HarnessSelection | undefined} onSelectHarness={props.onSelectHarness as ((selection: HarnessSelection) => void) | undefined} projectHarnessDefault={props.projectHarnessDefault as HarnessSelection | null | undefined} /> }),
    host.slots.register({ id: "harnesses.transition", slot: "session.composer.before", order: 10, render: (props) => <HarnessTransitionStatus host={host} sessionId={props.sessionId as string | undefined} resolvedHarnessId={props.resolvedHarnessId as string | undefined} transition={props.harnessTransition as HarnessTransition | undefined} /> }),
    host.slots.register({ id: "harnesses.compaction-marker", slot: "session.timeline.event", order: 5, meta: { eventTypes: ["session/compacted"] }, render: (props) => <CompactionMarker host={host} event={props.event as SessionEvent} sessionId={props.sessionId as string | undefined} projectId={props.projectId as string | undefined} /> }),
    host.slots.register({ id: "harnesses.compaction-progress", slot: "session.timeline.event", order: 5, meta: { eventTypes: ["session/compaction-requested"] }, render: (props) => <CompactionProgress host={host} event={props.event as SessionEvent} sessionId={props.sessionId as string | undefined} /> }),
    host.slots.register({ id: "harnesses.switch-marker", slot: "session.timeline.event", meta: { eventTypes: ["harness/switched"] }, render: (props) => <SwitchMarker host={host} event={props.event as SessionEvent} /> }),
  ];
  return () => {
    off.toReversed().forEach((dispose) => dispose());
    resetRuntimeCatalogMemory();
  };
});
