import "./styles.css";
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import type {
  HarnessControlDescriptor,
  HarnessSelection,
  HarnessSnapshot,
  HarnessTransition,
  SessionEvent,
  SessionProjection,
} from "@polyth/contracts";
import { createApiTransport, defineWebPackage, type WebPackageHost } from "@polyth/web-sdk";
import { Button, Dialog, Notice, ResponsiveOverlay, Select, Switch, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import MoveControls from "../../../apps/web/src/components/MoveControls.tsx";

const api = createApiTransport();

const availabilityLabel = (row: HarnessSnapshot): string => {
  switch (row.availability.state) {
    case "ready": return "Ready";
    case "not-installed": return "Not installed";
    case "starting": return "Starting…";
    case "auth-required": return "Sign in";
    case "setup-required":
    case "partially-configured": return "Setup incomplete";
    case "incompatible": return "Not available here";
    case "offline":
    case "degraded": return row.stale ? "Last known" : "Unavailable";
    case "unknown": return row.availability.healthy ? "Ready" : "Unavailable";
  }
};

const canExecute = (row: HarnessSnapshot): boolean => row.policy.enabled
  && row.availability.installed
  && row.availability.healthy
  && row.availability.authenticated !== false
  && !["setup-required", "partially-configured", "incompatible", "offline", "not-installed"]
    .includes(row.availability.state);

const setupLabel = (row: HarnessSnapshot): string | undefined => {
  if (!row.availability.installed && row.setup?.installCommand) return "Install";
  if (row.availability.state === "auth-required" && row.setup?.signInCommand) return "Sign in";
  if (["setup-required", "partially-configured"].includes(row.availability.state)) return "Configure";
  if (!canExecute(row)) return "Details";
  return undefined;
};

function useHarnesses(projectId?: string | null) {
  const [rows, setRows] = useState<HarnessSnapshot[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = async (force = false, detail = false) => {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (projectId) query.set("projectId", projectId);
      if (force) query.set("force", "1");
      if (detail) query.set("detail", "1");
      setRows(await api.get<HarnessSnapshot[]>(`/api/harnesses/snapshots?${query}`));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void refresh(); }, [projectId]);
  return { rows, error, loading, refresh };
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
            : control.kind === "text" ? <TextInput uiSize="sm" value={textValue} disabled={disabled} onChange={(event) => setTextValue(event.target.value)} onBlur={() => { if (textValue !== control.value) void apply(textValue); }} />
              : <Button size="sm" busy={busy} disabled={disabled} onClick={() => void apply(true)}>{control.label}</Button>}
    </div>
    {error && <Notice tone="error" role="alert">{error}</Notice>}
  </div>;
}

function HarnessPicker({
  host,
  projectId,
  sessionId,
  sessionStatus,
  harnessSelection,
  resolvedHarnessId,
  transition,
  projectHarnessDefault,
  modelLabel,
  modelControl,
  agentControl,
  effortControl,
  profileControl,
  phoneLayout,
}: {
  host: WebPackageHost;
  projectId?: string;
  sessionId?: string;
  sessionStatus?: string;
  harnessSelection?: HarnessSelection;
  resolvedHarnessId?: string;
  transition?: HarnessTransition;
  projectHarnessDefault?: HarnessSelection | null;
  modelLabel?: string;
  modelControl?: ReactNode;
  agentControl?: ReactNode;
  effortControl?: ReactNode;
  profileControl?: ReactNode;
  phoneLayout?: boolean;
}) {
  const { rows, error } = useHarnesses(projectId);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [screen, setScreen] = useState<"harnesses" | "timing">("harnesses");
  const [choice, setChoice] = useState<HarnessSelection>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [draftSelection, setDraftSelection] = useState<HarnessSelection>(() =>
    projectId ? host.executionDraft.get(projectId).harnessSelection : { mode: "auto" });
  const [draftExplicit, setDraftExplicit] = useState(() =>
    projectId ? host.executionDraft.get(projectId).harnessSelectionExplicit === true : false);
  useEffect(() => {
    const config = projectId ? host.executionDraft.get(projectId) : undefined;
    setDraftSelection(config?.harnessSelection ?? { mode: "auto" });
    setDraftExplicit(config?.harnessSelectionExplicit === true);
  }, [projectId]);

  const selection = sessionId
    ? harnessSelection ?? { mode: "auto" }
    : !draftExplicit && projectHarnessDefault
      ? projectHarnessDefault
      : draftSelection;
  const automatic = rows
    .filter((row) => row.policy.autoSelect && canExecute(row))
    .toSorted((a, b) => a.policy.priority - b.policy.priority || a.identity.id.localeCompare(b.identity.id))[0];
  const currentId = transition?.targetHarnessId
    ?? resolvedHarnessId
    ?? (selection.mode === "pinned" ? selection.harnessId : automatic?.identity.id);
  const current = rows.find((row) => row.identity.id === currentId);
  const target = transition ? rows.find((row) => row.identity.id === transition.targetHarnessId) : undefined;
  const currentName = current?.identity.name ?? currentId ?? "Auto";

  const perform = async (next: HarnessSelection, timing: "after-turn" | "stop-now") => {
    if (!projectId) return;
    if (!sessionId) {
      const previous = host.executionDraft.get(projectId);
      const nextHarnessId = next.mode === "pinned" ? next.harnessId : undefined;
      const config = host.executionDraft.update(projectId, {
        harnessSelection: next,
        harnessSelectionExplicit: true,
        ...(previous.model && nextHarnessId && previous.model.harnessId !== nextHarnessId ? { model: undefined } : {}),
        ...(previous.agent && nextHarnessId && previous.agent.harnessId !== nextHarnessId ? { agent: undefined } : {}),
      });
      setDraftSelection(config.harnessSelection);
      setDraftExplicit(true);
      setOpen(false);
      const nextName = next.mode === "pinned"
        ? rows.find((row) => row.identity.id === next.harnessId)?.identity.name ?? next.harnessId
        : undefined;
      setAnnouncement(nextName ? `${nextName} selected for the new conversation.` : "Automatic harness selection enabled.");
      return;
    }
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
      setOpen(false);
      setScreen("harnesses");
    } catch (cause) {
      setFailure(host.errors.friendly("Change harness", cause));
    } finally {
      setBusy(false);
    }
  };

  const choose = (next: HarnessSelection) => {
    if (sessionId && (sessionStatus === "working" || sessionStatus === "waiting") && !transition) {
      setChoice(next);
      setScreen("timing");
      return;
    }
    void perform(next, transition?.phase === "requested" ? transition.timing : "after-turn");
  };

  const cancel = async () => {
    if (!sessionId) return;
    setBusy(true);
    setFailure("");
    try {
      host.sessions.upsert(await api.post<SessionProjection>(`/api/harnesses/sessions/${encodeURIComponent(sessionId)}/cancel`, {}));
      setAnnouncement("Harness switch cancelled. The current harness will continue.");
    } catch (cause) {
      setFailure(host.errors.friendly("Cancel harness switch", cause));
    } finally {
      setBusy(false);
    }
  };

  const label = transition
    ? transition.phase === "requested"
      ? `${resolvedHarnessId ?? "Current"} → ${target?.identity.name ?? transition.targetHarnessId}`
      : transition.phase === "released"
        ? `Starting ${target?.identity.name ?? transition.targetHarnessId}…`
        : `${target?.identity.name ?? transition.targetHarnessId} couldn't start`
    : phoneLayout && modelLabel ? `${currentName} · ${modelLabel}` : currentName;

  return <div className="pkg-harnesses pkg-harnesses-picker">
    <span ref={triggerRef} className="pkg-harnesses-trigger-anchor">
      <Button size="sm" variant="ghost" className="pkg-harnesses-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setScreen("harnesses"); setOpen((value) => !value); }}>
        <span aria-hidden="true">◈</span> {label} <span aria-hidden="true">⌄</span>
        {!transition && selection.mode === "auto" && current && <span className="pkg-harnesses-auto-dot" title="Selected automatically">·</span>}
      </Button>
    </span>
    <ResponsiveOverlay open={open} onClose={() => setOpen(false)} title={screen === "timing" ? `Switch to ${choice?.mode === "pinned" ? rows.find((row) => row.identity.id === choice.harnessId)?.identity.name ?? choice.harnessId : "Auto"}` : "Execution harness"} anchorRef={triggerRef} className="pkg-harnesses-overlay" sheetSize="auto">
      {screen === "timing" && choice ? <div className="pkg-harnesses-timing">
        <Button block variant="quiet" busy={busy} onClick={() => void perform(choice, "after-turn")}><span><strong>After this response</strong><small>Let the current harness finish normally.</small></span></Button>
        <Button block variant="ghost" disabled={busy} onClick={() => void perform(choice, "stop-now")}><span><strong>Switch now</strong><small>Stop this response and continue.</small></span></Button>
        <Button size="sm" variant="ghost" onClick={() => setScreen("harnesses")}>Back</Button>
      </div> : <div className="pkg-harnesses-menu">
        <button type="button" className={`pkg-harnesses-option${selection.mode === "auto" ? " current" : ""}`} onClick={() => choose({ mode: "auto" })}>
          <span><strong>Auto selection</strong><small>Keep using the first compatible harness.</small></span>
          {selection.mode === "auto" && <span aria-label="Selected">✓</span>}
        </button>
        {rows.toSorted((a, b) => a.policy.priority - b.policy.priority || a.identity.name.localeCompare(b.identity.name)).map((row) => {
          const selected = selection.mode === "pinned" && selection.harnessId === row.identity.id;
          const action = setupLabel(row);
          return <div className="pkg-harnesses-option-wrap" key={row.identity.id}>
            <button type="button" className={`pkg-harnesses-option${selected ? " current" : ""}`} disabled={!canExecute(row) || busy} onClick={() => choose({ mode: "pinned", harnessId: row.identity.id })}>
              <span><strong>{row.identity.name}</strong><small>{availabilityLabel(row)}{row.stale ? " · Showing last known catalog" : ""}</small></span>
              {selected && <span aria-label="Selected">✓</span>}
            </button>
            {action && <Button size="sm" variant="ghost" onClick={() => { setOpen(false); host.navigation.openSettingsPage("harnesses"); }}>{action} →</Button>}
          </div>;
        })}
        {phoneLayout && (modelControl || agentControl || effortControl || profileControl) && <section className="pkg-harnesses-mobile-config" aria-label="Execution settings">
          {modelControl && <div><span>Model</span>{modelControl}</div>}
          {agentControl && <div><span>Role</span>{agentControl}</div>}
          {effortControl && <div><span>Thinking</span>{effortControl}</div>}
          {profileControl && <div><span>Profile</span>{profileControl}</div>}
        </section>}
        {!phoneLayout && profileControl && <section className="pkg-harnesses-mobile-config" aria-label="Execution profile"><div><span>Profile</span>{profileControl}</div></section>}
        <Button size="sm" variant="ghost" onClick={() => { setOpen(false); host.navigation.openSettingsPage("harnesses"); }}>Manage harnesses…</Button>
      </div>}
      {failure && <Notice tone="error" role="alert">{failure}</Notice>}
    </ResponsiveOverlay>
    {transition?.phase === "requested" && <div className="pkg-harnesses-transition" role="status">
      <span>Waiting for current response · Will run with {target?.identity.name ?? transition.targetHarnessId}</span>
      <Button size="sm" busy={busy} onClick={() => void perform(transition.selection, "stop-now")}>Switch now</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>Cancel</Button>
    </div>}
    {transition?.phase === "released" && <div className="pkg-harnesses-transition" role="status">Starting {target?.identity.name ?? transition.targetHarnessId}…</div>}
    {transition?.phase === "failed" && <Notice tone="error" role="alert" heading={`${target?.identity.name ?? transition.targetHarnessId} couldn't start`} actions={<><Button size="sm" busy={busy} onClick={() => void perform(transition.selection, "after-turn")}>Retry</Button><Button size="sm" variant="ghost" onClick={() => { setScreen("harnesses"); setOpen(true); }}>Choose another</Button></>}>
      The previous harness stopped safely. {transition.error?.message ?? "Choose how to continue."}
      <details><summary>Diagnostics</summary><dl><dt>Stage</dt><dd>{transition.error?.stage ?? "starting target"}</dd><dt>Attempt</dt><dd>{transition.attempt ?? 1}</dd></dl></details>
    </Notice>}
    {(failure || error) && !open && <Notice tone="error" role="alert">{failure || error}</Notice>}
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
  </div>;
}

function HarnessSettings({ host }: { host: WebPackageHost }) {
  const projectId = host.store.select((state) => state.activeProjectId);
  const { rows, error, loading, refresh } = useHarnesses(projectId);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragged, setDragged] = useState<string>();
  const [detailId, setDetailId] = useState<string>();
  const [sectionId, setSectionId] = useState("overview");
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
  }, [projectId, terminal]);

  const ordered = rows.toSorted((a, b) => a.policy.priority - b.policy.priority || a.identity.id.localeCompare(b.identity.id));
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
    const from = ordered.findIndex((row) => row.identity.id === id);
    if (from < 0 || index < 0 || index >= ordered.length || from === index) return;
    const next = [...ordered];
    const [item] = next.splice(from, 1);
    next.splice(index, 0, item!);
    void saveOrder(next);
  };
  const toggle = (id: string, enabled: boolean) => void saveOrder(ordered.map((row) => row.identity.id === id ? { ...row, policy: { ...row.policy, enabled } } : row));
  const openDetail = (id: string) => { setDetailId(id); setSectionId("overview"); void refresh(false, true); };
  const detail = rows.find((row) => row.identity.id === detailId);
  const contributed = detail ? host.slots.list("settings.harness.detail")
    .filter((item) => item.meta?.harnessId === detail.identity.id)
    .map((item) => ({ id: String(item.meta?.sectionId ?? item.id), label: String(item.meta?.label ?? item.id), order: item.order }))
    .toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id)) : [];

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

  if (detail) return <div className="pkg-harnesses pkg-harnesses-settings pkg-harnesses-detail">
    <Button size="sm" variant="ghost" onClick={() => setDetailId(undefined)}>‹ Harnesses</Button>
    <header><h2>{detail.identity.name}</h2><p>{availabilityLabel(detail)}{detail.identity.version ? ` · ${detail.identity.version}` : ""}</p></header>
    <nav className="pkg-harnesses-tabs" aria-label={`${detail.identity.name} settings`}>
      {[{ id: "overview", label: "Overview", order: -1 }, ...contributed].map((section) => <Button key={section.id} size="sm" variant={sectionId === section.id ? "quiet" : "ghost"} aria-pressed={sectionId === section.id} onClick={() => setSectionId(section.id)}>{section.label}</Button>)}
    </nav>
    {sectionId === "overview" ? <section className="pkg-harnesses-overview">
      <dl><dt>Status</dt><dd>{availabilityLabel(detail)}</dd>{detail.identity.version && <><dt>Version</dt><dd>{detail.identity.version}</dd></>}<dt>Protocol</dt><dd>{detail.identity.integration}</dd><dt>Target</dt><dd>{detail.context.remote ? "Remote project target" : "This machine"}</dd></dl>
      {detail.configuration?.controls?.filter((control) => control.placement === "harness-overview" || control.placement === "harness-settings").map((control) => <GenericControl key={control.id} control={control} harnessId={detail.identity.id} projectId={projectId ?? undefined} refresh={() => refresh(true, true).then(() => {})} />)}
      {detail.stale && <Notice tone="warning">Offline. Showing the last known catalog.</Notice>}
      {detail.message && <details><summary>Diagnostics</summary><p>{detail.message}</p></details>}
    </section> : <host.ui.Slot slot="settings.harness.detail" context={{ harnessId: detail.identity.id, sectionId, snapshot: detail, projectId }} />}
  </div>;

  return <div className="pkg-harnesses pkg-harnesses-settings">
    <header><h2>Harnesses</h2><p>Choose execution engines for new conversations. Existing conversations keep their current harness.</p></header>
    <section className="pkg-harnesses-default"><div><strong>Default for new sessions</strong><span>Auto</span></div><p>Polyth chooses the first compatible harness and keeps using it for the conversation while it remains available.</p><small>Checking harnesses on <strong>{rows.some((row) => row.context.remote) ? "project execution target" : "This machine"}</strong></small></section>
    <div className="pkg-harnesses-settings-actions"><strong>Preferred order</strong><Button size="sm" busy={loading} onClick={() => void refresh(true)}>Refresh</Button></div>
    {(error || failure) && <Notice tone="error" role="alert">{failure || error}</Notice>}
    {!loading && !rows.some(canExecute) && <Notice>Set up a harness below to start a conversation.</Notice>}
    <div className="pkg-harnesses-list">
      {ordered.map((row, index) => <article className={`pkg-harnesses-row${dragged === row.identity.id ? " dragging" : ""}`} key={row.identity.id} draggable={!busy} onDragStart={(event: DragEvent<HTMLElement>) => { setDragged(row.identity.id); event.dataTransfer.setData("text/plain", row.identity.id); }} onDragEnd={() => setDragged(undefined)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/plain") || dragged; if (id) move(id, index); setDragged(undefined); }}>
        <button type="button" className="pkg-harnesses-row-main" onClick={() => openDetail(row.identity.id)}><span className="pkg-harnesses-drag" aria-hidden="true">⠿</span><span><strong>{row.identity.name}</strong><small>{row.identity.integration}{row.identity.version ? ` · ${row.identity.version}` : ""}</small></span><span className="pkg-harnesses-status">{availabilityLabel(row)}</span></button>
        <MoveControls label={row.identity.name} index={index} count={ordered.length} onMove={(next) => move(row.identity.id, next)} />
        <div className="pkg-harnesses-availability"><span><strong>Available for new sessions</strong><small>Existing conversations are unaffected.</small></span><Switch label={`Allow ${row.identity.name} for new sessions`} checked={row.policy.enabled} disabled={busy} onChange={(enabled) => toggle(row.identity.id, enabled)} /></div>
        {setupLabel(row) && <div className="pkg-harnesses-setup-actions">
          {(!row.availability.installed ? row.setup?.installCommand : row.setup?.signInCommand) && <Button size="sm" disabled={!projectId} onClick={() => setSetup({ row, command: (!row.availability.installed ? row.setup?.installCommand : row.setup?.signInCommand)!, label: !row.availability.installed ? "Install" : "Sign in to" })}>{setupLabel(row)}</Button>}
          {row.setup?.setupUrl && <a href={row.setup.setupUrl} target="_blank" rel="noreferrer">Open setup guide</a>}
        </div>}
      </article>)}
    </div>
    {setup && <Dialog title={`${setup.label} ${setup.row.identity.name}`} onClose={() => setSetup(undefined)}><div className="pkg-harnesses pkg-harnesses-command-review"><p>Run this native command on the selected project target:</p><pre>{setup.command}</pre><Button busy={busy} onClick={() => void runSetup()}>Run command</Button></div></Dialog>}
  </div>;
}

function SwitchMarker({ event }: { event: SessionEvent }) {
  if (event.type !== "harness/switched") return null;
  const from = String(event.data.from || "Previous harness");
  const to = String(event.data.to || "New harness");
  const closed = event.data.closedLeg as Record<string, unknown> | undefined;
  const leg = event.data.leg as Record<string, unknown> | undefined;
  return <details className="pkg-harnesses-switch-marker">
    <summary><span>{from} → {to} · continued here</span></summary>
    <dl><dt>Started</dt><dd><time dateTime={new Date(event.time).toISOString()}>{new Date(event.time).toLocaleTimeString()}</time></dd><dt>Continuity</dt><dd>Canonical Polyth history</dd>{Boolean(closed?.nativeSessionId) && <><dt>Previous native session</dt><dd>{String(closed!.nativeSessionId)}</dd></>}{Boolean(leg?.nativeSessionId) && <><dt>New native session</dt><dd>{String(leg!.nativeSessionId)}</dd></>}{Boolean(leg?.bootstrap) && <><dt>Bootstrap</dt><dd>{String(leg!.bootstrap)}</dd></>}</dl>
  </details>;
}

export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({ id: "harnesses", packageId: "harness-runtime", label: "Harnesses", group: "Engineering", order: 15, component: () => <HarnessSettings host={host}/> }),
    host.slots.register({ id: "harnesses.selector", slot: "composer.execution", order: 10, render: (props) => <HarnessPicker host={host} projectId={props.projectId as string | undefined} sessionId={props.sessionId as string | undefined} sessionStatus={props.sessionStatus as string | undefined} harnessSelection={props.harnessSelection as HarnessSelection | undefined} resolvedHarnessId={props.resolvedHarnessId as string | undefined} transition={props.harnessTransition as HarnessTransition | undefined} projectHarnessDefault={props.projectHarnessDefault as HarnessSelection | null | undefined} modelLabel={props.executionModelLabel as string | undefined} modelControl={props.executionModelControl as ReactNode} agentControl={props.executionAgentControl as ReactNode} effortControl={props.executionEffortControl as ReactNode} profileControl={props.executionProfileControl as ReactNode} phoneLayout={props.phoneLayout === true} /> }),
    host.slots.register({ id: "harnesses.switch-marker", slot: "session.timeline.event", meta: { eventTypes: ["harness/switched"] }, render: (props) => <SwitchMarker event={props.event as SessionEvent} /> }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
