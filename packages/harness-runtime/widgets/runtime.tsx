import "./styles.css";
import { useCallback, useEffect, useRef, useState, useId, type DragEvent } from "react";
import type {
  HarnessControlDescriptor,
  HarnessRosterItem,
  HarnessSelection,
  HarnessSnapshot,
  HarnessTransition,
  SessionEvent,
  SessionProjection,
} from "@polyth/contracts";
import { createApiTransport, defineWebPackage, type WebPackageHost, type SettingsNavigationTarget } from "@polyth/web-sdk";
import { Button, Dialog, Notice, Select, Switch, Tabs, TabPanel, TextInput, Tooltip } from "../../../apps/web/src/components/ui/index.ts";
import MoveControls from "../../../apps/web/src/components/MoveControls.tsx";
import ProviderLogo from "../../models/widgets/ProviderLogo.tsx";
import { peekHarnessRoster, peekHarnessSnapshots, readHarnessRoster, readHarnessSnapshots, resetRuntimeCatalogMemory, useCatalogRevision } from "@polyth/models/runtime-catalog";
import { activeBrowserAccountId } from "@polyth/web/account-storage";

import { attachmentFacts, availabilityLabel, configurationSections, harnessDisplayName, integrationLabel, orderedHarnesses, pendingLabel, projectionFacts, resolvedAuto, routingLabel, runtimeFacts, summaryFacts, type CapabilityFact } from "./presentation.ts";

const api = createApiTransport();

const canExecute = (row: HarnessSnapshot): boolean => row.policy.enabled
  && row.availability.installed
  && row.availability.healthy
  && row.availability.authenticated !== false
  && !["setup-required", "partially-configured", "incompatible", "offline", "not-installed"]
    .includes(row.availability.state);

function useHarnesses(projectId?: string | null, spaceId?: string, harnessId?: string) {
  const revision = useCatalogRevision();
  const key = JSON.stringify([activeBrowserAccountId(), spaceId ?? "page", projectId ?? "", revision]);
  const [result, setResult] = useState<{ key: string; rows: HarnessSnapshot[] }>();
  const [rosterResult, setRosterResult] = useState<{ key: string; rows: HarnessRosterItem[] }>();
  const requestSeq = useRef(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async (force = false) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      let rows = await readHarnessSnapshots({ projectId, spaceId, force });
      if (harnessId) {
        const selected = await readHarnessSnapshots({ projectId, spaceId, harnessId, detail: true });
        rows = rows.map((row) => selected.find((item) => item.identity.id === row.identity.id) ?? row);
      }
      if (seq !== requestSeq.current) return;
      setResult({ key, rows });
      setError("");
    } catch (cause) {
      if (seq !== requestSeq.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [key, projectId, spaceId, harnessId]);
  useEffect(() => {
    let active = true;
    void readHarnessRoster({ projectId, spaceId }).then((rows) => {
      if (active) setRosterResult({ key, rows });
    }).catch(() => {});
    void refresh();
    return () => { active = false; requestSeq.current++; };
  }, [refresh, key, projectId, spaceId]);
  const rows = result?.key === key ? result.rows : peekHarnessSnapshots({ projectId, spaceId }) ?? [];
  const roster = rosterResult?.key === key ? rosterResult.rows : peekHarnessRoster({ projectId, spaceId }) ?? [];
  return { rows, roster, error, loading, refresh };
}

function GenericControl({
  control,
  harnessId,
  projectId,
  refresh,
}: {
  control: HarnessControlDescriptor;
  harnessId: string;
  projectId?: string;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [textValue, setTextValue] = useState(typeof control.value === "string" ? control.value : "");
  useEffect(() => setTextValue(typeof control.value === "string" ? control.value : ""), [control.id, control.value]);
  const apply = async (value: unknown) => {
    setBusy(true);
    setError("");
    try {
      const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      await api.post(`/api/harnesses/${encodeURIComponent(harnessId)}/controls/${encodeURIComponent(control.id)}${query}`, { value });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || control.available === false || control.applySemantics === "read-only";
  return <div className="pkg-harnesses-control">
    <div><strong>{control.label}</strong>{control.description && <span>{control.description}</span>}{control.unavailableReason && <small>{control.unavailableReason}</small>}</div>
    <small>{control.applySemantics.replaceAll("-", " ")}</small>
    <div className="pkg-harnesses-control-value">
      {control.applySemantics === "read-only" ? <code>{String(control.value ?? "—")}</code>
        : control.kind === "toggle" ? <Switch label={control.label} checked={control.value === true} disabled={disabled} onChange={(value) => void apply(value)} />
          : control.kind === "select" ? <Select label={control.label} value={String(control.value ?? "")} options={(control.choices ?? []).map((choice) => ({ value: choice.value, label: choice.label }))} disabled={disabled} onChange={(value) => void apply(value)} />
            : control.kind === "text" ? <TextInput uiSize="sm" aria-label={control.label} value={textValue} disabled={disabled} onChange={(event) => setTextValue(event.target.value)} onBlur={() => { if (textValue !== control.value) void apply(textValue); }} />
              : <Button size="sm" busy={busy} disabled={disabled} onClick={() => void apply(true)}>{control.label}</Button>}
    </div>
    {error && <Notice tone="error" role="alert">{error}</Notice>}
  </div>;
}

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
  const { rows, roster, error, loading } = useHarnesses(projectId, spaceId);
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
  const selection = sessionId
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
      const destinationId = result.harnessTransition?.targetHarnessId ?? result.resolvedHarnessId;
      const destination = rows.find((row) => row.identity.id === destinationId)?.identity.name
        ?? destinationId ?? "the selected harness";
      setAnnouncement(result.harnessTransition
        ? `Harness switch scheduled. The current response will finish, then ${destination} will continue.`
        : `Now using ${destination}.`);
    } catch (cause) {
      reportFailure(host.errors.friendly("Change harness", cause));
    } finally {
      setBusy(false);
    }
  };

  const choose = (next: HarnessSelection) => {
    if (!projectId || transition) return;
    const nextHarnessId = next.mode === "pinned" ? next.harnessId : undefined;
    const nextName = nextHarnessId
      ? (roster.find((row) => row.identity.id === nextHarnessId)
          ?? rows.find((row) => row.identity.id === nextHarnessId))?.identity.name ?? nextHarnessId
      : undefined;
    if (sessionId) {
      onSelectHarness?.(next);
      setAnnouncement(nextName
        ? `${nextName} selected for the next message. It will connect when you send.`
        : "Automatic harness selection staged for the next message.");
      return;
    }
    const previous = host.executionDraft.get(projectId);
    const config = host.executionDraft.update(projectId, {
      harnessSelection: next,
      harnessSelectionExplicit: true,
      ...(previous.model && (!nextHarnessId || previous.model.harnessId !== nextHarnessId) ? { model: undefined } : {}),
      ...(previous.agent && (!nextHarnessId || previous.agent.harnessId !== nextHarnessId) ? { agent: undefined } : {}),
    });
    setDraftSelection(config.harnessSelection);
    setDraftExplicit(true);
    setAnnouncement(nextName
      ? `${nextName} selected for the new conversation. It will connect when you send.`
      : "Automatic harness selection enabled for the new conversation.");
  };

  const cancel = async () => {
    if (!sessionId) return;
    setBusy(true);
    setFailure("");
    try {
      host.sessions.upsert(await api.post<SessionProjection>(`/api/harnesses/sessions/${encodeURIComponent(sessionId)}/cancel`, {}));
      setAnnouncement("Harness switch cancelled. The current harness will continue.");
    } catch (cause) {
      reportFailure(host.errors.friendly("Cancel harness switch", cause));
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
  const preserveTabIds = new Set<string>();
  if (resolvedHarnessId) preserveTabIds.add(resolvedHarnessId);
  if (activeSelection.mode === "pinned") preserveTabIds.add(activeSelection.harnessId);
  if (transition?.targetHarnessId) preserveTabIds.add(transition.targetHarnessId);
  if (pendingHarnessSelection?.mode === "pinned") preserveTabIds.add(pendingHarnessSelection.harnessId);
  const isWorking = (row: PickerRow) => row.policy.enabled && Boolean(row.snapshot && canExecute(row.snapshot));
  const visibleRows = ordered.filter((row) => preserveTabIds.has(row.identity.id) || isWorking(row));
  const firstExecutable = ordered.find(isWorking);
  const resolvedTab = resolvedHarnessId && visibleRows.some((row) => row.identity.id === resolvedHarnessId)
    ? resolvedHarnessId
    : firstExecutable?.identity.id;
  const requestedTab = activeSelection.mode === "pinned" ? activeSelection.harnessId : resolvedTab;
  const activeTab = requestedTab && visibleRows.some((row) => row.identity.id === requestedTab)
    ? requestedTab
    : resolvedTab ?? "";
  const tabs = visibleRows.map((row) => ({
    id: row.identity.id,
    label: <span title={row.identity.name}>
      <ProviderLogo providerID={row.identity.id} providerName={row.identity.name} size="compact" />
      <span className="sr-only">{row.identity.name}</span>
    </span>,
    disabled: activeTab !== row.identity.id && (busy || Boolean(transition) || !row.policy.enabled || (row.snapshot ? !canExecute(row.snapshot) : false)),
  }));
  const activeRow = visibleRows.find((row) => row.identity.id === activeTab);
  const chooseTab = (id: string) => {
    const next: HarnessSelection = { mode: "pinned", harnessId: id };
    if (!transition && id === activeTab) return;
    choose(next);
  };

  return <section className="pkg-harnesses pkg-harnesses-picker-tabs" aria-label="Execution harness" aria-busy={busy || loading}>
    <div className="pkg-harnesses-picker-tabs-head">
      <Tabs tabs={tabs} value={activeTab} onChange={chooseTab} label="Execution harness" size="sm" className="pkg-harnesses-tablist" />
    </div>
    <>
        {transition?.phase === "requested" && <div className="pkg-harnesses-transition" role="status">
          <span>Waiting for current response · Will run with <ProviderLogo providerID={target?.identity.id ?? transition.targetHarnessId} providerName={target?.identity.name} size="compact" />{target?.identity.name ?? transition.targetHarnessId}</span>
          <Button size="sm" busy={busy} onClick={() => void perform(transition.selection, "stop-now")}>Switch now</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>Cancel</Button>
        </div>}
        {transition?.phase === "released" && <div className="pkg-harnesses-transition" role="status"><ProviderLogo providerID={target?.identity.id ?? transition.targetHarnessId} providerName={target?.identity.name} size="compact" />Starting {target?.identity.name ?? transition.targetHarnessId}…</div>}
        {transition?.phase === "failed" && !host.errors.show && <Notice tone="error" role="alert" heading={`${target?.identity.name ?? transition.targetHarnessId} couldn't start`} actions={<Button size="sm" busy={busy} onClick={() => void perform(transition.selection, "after-turn")}>Retry</Button>}>
          The previous harness stopped safely. {transition.error?.message ?? "Choose another harness tab to continue."}
        </Notice>}
        {transition?.phase === "failed" && host.errors.show && (
          <div className="pkg-harnesses-transition">
            <Button size="sm" busy={busy} onClick={() => void perform(transition.selection, "after-turn")}>Retry {target?.identity.name ?? transition.targetHarnessId}</Button>
          </div>
        )}
        {activeRow?.snapshot && !canExecute(activeRow.snapshot) && !transition && <p className="pkg-harnesses-picker-state" role="status">{availabilityLabel(activeRow.snapshot)}. Open Harnesses in Settings to finish setup.</p>}
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
      const message = host.errors.friendly("Change harness", cause);
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
      const message = host.errors.friendly("Cancel harness switch", cause);
      if (host.errors.show) host.errors.show(message);
      else setFailure(message);
    } finally {
      setBusy(false);
    }
  }, [host, sessionId]);
  const transitionFailure = transition?.phase === "failed"
    ? host.errors.friendly(`${transition.targetHarnessId} couldn't start`, transition.error?.message ?? "Choose another harness to continue.")
    : "";
  useEffect(() => {
    if (!transitionFailure || !host.errors.show) return;
    host.errors.show(transitionFailure, {
      label: "Retry",
      run: () => update("after-turn"),
    });
  }, [host.errors, transitionFailure, update]);

  if (!transition || !sessionId || (transition.phase === "failed" && host.errors.show)) return null;

  return <div className="pkg-harnesses pkg-harnesses-transition-status">
    {transition.phase === "requested" && <div className="pkg-harnesses-transition" role="status">
      <span><ProviderLogo providerID={resolvedHarnessId} size="compact" />{resolvedHarnessId ?? "Current"} → <ProviderLogo providerID={transition.targetHarnessId} size="compact" />{transition.targetHarnessId} after this response</span>
      <Button size="sm" busy={busy} onClick={() => void update("stop-now")}>Switch now</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>Cancel</Button>
    </div>}
    {transition.phase === "released" && <div className="pkg-harnesses-transition" role="status"><ProviderLogo providerID={transition.targetHarnessId} size="compact" />Starting {transition.targetHarnessId}…</div>}
    {transition.phase === "failed" && <Notice tone="error" role="alert" heading={`${transition.targetHarnessId} couldn't start`} actions={<Button size="sm" busy={busy} onClick={() => void update("after-turn")}>Retry</Button>}>
      {transition.error?.message ?? "Open the model picker to choose another harness."}
    </Notice>}
    {failure && <Notice tone="error" role="alert">{failure}</Notice>}
  </div>;
}

export function HarnessSettings({ host, settingsTarget }: { host: WebPackageHost; settingsTarget?: SettingsNavigationTarget }) {
  const projectId = host.store.select((state) => state.activeProjectId);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragged, setDragged] = useState<string>();
  const [detailId, setDetailId] = useState(settingsTarget?.itemId);
  const [sectionId, setSectionId] = useState(settingsTarget?.sectionId ?? "overview");
  useEffect(() => { setDetailId(settingsTarget?.itemId); setSectionId(settingsTarget?.sectionId ?? "overview"); }, [settingsTarget]);
  const { rows, error, loading, refresh } = useHarnesses(projectId, undefined, detailId);
  const tabsId = useId();
  const [explanation, setExplanation] = useState<CapabilityFact>();
  const [setup, setSetup] = useState<{ row: HarnessSnapshot; command: string; label: string }>();
  const [terminal, setTerminal] = useState<string>();

  useEffect(() => {
    const focus = () => { void refresh(true); };
    window.addEventListener("focus", focus);
    if (!terminal) return () => window.removeEventListener("focus", focus);
    const interval = setInterval(() => {
      void api.get<Array<{ id: string; running: boolean }>>(`/api/terminals?projectId=${encodeURIComponent(projectId ?? "")}`).then((items) => {
        if (!items.find((item) => item.id === terminal)?.running) { setTerminal(undefined); void refresh(true); }
      }).catch(() => setTerminal(undefined));
    }, 3000);
    return () => { window.removeEventListener("focus", focus); clearInterval(interval); };
  }, [projectId, terminal, refresh]);

  const ordered = orderedHarnesses(rows);
  const saveOrder = async (next: HarnessSnapshot[]) => {
    setBusy(true);
    setFailure("");
    try {
      await api.put("/api/harnesses/preferences", { preferences: Object.fromEntries(next.map((row, index) => [row.identity.id, { enabled: row.policy.enabled, priority: index * 10 }])) });
      await refresh(true);
    } catch (cause) {
      setFailure(host.errors.friendly("Save harness preferences", cause));
    } finally {
      setBusy(false);
    }
  };
  const move = (id: string, index: number) => {
    if (busy) return;
    const from = ordered.findIndex((row) => row.identity.id === id);
    if (from < 0 || index < 0 || index >= ordered.length || from === index) return;
    const next = [...ordered];
    const [item] = next.splice(from, 1);
    next.splice(index, 0, item!);
    void saveOrder(next);
  };
  const toggle = (id: string, enabled: boolean) => void saveOrder(ordered.map((row) => row.identity.id === id ? { ...row, policy: { ...row.policy, enabled } } : row));
  const openDetail = (id: string, section = "overview") => { setDetailId(id); setSectionId(section); };
  const detail = rows.find((row) => row.identity.id === detailId);
  const sectionsFor = (id: string) => configurationSections(host.slots.list("settings.harness.detail"), id);
  const contributed = detail ? sectionsFor(detail.identity.id) : [];
  const pendingSection = contributed.find((section) => section.handlesPendingChanges);
  const activeSection = sectionId === "overview" || contributed.some((section) => section.id === sectionId) ? sectionId : "overview";
  const target = rows.some((row) => row.context.remote) ? "Remote execution target" : "This machine";
  const auto = resolvedAuto(rows);
  const explain = (fact: CapabilityFact, showLabel = true) => <Tooltip key={fact.id} content={fact.description}><button type="button" className="pkg-harnesses-chip" aria-label={`${fact.label}: ${fact.value}. ${fact.description}`} onClick={() => setExplanation(fact)}>{showLabel ? `${fact.label} · ` : ""}{fact.value}</button></Tooltip>;
  const matrix = (title: string, facts: CapabilityFact[]) => <section className="pkg-harnesses-matrix"><h3>{title}</h3>{facts.map((fact) => <div className="pkg-harnesses-fact" key={fact.id} data-unsupported={fact.unsupported || undefined}><span>{fact.label}</span><span>{explain(fact, false)}</span>{fact.application && <small>{fact.application}</small>}</div>)}</section>;
  const setupActions = (row: HarnessSnapshot) => {
    const needsSetup = !canExecute({ ...row, policy: { ...row.policy, enabled: true } });
    const command = !row.availability.installed ? row.setup?.installCommand : row.availability.state === "auth-required" ? row.setup?.signInCommand : undefined;
    return <div className="pkg-harnesses-setup-actions">
      {command && <Button size="sm" disabled={!projectId || busy} onClick={() => setSetup({ row, command, label: !row.availability.installed ? "Install" : "Sign in to" })}>{!row.availability.installed ? "Install" : "Sign in"}</Button>}
      {needsSetup && row.setup?.setupUrl && <a href={row.setup.setupUrl} target="_blank" rel="noreferrer">Setup guide ↗</a>}
      {needsSetup && <Button size="sm" variant="ghost" busy={loading} onClick={() => void refresh(true)}>Retry</Button>}
    </div>;
  };
  const dialogs = <>
    {explanation && <Dialog title={`${explanation.label} · ${explanation.value}`} onClose={() => setExplanation(undefined)}><p>{explanation.description}</p></Dialog>}
    {setup && <Dialog title={`${setup.label} ${setup.row.identity.name}`} onClose={() => setSetup(undefined)}><div className="pkg-harnesses pkg-harnesses-command-review"><p>Run this native command on the selected project target:</p><pre>{setup.command}</pre><Button busy={busy} onClick={() => void runSetup()}>Run command</Button></div></Dialog>}
  </>;

  const runSetup = async () => {
    if (!setup || !projectId) return;
    setBusy(true);
    setFailure("");
    try {
      const result = await api.post<{ terminalId: string }>("/api/terminals", { projectId, cmd: setup.command });
      setTerminal(result.terminalId);
      setSetup(undefined);
      host.navigation.setOverlay(null);
      host.navigation.openWorkspacePane("terminal");
    } catch (cause) {
      setFailure(host.errors.friendly("Run native setup", cause));
    } finally {
      setBusy(false);
    }
  };

  if (detail) return <div className="pkg-harnesses pkg-harnesses-settings pkg-harnesses-detail" aria-busy={loading}>
    <div className="pkg-harnesses-settings-actions"><Button size="sm" variant="ghost" onClick={() => setDetailId(undefined)}>‹ Harnesses</Button><Button size="sm" variant="ghost" busy={loading} onClick={() => void refresh(true)} aria-label="Refresh harness">↻</Button></div>
    <header className="pkg-harnesses-detail-head"><h2><ProviderLogo providerID={detail.identity.id} providerName={detail.identity.name} size="regular" />{detail.identity.name}</h2><span className="pkg-harnesses-status" data-state={detail.availability.state}>{availabilityLabel(detail)}</span><p>{integrationLabel(detail)} · {detail.identity.integration}</p></header>
    {(error || failure) && <Notice tone="error" role="alert">{failure || error}</Notice>}
    {pendingLabel(detail) && <Notice actions={pendingSection && <Button size="sm" onClick={() => setSectionId(pendingSection.id)}>Review changes</Button>}>{pendingLabel(detail)}</Notice>}
    {detail.stale && <Notice tone="warning">Showing the last known configuration. Refresh to verify current availability.</Notice>}
    {setupActions(detail)}
    <Tabs className="pkg-harnesses-tabs" tabs={[{ id: "overview", label: "Overview" }, ...contributed]} value={activeSection} onChange={setSectionId} label={`${detail.identity.name} settings`} size="sm" idBase={tabsId} />
    <TabPanel idBase={tabsId} tabId={activeSection} active>
    {activeSection === "overview" ? <div className="pkg-harnesses-overview">
      <section className="pkg-harnesses-selection"><h3>Selection</h3><dl>
        <dt>Auto routing</dt><dd>{routingLabel(detail, rows)}{detail.policy.enabled && detail.policy.autoSelect && !canExecute(detail) ? " · Not ready" : ""}</dd>
        <dt>Auto eligible</dt><dd>{detail.policy.autoSelect ? "Yes, when enabled and ready" : "No · Select this harness manually"}</dd>
        <dt>Enabled for new sessions</dt><dd><Switch label={`Allow ${detail.identity.name} for new sessions`} checked={detail.policy.enabled} disabled={busy} onChange={(enabled) => toggle(detail.identity.id, enabled)} /></dd>
        <dt>Execution target</dt><dd>{target}</dd>
      </dl></section>
      <section className="pkg-harnesses-configuration"><h3>Configuration</h3>
        {contributed.length > 0 ? <div className="pkg-harnesses-section-links">{contributed.map((section) => <Button key={section.id} variant="ghost" size="sm" onClick={() => setSectionId(section.id)}>{section.label} ›</Button>)}</div> : <p>This harness contributes no additional settings sections.</p>}
        {detail.configuration?.controls?.filter((control) => control.placement === "harness-overview" || control.placement === "harness-settings").map((control) => <GenericControl key={control.id} control={control} harnessId={detail.identity.id} projectId={projectId ?? undefined} refresh={() => refresh(true)} />)}
      </section>
      {detail.catalog && <section className="pkg-harnesses-catalog"><h3>Models &amp; providers</h3><dl>
        <dt>Models</dt><dd>{detail.catalog.models ? `${detail.catalog.models.length} available` : "Not reported"}</dd>
        {detail.catalog.providers && <><dt>Providers</dt><dd>{detail.catalog.providers.map((provider) => provider.name).join(", ") || "None configured"}</dd></>}
        {detail.catalog.modes && <><dt>Modes</dt><dd>{detail.catalog.modes.join(", ") || "None reported"}</dd></>}
      </dl><p className="pkg-harnesses-help">Choose models in the conversation picker. Harness-specific configuration is listed above.</p></section>}
      {matrix("Polyth integration", projectionFacts(detail))}
      <p className="pkg-harnesses-help">{detail.capabilitySupport?.targetLifetime === "physical-runtime" ? "Polyth manages capability configuration for a shared runtime. Some changes need a runtime restart." : "Capability configuration is scoped to each session. Delivery modes below describe how Polyth supplies instructions, tools and context."}</p>
      {matrix("Runtime features", runtimeFacts(detail))}
      {detail.capabilities?.commands && matrix("Commands", [{ id: "discovery", label: "Discovery", value: detail.capabilities.commands.discovery, description: "How the harness exposes its native command catalog." }, { id: "invocation", label: "Invocation", value: detail.capabilities.commands.invoke === "raw-native-input" ? "Native input" : "Unsupported", description: "Commands are passed to the harness as native input." }])}
      {matrix("Attachments", attachmentFacts(detail))}
      <p className="pkg-harnesses-help">Declared harness support. Selected models, native versions and execution targets can impose additional limits.</p>
      <details className="pkg-harnesses-diagnostics"><summary>Diagnostics</summary><dl><dt>Version</dt><dd>{detail.identity.version ?? "Not reported"}</dd><dt>Protocol</dt><dd>{detail.identity.integration}</dd><dt>Target</dt><dd>{target}</dd><dt>Last checked</dt><dd>{new Date(detail.availability.checkedAt).toLocaleString()}</dd></dl>{detail.message && <p>{detail.message}</p>}</details>
    </div> : <host.ui.Slot key={`${detail.identity.id}:${activeSection}`} slot="settings.harness.detail" context={{ harnessId: detail.identity.id, sectionId: activeSection, snapshot: detail, projectId }} />}
    </TabPanel>
    {dialogs}
  </div>;

  return <div className="pkg-harnesses pkg-harnesses-settings" aria-busy={loading}>
    <header><p>Choose which execution engines Polyth can use for conversations.</p><small>{target}</small></header>
    <section className="pkg-harnesses-default"><div><span>Default for new sessions</span><strong>Auto → {auto?.identity.name ?? (loading ? "Checking…" : "No available harness")}</strong></div><p>Uses the first ready Auto-eligible harness in priority order. Availability is checked again when connecting.</p></section>
    <div className="pkg-harnesses-settings-actions"><div><h3>Harness order</h3><small>Auto checks eligible harnesses in this order.</small></div><Button size="sm" variant="ghost" busy={loading} onClick={() => void refresh(true)} aria-label="Refresh harnesses">↻</Button></div>
    {(error || failure) && <Notice tone="error" role="alert">{failure || error}</Notice>}
    {loading && rows.length === 0 && <p role="status">Checking execution engines…</p>}
    {!loading && rows.length === 0 && !error && <Notice>No harnesses are registered on this target.</Notice>}
    {!loading && rows.length > 0 && !rows.some(canExecute) && <Notice>Enable or set up a harness below to start a conversation.</Notice>}
    <div className="pkg-harnesses-list">
      {ordered.map((row, index) => {
        const sections = sectionsFor(row.identity.id);
        return <article className={`pkg-harnesses-row${dragged === row.identity.id ? " dragging" : ""}`} data-enabled={row.policy.enabled} key={row.identity.id} onClick={(event) => { if (!(event.target as HTMLElement).closest("button, a, input, label, [role=switch]")) openDetail(row.identity.id); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/plain") || dragged; if (id) move(id, index); setDragged(undefined); }}>
          <span className="pkg-harnesses-drag" aria-hidden="true" draggable={!busy} onDragStart={(event: DragEvent<HTMLElement>) => { setDragged(row.identity.id); event.dataTransfer.setData("text/plain", row.identity.id); }} onDragEnd={() => setDragged(undefined)}>⠿</span>
          <button type="button" className="pkg-harnesses-row-main" onClick={() => openDetail(row.identity.id)}><ProviderLogo providerID={row.identity.id} providerName={row.identity.name} size="regular" /><span><strong>{row.identity.name}</strong><small>{row.identity.integration}{row.identity.version ? ` · ${row.identity.version}` : ""}</small><small>{integrationLabel(row)}</small></span></button>
          <div className="pkg-harnesses-row-state"><span className="pkg-harnesses-status" data-state={row.availability.state}>{availabilityLabel(row)}</span><span>{routingLabel(row, rows)}</span>{pendingLabel(row) && <small>{pendingLabel(row)}</small>}</div>
          <div className="pkg-harnesses-row-toggle"><Switch label={`Allow ${row.identity.name} for new sessions`} checked={row.policy.enabled} disabled={busy} onChange={(enabled) => toggle(row.identity.id, enabled)} /></div>
          <div className="pkg-harnesses-chips">{summaryFacts(row).map((fact) => explain(fact))}</div>
          <div className="pkg-harnesses-row-actions"><Button variant="ghost" size="sm" onClick={() => openDetail(row.identity.id, sections[0]?.id)}>{sections.length ? "Configure" : "Details"} ›</Button><span className="pkg-harnesses-reorder"><MoveControls label={row.identity.name} index={index} count={ordered.length} onMove={(next) => move(row.identity.id, next)} /></span></div>
          {setupActions(row)}
        </article>;
      })}
    </div>
    <p className="pkg-harnesses-help">Enabled harnesses can be selected for new sessions. Manual-only harnesses are excluded from Auto. Existing conversations keep their current harness.</p>
    {dialogs}
  </div>;
}

function SwitchMarker({ event }: { event: SessionEvent }) {
  if (event.type !== "harness/switched") return null;
  const from = String(event.data.from || "");
  const to = String(event.data.to || "");
  const fromLabel = harnessDisplayName(from) || "Previous harness";
  const toLabel = harnessDisplayName(to) || "New harness";
  const closed = event.data.closedLeg as Record<string, unknown> | undefined;
  const leg = event.data.leg as Record<string, unknown> | undefined;
  return <details className="pkg-harnesses-switch-marker">
    <summary aria-label={`Switched from ${fromLabel} to ${toLabel}; continued here`}>
      <span className="pkg-harnesses-switch-marker-label">
        <span className="pkg-harnesses-switch-marker-leg"><ProviderLogo providerID={from || fromLabel} providerName={fromLabel} size="compact" /><span className="pkg-harnesses-switch-marker-name">{fromLabel}</span></span>
        <span className="pkg-harnesses-switch-marker-arrow" aria-hidden="true">→</span>
        <span className="pkg-harnesses-switch-marker-leg"><ProviderLogo providerID={to || toLabel} providerName={toLabel} size="compact" /><span className="pkg-harnesses-switch-marker-name">{toLabel}</span></span>
        <span className="pkg-harnesses-switch-marker-separator" aria-hidden="true">·</span>
        <span className="pkg-harnesses-switch-marker-continuity">continued here</span>
      </span>
    </summary>
    <dl><dt>Started</dt><dd><time dateTime={new Date(event.time).toISOString()}>{new Date(event.time).toLocaleTimeString()}</time></dd><dt>Continuity</dt><dd>Canonical Polyth history</dd>{Boolean(closed?.nativeSessionId) && <><dt>Previous native session</dt><dd>{String(closed!.nativeSessionId)}</dd></>}{Boolean(leg?.nativeSessionId) && <><dt>New native session</dt><dd>{String(leg!.nativeSessionId)}</dd></>}{Boolean(leg?.bootstrap) && <><dt>Bootstrap</dt><dd>{String(leg!.bootstrap)}</dd></>}</dl>
  </details>;
}

export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({ id: "harnesses", packageId: "harness-runtime", label: "Harnesses", group: "Engineering", order: 15, component: ({ settingsTarget }) => <HarnessSettings host={host} settingsTarget={settingsTarget}/> }),
    host.slots.register({ id: "harnesses.model-tabs", slot: "modelPicker.header", order: 10, render: (props) => <HarnessTabs host={host} spaceId={props.spaceId as string | undefined} projectId={props.projectId as string | undefined} sessionId={props.sessionId as string | undefined} harnessSelection={props.harnessSelection as HarnessSelection | undefined} resolvedHarnessId={props.resolvedHarnessId as string | undefined} transition={props.harnessTransition as HarnessTransition | undefined} pendingHarnessSelection={props.pendingHarnessSelection as HarnessSelection | undefined} onSelectHarness={props.onSelectHarness as ((selection: HarnessSelection) => void) | undefined} projectHarnessDefault={props.projectHarnessDefault as HarnessSelection | null | undefined} /> }),
    host.slots.register({ id: "harnesses.transition", slot: "session.composer.before", order: 10, render: (props) => <HarnessTransitionStatus host={host} sessionId={props.sessionId as string | undefined} resolvedHarnessId={props.resolvedHarnessId as string | undefined} transition={props.harnessTransition as HarnessTransition | undefined} /> }),
    host.slots.register({ id: "harnesses.switch-marker", slot: "session.timeline.event", meta: { eventTypes: ["harness/switched"] }, render: (props) => <SwitchMarker event={props.event as SessionEvent} /> }),
  ];
  return () => {
    off.toReversed().forEach((dispose) => dispose());
    resetRuntimeCatalogMemory();
  };
});
