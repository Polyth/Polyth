import "./styles.css";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { HarnessControlDescriptor, HarnessSnapshot, HarnessUpdateStatus } from "@polyth/contracts";
import { hiddenModelMatcher } from "@polyth/models";
import { pickerCatalogModels } from "@polyth/models/model-picker-state";
import { useModelPrefs } from "@polyth/models/web-prefs";
import { createApiTransport, type SettingsNavigationTarget, type WebPackageHost } from "@polyth/web-sdk";
import { BackIcon, Button, ChevronRightIcon, Dialog, DownloadIcon, DragHandleIcon, ExternalLinkIcon, Icon, IconButton, KeyIcon, NewChatIcon, Notice, RefreshIcon, Select, SessionIcon, Spinner, Switch, Tabs, TabPanel, TextInput, Tooltip } from "../../../apps/web/src/components/ui/index.ts";
import MoveControls from "../../../apps/web/src/components/MoveControls.tsx";
import { EmptyState, ErrorState, ReadonlyRow, Row, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import ProviderLogo from "@polyth/models/provider-logo";
import { canExecute, useHarnesses } from "./harnessData.ts";
import {
  attachmentFacts, autoCandidates, availabilityLabel, configurationSections, displayVersion, harnessProfileName, harnessSummary, harnessTint as tint, integrationLabel, orderedHarnesses,
  pendingLabel, projectionFacts, resolvedAuto, routingLabel, runtimeFacts, setupStep, statusTone, supportLabel, type CapabilityFact,
} from "./presentation.ts";
import { useHarnessAccountStatus, useHarnessSignIn, usePendingSignIn, useSetupProjectId } from "./HarnessSignIn.tsx";
import { PersonDefaultHarnessSection, usePersonDefaultHarness } from "./PersonDefaultHarness.tsx";
import HarnessAppearance from "./HarnessAppearance.tsx";
import HarnessPrivateSessions from "./HarnessPrivateSessions.tsx";
import { useReadinessChecks } from "./readiness.ts";
import { dismissHarnessUpdateRun, installableUpdate, runHarnessUpdate, useHarnessUpdates, type HarnessUpdateRun } from "./updates.ts";
import { useHarnessInstall } from "./HarnessInstall.tsx";
import { onHarnessInstallSettled, useHarnessInstalls } from "./installs.ts";
import { installIsActive, rowInstallStatus, type Translate } from "./installPresentation.ts";

const api = createApiTransport();

/** When a harness control's change takes effect, in plain words. */
const APPLIES: Record<HarnessControlDescriptor["applySemantics"], string> = {
  live: "applies.live",
  "next-turn": "applies.nextTurn",
  "restart-required": "applies.restart",
  "new-session-only": "applies.newSessionOnly",
  "read-only": "applies.readOnly",
};

/** Looks a message up under `harnessruntime.settings.` in the active locale. */
type SettingsTranslate = (key: string, values?: Record<string, string | number>) => string;

/** A translated sentence with {count} bolded: the number is a marker the
 *  sentence is split on, so word order stays the language's own. */
const COUNT_MARK = "\u0001";
function countText(text: string, count: number) {
  const [before = "", after = ""] = text.split(COUNT_MARK);
  return <>{before}<b>{count}</b>{after}</>;
}

function GenericControl({
  t,
  control,
  harnessId,
  projectId,
  refresh,
}: {
  t: SettingsTranslate;
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
    <div className="pkg-harnesses-control-copy">
      <strong>{control.label}</strong>
      {control.description && <span>{control.description}</span>}
      <small>{[t(APPLIES[control.applySemantics]), control.unavailableReason].filter(Boolean).join(" · ")}</small>
    </div>
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

/** Installed version, and the newer release when one is published. */
function VersionText({ t, row, update }: { t: SettingsTranslate; row: HarnessSnapshot; update?: HarnessUpdateStatus }) {
  const current = displayVersion(update?.current ?? row.identity.version);
  if (!current) return null;
  const latest = update?.available && update.latest ? displayVersion(update.latest) : undefined;
  return <span className="pkg-harnesses-version" title={row.identity.version}>
    <span className="pkg-harnesses-version-current">{current}</span>
    {latest && <span className="pkg-harnesses-version-next"><span aria-hidden="true">→</span><span className="sr-only">{t("updateAvailable")}</span> {latest}</span>}
  </span>;
}

/** How long a successful update's notice stays before it leaves on its own. */
export const UPDATE_OUTCOME_MS = 8_000;

/** What happened to an update started from Settings: the version Polyth sees
 *  installed afterwards (an updater may follow its own release channel), or
 *  why the CLI's own updater failed, with its output. */
function UpdateOutcome({ t, name, run, onRetry, onRestart, onDismiss }: {
  t: SettingsTranslate;
  name: string;
  run: Exclude<HarnessUpdateRun, { state: "running" }>;
  onRetry?: () => void;
  onRestart?: () => Promise<void>;
  onDismiss: () => void;
}) {
  const [restarting, setRestarting] = useState(false);
  const [restarted, setRestarted] = useState("");
  // A finished update is a passing confirmation: it leaves on its own unless
  // someone is reading it (pointer or focus inside) or a restart is running.
  // A failure stays until dismissed: it needs a decision.
  const [held, setHeld] = useState(false);
  const transient = run.state === "done" && !held && !restarting;
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (!transient) return;
    const timer = setTimeout(() => dismissRef.current(), UPDATE_OUTCOME_MS);
    return () => clearTimeout(timer);
  }, [transient, restarted]);
  if (run.state === "done") {
    const now = displayVersion(run.to);
    const changed = Boolean(now && now !== displayVersion(run.from));
    return <Notice tone="success" role="status" heading={changed ? t("outcome.updated", { name, version: now ?? "" }) : t("outcome.finished", { name })}
      onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false); }}
      actions={<>
        {onRestart && !restarted && <Button size="sm" variant="ghost" iconStart={RefreshIcon} busy={restarting} onClick={() => {
          setRestarting(true);
          void onRestart().then(() => setRestarted(t("outcome.restarted")), (cause: unknown) => setRestarted(cause instanceof Error ? cause.message : t("outcome.restartFailed"))).finally(() => setRestarting(false));
        }}>{t("outcome.restartRuntime")}</Button>}
        <Button size="sm" variant="ghost" onClick={onDismiss}>{t("done")}</Button>
      </>}>
      {restarted || (changed
        ? t("outcome.changedBody")
        : now ? t("outcome.unchangedBody", { version: now }) : t("outcome.unchangedSameBody"))}
    </Notice>;
  }
  return <Notice tone="error" role="alert" heading={t("outcome.failed", { name })}
    actions={<>{onRetry && <Button size="sm" variant="ghost" onClick={onRetry}>{t("outcome.tryAgain")}</Button>}<Button size="sm" variant="ghost" onClick={onDismiss}>{t("outcome.dismiss")}</Button></>}>
    {run.message ?? (run.exitCode === null ? t("outcome.notFinished") : t("outcome.exitCode", { code: run.exitCode }))}
    {run.output && <details className="pkg-harnesses-update-log"><summary>{t("outcome.output")}</summary><pre>{run.output}</pre></details>}
  </Notice>;
}

const restartRuntime = async (harnessId: string, t: SettingsTranslate) => {
  const result = await api.post<{ restarted: number; failed: number }>(`/api/harnesses/${encodeURIComponent(harnessId)}/restart`, {});
  if (result.failed) throw new Error(t("outcome.restartCount", { count: result.failed }));
};

export function HarnessSettings({ host, settingsTarget }: { host: WebPackageHost; settingsTarget?: SettingsNavigationTarget }) {
  const projectId = host.store.select((state) => state.activeProjectId);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragged, setDragged] = useState<string>();
  const [reordering, setReordering] = useState(false);
  const [detailId, setDetailId] = useState(settingsTarget?.itemId);
  const [sectionId, setSectionId] = useState(settingsTarget?.sectionId ?? "overview");
  useEffect(() => { setDetailId(settingsTarget?.itemId); setSectionId(settingsTarget?.sectionId ?? "overview"); }, [settingsTarget]);
  const { rows: summaryRows, error, loading, refresh } = useHarnesses(projectId, undefined, detailId, { settings: true });
  const readiness = useReadinessChecks(summaryRows, { projectId, enabled: true });
  const rows = readiness.rows;
  const updates = useHarnessUpdates(projectId);
  const tabsId = useId();
  const [explanation, setExplanation] = useState<CapabilityFact>();
  // Turning harnesses on/off and reordering them is for the server owner and
  // accounts they allowed; the server enforces it, this only explains it.
  const [canManage, setCanManage] = useState(true);
  useEffect(() => {
    let live = true;
    void api.get<{ manage: boolean }>("/api/harnesses/access").then((access) => { if (live) setCanManage(access.manage); }, () => {});
    return () => { live = false; };
  }, []);
  const locked = busy || !canManage;
  const personDefault = usePersonDefaultHarness(host);
  const signIn = useHarnessSignIn({ host, projectId: useSetupProjectId(host) });
  const recheck = readiness.recheck;
  const refreshUpdates = updates.refresh;
  // "Check again" is a full answer: a fresh probe of every harness, then a
  // native check of each one the probe cannot see into, and the release list.
  const checkAgain = useCallback(async () => {
    void refreshUpdates(true);
    await refresh(true);
    recheck();
  }, [refresh, recheck, refreshUpdates]);
  // Returning from an explicit install/sign-in terminal is a meaningful reason
  // to re-check. Ordinary window focus must not invalidate the daily cache.
  const { pending, finish } = usePendingSignIn(checkAgain);
  const t: Translate = useCallback((key, values) => host.ui.locale.translate(`harnessruntime.install.${key}`, values), [host]);
  const signInText = (key: string, values?: Record<string, string | number>) => host.ui.locale.translate(`harnessruntime.signin.${key}`, values);
  const s: SettingsTranslate = useCallback((key, values) => host.ui.locale.translate(`harnessruntime.settings.${key}`, values), [host]);
  // A finished background install changes what this page knows: probe it
  // again, then let the native readiness check ask about sign-in.
  const installs = useHarnessInstalls(projectId, host);
  useEffect(() => onHarnessInstallSettled(() => { void checkAgain(); }), [checkAgain]);
  const installer = useHarnessInstall({
    host, projectId, rows, checking: readiness.checking, canManage, jobs: installs.jobs, requested: installs.requested,
    onSignIn: (row) => {
      if (!row.setup?.signInCommand) return;
      signIn.start({ harnessId: row.identity.id, harnessName: row.identity.name, command: row.setup.signInCommand, kind: "sign-in", ...(row.setup.setupUrl ? { setupUrl: row.setup.setupUrl } : {}) });
    },
    onTerminal: (row, command) => signIn.start({ harnessId: row.identity.id, harnessName: row.identity.name, command, kind: "install", ...(row.setup?.setupUrl ? { setupUrl: row.setup.setupUrl } : {}) }),
  });
  /** A row's install status while one is on record and it is not installed yet. */
  const installStatus = (row: HarnessSnapshot) => row.availability.installed ? undefined : rowInstallStatus(installs.jobs.get(row.identity.id), t);
  const pendingRow = pending ? rows.find((row) => row.identity.id === pending.harnessId) : undefined;
  const pendingDone = Boolean(pendingRow && !loading && !readiness.checking.has(pendingRow.identity.id) && pendingRow.availability.installed
    && pendingRow.availability.authenticated !== false && pendingRow.availability.state !== "auth-required"
    && pendingRow.availability.state !== "not-installed");

  const ordered = orderedHarnesses(rows);
  const saveOrder = async (next: HarnessSnapshot[]) => {
    setBusy(true);
    setFailure("");
    try {
      await api.put("/api/harnesses/preferences", { preferences: Object.fromEntries(next.map((row, index) => [row.identity.id, { enabled: row.policy.enabled, priority: index * 10 }])) });
      await refresh(true);
    } catch (cause) {
      setFailure(host.errors.friendly(s("savePreferences"), cause));
    } finally {
      setBusy(false);
    }
  };
  const move = (id: string, index: number) => {
    if (locked) return;
    const from = ordered.findIndex((row) => row.identity.id === id);
    if (from < 0 || index < 0 || index >= ordered.length || from === index) return;
    const next = [...ordered];
    const [item] = next.splice(from, 1);
    next.splice(index, 0, item!);
    void saveOrder(next);
  };
  const toggle = (id: string, enabled: boolean) => void saveOrder(ordered.map((row) => row.identity.id === id ? { ...row, policy: { ...row.policy, enabled } } : row));
  const openDetail = (id: string, section = "overview") => { setReordering(false); setDetailId(id); setSectionId(section); };
  const detail = rows.find((row) => row.identity.id === detailId);
  const sectionsFor = (row: HarnessSnapshot) => configurationSections(host.slots.list("settings.harness.detail"), row.identity.id, row.identity);
  const contributed = detail ? sectionsFor(detail) : [];
  const pendingSection = contributed.find((section) => section.handlesPendingChanges);
  const activeSection = sectionId === "overview" || contributed.some((section) => section.id === sectionId) ? sectionId : "overview";
  const target = rows.some((row) => row.context.remote) ? s("target.remote") : s("target.local");
  const auto = resolvedAuto(rows);
  const startUpdate = (row: HarnessSnapshot) => void runHarnessUpdate(row.identity.id, projectId);

  /** The one next step that makes a harness usable, or a quiet re-sign-in. */
  const stepAction = (row: HarnessSnapshot, options: { quiet?: boolean } = {}) => {
    const step = setupStep(row);
    const setupUrl = row.setup?.setupUrl;
    const start = (kind: "install" | "sign-in" | "sign-in-again", command: string) => signIn.start({
      harnessId: row.identity.id, harnessName: row.identity.name, command, kind, ...(setupUrl ? { setupUrl } : {}),
    });
    if (step.kind === "install") {
      // The background install; the Terminal stays one click away inside it.
      const active = installIsActive(installs.jobs.get(row.identity.id));
      return active
        ? <Button size="sm" variant="ghost" onClick={() => installer.open(row)}>{t("action.viewProgress")}</Button>
        : <Button size="sm" variant={options.quiet ? "ghost" : "primary"} iconStart={DownloadIcon} onClick={() => installer.open(row)}>{t("action.install")}</Button>;
    }
    if (step.kind === "sign-in") return <Button size="sm" variant={options.quiet ? "ghost" : "primary"} iconStart={KeyIcon} onClick={() => start("sign-in", step.command)}>{t("action.signIn")}</Button>;
    if (step.kind === "guide") return <a className="ui-btn ui-btn--ghost ui-btn--sm" href={step.url} target="_blank" rel="noreferrer">{t("action.guide")}<Icon icon={ExternalLinkIcon} size="sm" /></a>;
    if (step.kind === "sign-in-again" && !options.quiet) return <Button size="sm" variant="ghost" iconStart={KeyIcon} onClick={() => start("sign-in-again", step.command)}>{signInText("action.again")}</Button>;
    return null;
  };
  const outcome = (row: HarnessSnapshot) => {
    const run = updates.runs.get(row.identity.id);
    if (!run || run.state === "running") return null;
    return <UpdateOutcome key={`update:${row.identity.id}`} t={s} name={row.identity.name} run={run}
      onDismiss={() => dismissHarnessUpdateRun(row.identity.id)}
      {...(run.state === "failed" ? { onRetry: () => startUpdate(row) } : {})}
      {...(run.state === "done" && canManage ? { onRestart: () => restartRuntime(row.identity.id, s) } : {})} />;
  };
  const pendingName = pendingRow?.identity.name ?? pending?.harnessName ?? "";
  const pendingBanner = pending && <Notice
    tone={pendingDone ? "success" : "info"}
    role="status"
    heading={pendingDone
      ? signInText(pending.kind === "install" ? "pending.installed" : "pending.signedIn", { name: pendingName })
      : signInText("pending.waiting", { name: pending.harnessName })}
    actions={<>
      {!pendingDone && <Button size="sm" variant="ghost" iconStart={RefreshIcon} busy={loading} onClick={() => void checkAgain()}>{signInText("action.checkNow")}</Button>}
      <Button size="sm" variant="ghost" onClick={finish}>{pendingDone ? t("action.done") : signInText("action.dismiss")}</Button>
    </>}
  >
    {pendingDone
      ? signInText("pending.doneBody")
      : signInText(pending.kind === "install" ? "pending.installBody" : "pending.signInBody")}
  </Notice>;
  const dialogs = <>
    {explanation && <Dialog title={`${explanation.label} · ${explanation.value}`} onClose={() => setExplanation(undefined)}><p>{explanation.description}</p></Dialog>}
    {signIn.dialog}
    {installer.dialog}
  </>;

  if (detail) {
    return <HarnessDetail
      host={host}
      t={s}
      detail={detail}
      rows={rows}
      projectId={projectId}
      loading={loading}
      checking={readiness.checking.has(detail.identity.id)}
      error={error}
      failure={failure}
      canManage={canManage}
      locked={locked}
      target={target}
      tabsId={tabsId}
      contributed={contributed}
      pendingSection={pendingSection}
      activeSection={activeSection}
      update={updates.statuses.get(detail.identity.id)}
      updateRun={updates.runs.get(detail.identity.id)}
      onUpdate={() => startUpdate(detail)}
      onSection={setSectionId}
      onBack={() => setDetailId(undefined)}
      onRefresh={() => void checkAgain()}
      onToggle={(enabled) => toggle(detail.identity.id, enabled)}
      onExplain={setExplanation}
      stepAction={stepAction}
      installStatus={installStatus(detail)}
      banner={<>{pendingBanner}{outcome(detail)}</>}
      dialogs={dialogs}
    />;
  }

  const updateIds = new Set([...updates.statuses.values()].filter((status) => status.available).map((status) => status.harnessId));
  const summary = harnessSummary(rows, { checking: readiness.checking, updates: updateIds });
  const checkingAny = summary.checking > 0;
  const installing = rows.filter((row) => !row.availability.installed && installIsActive(installs.jobs.get(row.identity.id))).length;
  const outcomes = ordered.map(outcome).filter(Boolean);
  // A usable personal default outranks Auto for chats this person starts.
  const mine = personDefault.value?.usable
    ? rows.find((row) => row.identity.id === personDefault.value?.harnessId && row.policy.enabled)
    : undefined;
  const lead = mine ?? auto;
  /** "Update", with the target version riding in the label on narrow rows. */
  const updateLabel = (version: string | undefined) => {
    const base = s("update");
    const full = version ? s("updateTo", { version }) : base;
    return version && full.startsWith(base) ? <>{base}<span className="pkg-harnesses-update-target">{full.slice(base.length)}</span></> : full;
  };
  return <div className="pkg-harnesses pkg-harnesses-settings" aria-busy={loading || checkingAny}>
    <section className="pkg-harnesses-default" aria-label={s("statusAria")}>
      <span className="pkg-harnesses-logo-tile pkg-harnesses-logo-tile--lg" data-empty={lead ? undefined : "true"} data-tinted={lead?.identity.color || lead?.identity.accountLabel ? "true" : undefined} style={lead ? tint(lead.identity) : undefined}>
        {lead ? <ProviderLogo providerID={lead.identity.id} providerName={lead.identity.defaultName ?? lead.identity.name} size="regular" /> : <Icon icon={NewChatIcon} size="md" />}
      </span>
      <p className="pkg-harnesses-default-copy">
        <small>{mine ? s("lead.mine") : s("lead.auto")}</small>
        <strong>{lead ? harnessProfileName(lead.identity) : (loading ? "…" : s("lead.none"))}</strong>
        <span>{mine ? s("lead.mineCopy") : auto ? s("lead.autoCopy") : loading ? s("lead.loadingCopy") : s("lead.setupCopy")}</span>
      </p>
      <div className="pkg-harnesses-default-side">
        {rows.length > 0 && <ul className="pkg-harnesses-summary" aria-label={s("summaryAria")} role="status" aria-live="polite">
          {summary.ready > 0 && <li data-tone="success">{countText(s("summary.ready", { count: COUNT_MARK }), summary.ready)}</li>}
          {checkingAny && <li data-tone="neutral" data-busy="true"><Spinner size="sm" />{countText(s("summary.checking", { count: COUNT_MARK }), summary.checking)}</li>}
          {installing > 0 && <li data-tone="accent" data-busy="true"><Spinner size="sm" />{t("summary.installing", { count: installing })}</li>}
          {summary.attention > 0 && <li data-tone="warning">{countText(s(`summary.${summary.signIn === summary.attention ? "signIn" : "attention"}.${summary.attention === 1 ? "one" : "other"}`, { count: COUNT_MARK }), summary.attention)}</li>}
          {summary.updates > 0 && <li data-tone="accent">{countText(s(`summary.updates.${summary.updates === 1 ? "one" : "other"}`, { count: COUNT_MARK }), summary.updates)}</li>}
          {summary.unverified > 0 && <li data-tone="neutral">{countText(s("summary.unverified", { count: COUNT_MARK }), summary.unverified)}</li>}
          {summary.missing > 0 && <li data-tone="neutral">{countText(s("summary.missing", { count: COUNT_MARK }), summary.missing)}</li>}
          {summary.off > 0 && <li data-tone="neutral">{countText(s("summary.off", { count: COUNT_MARK }), summary.off)}</li>}
        </ul>}
        <Tooltip content={s("checkAgainTooltip")}>
          <Button size="sm" variant="ghost" iconStart={RefreshIcon} busy={loading} disabled={checkingAny} onClick={() => void checkAgain()}>{s("checkAgain")}</Button>
        </Tooltip>
      </div>
    </section>
    {pendingBanner}
    {outcomes}
    <PersonDefaultHarnessSection host={host} rows={rows} state={personDefault} />
    <Section title={s("harnesses")} hint={s("harnessesHint")}
      action={canManage && ordered.length > 1
        ? <Button size="sm" variant="ghost" className="pkg-harnesses-reorder-toggle" aria-pressed={reordering} onClick={() => setReordering((value) => !value)}>{reordering ? t("action.done") : s("reorder")}</Button>
        : undefined}>
    {failure && <Notice tone="error" role="alert">{failure}</Notice>}
    {!canManage && <Notice>{s("manageOwnerOnly")}</Notice>}
    {error && rows.length === 0 ? <ErrorState compact title={s("checkFailed")} error={error} onRetry={() => void checkAgain()} />
      : error ? <Notice tone="error" role="alert">{error}</Notice> : null}
    {loading && rows.length === 0 && <EmptyState compact busy title={s("checking")} />}
    {!loading && rows.length === 0 && !error && <EmptyState compact icon="cpu" title={s("none.title")} body={s("none.body")} />}
    {!loading && !checkingAny && rows.length > 0 && !rows.some(canExecute) && <Notice>{s("turnOnNotice")}</Notice>}
    <div className="pkg-harnesses-list" data-reordering={reordering ? "true" : undefined}>
      {ordered.map((row, index) => {
        const checking = readiness.checking.has(row.identity.id);
        const install = installStatus(row);
        const pendingChanges = pendingLabel(row);
        const update = updates.statuses.get(row.identity.id);
        const run = updates.runs.get(row.identity.id);
        const step = row.policy.enabled ? setupStep(row) : { kind: "none" as const };
        const setupAction = step.kind === "install" || step.kind === "sign-in" || step.kind === "guide" ? stepAction(row) : null;
        const targetVersion = displayVersion(update?.latest);
        // Narrow rows have no room for "0.85.1 → 1.2.0" beside the route, so
        // the target moves into the button there.
        const action = setupAction
          ?? (installableUpdate(update) || run?.state === "running"
            ? <Button size="sm" variant="quiet" iconStart={DownloadIcon} busy={run?.state === "running"} aria-label={targetVersion ? s("updateToAria", { name: row.identity.name, version: targetVersion }) : s("updateAria", { name: row.identity.name })} onClick={() => startUpdate(row)}>
              {run?.state === "running" ? s("updating") : updateLabel(targetVersion)}
            </Button>
            : null);
        return <article className={`pkg-harnesses-row${dragged === row.identity.id ? " dragging" : ""}`} data-enabled={row.policy.enabled} data-tone={statusTone(row)} data-checking={checking ? "true" : undefined} key={row.identity.id} onClick={(event) => { if (!reordering && !(event.target as HTMLElement).closest("button, a, input, label, [role=switch]")) openDetail(row.identity.id); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/plain") || dragged; if (id) move(id, index); setDragged(undefined); }}>
          <span className="pkg-harnesses-drag" aria-hidden="true" title={canManage ? s("dragToReorder") : undefined} data-locked={canManage ? undefined : "true"} draggable={!locked} onDragStart={(event: DragEvent<HTMLElement>) => { setDragged(row.identity.id); event.dataTransfer.setData("text/plain", row.identity.id); }} onDragEnd={() => setDragged(undefined)}><Icon icon={DragHandleIcon} size="sm" /></span>
          <button type="button" className="pkg-harnesses-row-main" aria-label={s("settingsOf", { name: harnessProfileName(row.identity) })} onClick={() => { if (!reordering) openDetail(row.identity.id); }}>
            <span className="pkg-harnesses-logo-tile" data-tinted={row.identity.color || row.identity.accountLabel ? "true" : undefined} style={tint(row.identity)}><ProviderLogo providerID={row.identity.id} providerName={row.identity.defaultName ?? row.identity.name} size="regular" /></span>
            <span className="pkg-harnesses-row-copy">
              <strong>{harnessProfileName(row.identity)}</strong>
              <small className="pkg-harnesses-row-meta">
                {install
                  ? <span className="pkg-harnesses-status" data-state={install.failed ? "install-failed" : "installing"} data-checking={install.busy ? "true" : undefined}>{install.busy && <Spinner size="sm" />}{install.label}</span>
                  : <span className="pkg-harnesses-status" data-state={row.availability.state} data-checking={checking ? "true" : undefined}>{checking && <Spinner size="sm" />}{availabilityLabel(row, { checking })}</span>}
                <span className="pkg-harnesses-route" data-route={!row.policy.enabled ? "off" : row.policy.autoSelect ? "auto" : "manual"}>{routingLabel(row, rows)}</span>
                <VersionText t={s} row={row} {...(update ? { update } : {})} />
                {pendingChanges ? <span>{pendingChanges}</span> : null}
              </small>
            </span>
          </button>
          <span className="pkg-harnesses-reorder">{canManage && <MoveControls label={row.identity.name} index={index} count={ordered.length} onMove={(next) => move(row.identity.id, next)} />}</span>
          <span className="pkg-harnesses-row-side">{action}</span>
          <div className="pkg-harnesses-row-toggle"><Switch label={s("allowFor", { name: row.identity.name })} checked={row.policy.enabled} disabled={locked} onChange={(enabled) => toggle(row.identity.id, enabled)} /></div>
          <span className="pkg-harnesses-row-chevron" aria-hidden="true"><Icon icon={ChevronRightIcon} size="sm" /></span>
        </article>;
      })}
    </div>
    <p className="pkg-harnesses-help">{s("listHelp")}</p>
    </Section>
    {dialogs}
  </div>;
}

/** Tab strips scroll sideways on narrow screens; the edges fade only where
 *  more tabs hide, and the selected tab is kept in view. */
function useTabStripOverflow(activeSection: string) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const strip = ref.current?.querySelector<HTMLElement>("[role=tablist]");
    const host = ref.current;
    if (!strip || !host) return;
    const update = () => {
      const max = strip.scrollWidth - strip.clientWidth;
      const start = Math.abs(strip.scrollLeft);
      host.dataset.overflowStart = start > 1 ? "true" : "false";
      host.dataset.overflowEnd = max - start > 1 ? "true" : "false";
    };
    const selected = strip.querySelector<HTMLElement>("[aria-selected=true]");
    if (selected && strip.scrollWidth > strip.clientWidth) {
      const left = selected.offsetLeft - strip.offsetLeft;
      const right = left + selected.offsetWidth;
      if (left < strip.scrollLeft) strip.scrollLeft = Math.max(0, left - 24);
      else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth + 24;
    }
    update();
    strip.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(strip);
    return () => {
      strip.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [activeSection]);
  return ref;
}

function HarnessDetail({
  host, t, detail, rows, projectId, loading, checking, error, failure, canManage, locked, target, tabsId, contributed, pendingSection,
  activeSection, update, updateRun, onUpdate, onSection, onBack, onRefresh, onToggle, onExplain, stepAction, installStatus, banner, dialogs,
}: {
  host: WebPackageHost;
  t: SettingsTranslate;
  detail: HarnessSnapshot;
  rows: HarnessSnapshot[];
  projectId: string | null;
  loading: boolean;
  checking: boolean;
  error: string;
  failure: string;
  canManage: boolean;
  locked: boolean;
  target: string;
  tabsId: string;
  contributed: Array<{ id: string; label: string; handlesPendingChanges?: boolean }>;
  pendingSection?: { id: string };
  activeSection: string;
  update?: HarnessUpdateStatus;
  updateRun?: HarnessUpdateRun;
  onUpdate: () => void;
  onSection: (id: string) => void;
  onBack: () => void;
  onRefresh: () => void;
  onToggle: (enabled: boolean) => void;
  onExplain: (fact: CapabilityFact) => void;
  stepAction: (row: HarnessSnapshot, options?: { quiet?: boolean }) => ReactNode;
  installStatus?: { label: string; busy: boolean; failed: boolean };
  banner: ReactNode;
  dialogs: ReactNode;
}) {
  const account = useHarnessAccountStatus(detail.identity.accounts?.endpoint, detail.identity.id, detail.availability.checkedAt);
  const strip = useTabStripOverflow(activeSection);
  const controls = detail.configuration?.controls?.filter((control) => control.placement === "harness-overview" || control.placement === "harness-settings") ?? [];
  const features = [...runtimeFacts(detail), ...attachmentFacts(detail)];
  const supported = features.filter((fact) => !fact.unsupported && fact.value !== "Not verified").length;
  const position = autoCandidates(rows).findIndex((candidate) => candidate.identity.id === detail.identity.id) + 1;
  const autoState = !detail.policy.autoSelect ? t("auto.pickInPicker")
    : !detail.policy.enabled ? t("auto.off")
      : t(canExecute(detail) ? "auto.yes" : "auto.yesNotReady", { position });
  const accountPlan = account?.loggedIn === true && account.plan ? host.ui.locale.translate("harnessruntime.accounts.plan", { plan: `${account.plan.charAt(0).toUpperCase()}${account.plan.slice(1)}` }) : "";
  const accountLine = account?.loggedIn === true
    ? account.email || accountPlan || host.ui.locale.translate("harnessruntime.accounts.state.signedIn")
    : account?.loggedIn === false ? host.ui.locale.translate("harnessruntime.accounts.state.signedOut") : undefined;
  const pending = pendingLabel(detail);
  const step = setupStep(detail);
  const needsSetup = step.kind === "install" || step.kind === "sign-in" || step.kind === "guide";
  const running = updateRun?.state === "running";
  const modelSection = contributed.find((section) => section.id === "models" || section.id === "providers-models");
  const models = detail.catalog?.models;
  // The same rows the model picker offers, and how many this account hid.
  const modelPrefs = useModelPrefs();
  const pickerModels = useMemo(() => pickerCatalogModels(models ?? [], detail.identity.id), [models, detail.identity.id]);
  const hiddenModels = useMemo(() => {
    const isHidden = hiddenModelMatcher(modelPrefs);
    return pickerModels.filter((model) => isHidden(model, detail.identity.id)).length;
  }, [pickerModels, modelPrefs, detail.identity.id]);
  const explain = (fact: CapabilityFact, showLabel = true) => <Tooltip key={fact.id} content={fact.description}><button type="button" className="pkg-harnesses-chip" aria-label={t("factAria", { label: fact.label, value: fact.value, description: fact.description })} onClick={() => onExplain(fact)}>{showLabel ? `${fact.label} · ` : ""}{fact.value}</button></Tooltip>;
  /** A fact list. A note every supported fact shares moves into the hint, so
   *  the rows carry only what differs. */
  const matrix = (title: string, facts: CapabilityFact[], hint?: string) => {
    const notes = new Set(facts.flatMap((fact) => fact.application ? [fact.application] : []));
    const shared = notes.size === 1 && facts.every((fact) => fact.application || fact.unsupported || fact.value === "Not verified") ? [...notes][0] : undefined;
    const fullHint = [hint, shared ? `${shared}.` : ""].filter(Boolean).join(" ");
    return <Section title={title} {...(fullHint ? { hint: fullHint } : {})}><div className="pkg-harnesses-facts">{facts.map((fact) => <div className="pkg-harnesses-fact" key={fact.id} data-support={fact.unsupported ? "no" : fact.value === "Not verified" ? "unknown" : "yes"}><span>{fact.label}</span><span className="pkg-harnesses-fact-value">{explain(fact, false)}{fact.application && !shared && <small>{fact.application}</small>}</span></div>)}</div></Section>;
  };
  return <div className="pkg-harnesses pkg-harnesses-settings pkg-harnesses-detail" aria-busy={loading || checking}>
    <div className="pkg-harnesses-settings-actions"><Button size="sm" variant="ghost" iconStart={BackIcon} onClick={onBack}>{t("harnesses")}</Button></div>
    <header className="pkg-harnesses-hero" data-tone={statusTone(detail)}>
      <span className="pkg-harnesses-logo-tile pkg-harnesses-logo-tile--lg" data-tinted={detail.identity.color || detail.identity.accountLabel ? "true" : undefined} style={tint(detail.identity)}><ProviderLogo providerID={detail.identity.id} providerName={detail.identity.defaultName ?? detail.identity.name} size="regular" /></span>
      <div className="pkg-harnesses-hero-text">
        <h2>{detail.identity.name}</h2>
        {detail.identity.defaultName && <p className="pkg-harnesses-hero-default">{detail.identity.defaultName}</p>}
        <p className="pkg-harnesses-hero-meta">
          {installStatus
            ? <span className="pkg-harnesses-status" data-state={installStatus.failed ? "install-failed" : "installing"} data-checking={installStatus.busy ? "true" : undefined}>{installStatus.busy && <Spinner size="sm" />}{installStatus.label}</span>
            : <span className="pkg-harnesses-status" data-state={detail.availability.state} data-checking={checking ? "true" : undefined}>{checking && <Spinner size="sm" />}{availabilityLabel(detail, { checking })}</span>}
          <VersionText t={t} row={detail} {...(update ? { update } : {})} />
          <span>{detail.identity.integration}</span>
        </p>
        {accountLine && <p className="pkg-harnesses-hero-account" data-signed-in={account?.loggedIn === true ? "true" : "false"} title={[accountLine, account?.email ? accountPlan : ""].filter(Boolean).join(" · ")}>
          <Icon icon={SessionIcon} size="sm" /><span>{accountLine}</span>{account?.email && accountPlan && <span className="pkg-harnesses-hero-account-plan">{accountPlan}</span>}
        </p>}
        {update?.available && !update.canUpdate && update.latest && <p className="pkg-harnesses-hero-message">{t(update.reason === "remote" ? "versionAvailableRemote" : "versionAvailableOwner", { version: displayVersion(update.latest) ?? "" })}</p>}
        {detail.message && detail.availability.state !== "ready" && !checking && <p className="pkg-harnesses-hero-message">{detail.message}</p>}
      </div>
      <div className="pkg-harnesses-hero-actions">
        {(needsSetup || installableUpdate(update) || running) && <div className="pkg-harnesses-hero-primary">
          {needsSetup ? stepAction(detail)
            : <Button size="sm" variant="primary" iconStart={DownloadIcon} busy={running} onClick={onUpdate}>{running ? t("updatingEllipsis") : displayVersion(update?.latest) ? t("updateTo", { version: displayVersion(update?.latest) ?? "" }) : t("updateToLatest")}</Button>}
        </div>}
        <div className="pkg-harnesses-hero-tools">
          {step.kind === "sign-in-again" && stepAction(detail)}
          <IconButton icon={RefreshIcon} label={t("checkAgain")} busy={loading || checking} onClick={onRefresh} />
        </div>
      </div>
    </header>
    {banner}
    {(error || failure) && <Notice tone="error" role="alert">{failure || error}</Notice>}
    {pending && <Notice actions={pendingSection && <Button size="sm" onClick={() => onSection(pendingSection.id)}>{t("reviewChanges")}</Button>}>{pending}</Notice>}
    {detail.stale && (detail.availability.state === "offline" || detail.availability.state === "degraded") && <Notice tone="warning">{t("staleNotice")}</Notice>}
    <div className="pkg-harnesses-tabstrip" ref={strip}>
      <Tabs className="pkg-harnesses-tabs" tabs={[{ id: "overview", label: t("overview") }, ...contributed]} value={activeSection} onChange={onSection} label={t("settingsOf", { name: detail.identity.name })} size="sm" idBase={tabsId} />
    </div>
    <TabPanel idBase={tabsId} tabId={activeSection} active className="pkg-harnesses-tabpanel">
    {activeSection === "overview" ? <div className="pkg-harnesses-overview">
      <Section title={t("use.title")} hint={t("use.hint", { name: detail.identity.name })}>
        <Row label={t("use.available")} hint={canManage ? t("use.availableHint") : t("ownerOnly")}>
          <Switch label={t("allowFor", { name: detail.identity.name })} checked={detail.policy.enabled} disabled={locked} onChange={onToggle} />
        </Row>
        <ReadonlyRow label={t("use.chosenAuto")} value={autoState} />
        <ReadonlyRow label={t("use.runsOn")} value={target} />
        <HarnessPrivateSessions host={host} detail={detail} canManage={canManage} />
      </Section>
      <HarnessAppearance host={host} detail={detail} canManage={canManage} />
      {controls.length > 0 && <Section title={t("features.title")} hint={t("features.hint")}>
        <div className="pkg-harnesses-configuration">
          {controls.map((control) => <GenericControl t={t} key={control.id} control={control} harnessId={detail.identity.id} projectId={projectId ?? undefined} refresh={async () => onRefresh()} />)}
        </div>
      </Section>}
      {detail.catalog && <Section title={t("models.title")} hint={t("models.hint")}
        {...(modelSection ? { action: <Button size="sm" variant="ghost" onClick={() => onSection(modelSection.id)}>{t("models.manage")}</Button> } : {})}>
        <ReadonlyRow label={t("models.shown")} value={!models ? t("notReported")
          : t(`models.shownCount.${pickerModels.length === 1 ? "one" : "other"}`, { shown: pickerModels.length - hiddenModels, total: pickerModels.length })} />
        {detail.catalog.providers && <ReadonlyRow label={t("models.providers")} value={detail.catalog.providers.map((provider) => provider.name).join(", ") || t("models.noneConfigured")} />}
        {detail.catalog.modes && <ReadonlyRow label={t("models.modes")} value={detail.catalog.modes.join(", ") || t("models.noneReported")} />}
      </Section>}
      {matrix(t("provides.title"), projectionFacts(detail), t(detail.capabilitySupport?.targetLifetime === "physical-runtime" ? "provides.hintShared" : "provides.hint"))}
      <details className="pkg-harnesses-disclosure">
        <summary><span>{t("support.title")}</span><small>{t("support.count", { supported, total: features.length })}</small></summary>
        <div className="pkg-harnesses-disclosure-body">
          {matrix(t("support.conversation"), runtimeFacts(detail))}
          {detail.capabilities?.commands && matrix(t("support.commands"), [{ id: "discovery", label: t("support.discovery"), value: supportLabel(detail.capabilities.commands.discovery), description: t("support.discoveryDescription"), unsupported: detail.capabilities.commands.discovery === "unsupported" }, { id: "invocation", label: t("support.invocation"), value: detail.capabilities.commands.invoke === "raw-native-input" ? t("support.nativeInput") : t("support.unsupported"), description: t("support.invocationDescription"), unsupported: detail.capabilities.commands.invoke !== "raw-native-input" }])}
          {matrix(t("support.attachments"), attachmentFacts(detail))}
          <p className="pkg-harnesses-help">{t("support.help")}</p>
        </div>
      </details>
      <details className="pkg-harnesses-disclosure pkg-harnesses-diagnostics"><summary><span>{t("diag.title")}</span></summary><div className="pkg-harnesses-disclosure-body"><dl><dt>{t("diag.version")}</dt><dd>{detail.identity.version ?? t("notReported")}</dd><dt>{t("diag.protocol")}</dt><dd>{detail.identity.integration}</dd><dt>{t("diag.integration")}</dt><dd>{integrationLabel(detail)}</dd><dt>{t("diag.target")}</dt><dd>{target}</dd><dt>{t("diag.lastChecked")}</dt><dd>{new Date(detail.availability.checkedAt).toLocaleString(host.ui.locale.get())}</dd></dl>{detail.message && <p>{detail.message}</p>}</div></details>
    </div> : <host.ui.Slot key={`${detail.identity.id}:${activeSection}`} slot="settings.harness.detail" context={{ harnessId: detail.identity.id, sectionId: activeSection, snapshot: detail, projectId, update, updateRun, onUpdate, canManage }} />}
    </TabPanel>
    {dialogs}
  </div>;
}
