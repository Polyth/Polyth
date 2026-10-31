import { useEffect, useId, useRef, useState } from "react";
import { createApiTransport } from "@polyth/web-sdk";
import { Badge, Button, ExternalLinkIcon, Icon, KeyIcon, RefreshIcon, Select, Switch, Tooltip, type BadgeTone } from "@polyth/web/ui";
import { EmptyState, ErrorState, PageHead, ReadonlyRow, Row, Section, Seg, settingsErrorText } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import ModelPicker from "@polyth/models/model-picker";
import type { JudgmentConfig } from "../src/types.ts";
import type { JudgmentCheckResult, JudgmentProviderOption, JudgmentProviderStatus, JudgmentSettingsSnapshot } from "../src/settings.ts";
import { resolveTarget } from "../src/config.ts";
import JudgmentUses, { type UseCommit } from "./JudgmentUses.tsx";

const api = createApiTransport();
const statusLabel = (status: JudgmentProviderStatus): string => status === "available" ? tr("judgment.status.readyBadge")
  : status === "authentication-required" ? tr("judgment.status.notConnected")
    : status === "unsupported" ? tr("judgment.status.unsupported")
      : tr("judgment.settings.unavailable");
const checkFailure = (reason: string | undefined): string => {
  switch (reason) {
    case "disabled": return tr("judgment.check.disabled");
    case "engine-unavailable": return tr("judgment.check.engineUnavailable");
    case "provider-unavailable": return tr("judgment.check.providerUnavailable");
    case "model-unavailable": return tr("judgment.check.modelUnavailable");
    case "provider-error": return tr("judgment.check.providerError");
    case "timeout": return tr("judgment.check.timeout");
    case "invalid-response": return tr("judgment.check.invalidResponse");
    case "invalid-request": return tr("judgment.check.invalidRequest");
    case "budget-exhausted": return tr("judgment.check.budgetExhausted");
    case "cancelled": return tr("judgment.check.cancelled");
    default: return tr("judgment.settings.checkFailed");
  }
};
const keyless = (option: JudgmentProviderOption) => option.credential === "none";
const selectable = (option: JudgmentProviderOption) => option.status === "available" || option.status === "authentication-required";

export default function JudgmentSettings({ projectId, openVault }: { projectId: string | null; openVault: () => void }) {
  const [snapshot, setSnapshot] = useState<JudgmentSettingsSnapshot>();
  const [level, setLevel] = useState<"global" | "project">("global");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [check, setCheck] = useState<JudgmentCheckResult>();
  const [checking, setChecking] = useState(false);
  /** The route whose credential panel is open; `null` once the user has closed the automatic one. */
  const [expanded, setExpanded] = useState<string | null>();
  const epoch = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const snapshotRef = useRef<JudgmentSettingsSnapshot | undefined>(undefined);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const radioName = useId();
  const query = `?projectId=${encodeURIComponent(projectId ?? "")}`;
  useEffect(() => {
    const generation = ++epoch.current, controller = new AbortController();
    setSnapshot(undefined); setError(""); setBusy(false); setCheck(undefined);
    if (projectId) void api.get<JudgmentSettingsSnapshot>(`/api/judgment/settings${query}`, { signal: controller.signal })
      .then((value) => { if (epoch.current === generation) setSnapshot(value); })
      .catch(() => { if (epoch.current === generation && !controller.signal.aborted) setError(tr("judgment.settings.loadFailed")); });
    return () => { epoch.current++; controller.abort(); pending.current?.abort(); pending.current = null; };
  }, [projectId, reload]);

  const request = async <T,>(path: string, body: unknown, method: "put" | "post", apply: (value: T) => void, failure: string) => {
    if (pending.current) return;
    const generation = epoch.current, controller = new AbortController();
    pending.current = controller;
    setBusy(true); setError("");
    try {
      const next = await api[method]<T>(`${path}${query}`, body, { signal: controller.signal });
      if (epoch.current === generation) apply(next);
    } catch {
      if (epoch.current === generation && !controller.signal.aborted) setError(failure);
    } finally {
      if (epoch.current === generation) { pending.current = null; setBusy(false); }
    }
  };
  const mutate = (path: string, body: unknown, method: "put" | "post" = "put") => request<JudgmentSettingsSnapshot>(path, body, method,
    (next) => { setSnapshot(next); setCheck(undefined); }, tr("judgment.settings.applyFailed"));
  const runCheck = async () => {
    setCheck(undefined); setChecking(true);
    try { await request<JudgmentCheckResult>("/api/judgment/check", {}, "post", setCheck, tr("judgment.settings.checkRunFailed")); }
    finally { setChecking(false); }
  };
  snapshotRef.current = snapshot;
  /** Use edits queue behind each other and any other save, and always write against the newest revision. */
  const commitUses = (at: "global" | "project", edit: (config: Partial<JudgmentConfig>) => Partial<JudgmentConfig>): Promise<UseCommit> => {
    const generation = epoch.current;
    const run = async (): Promise<UseCommit> => {
      while (pending.current) await new Promise((resolve) => setTimeout(resolve, 20));
      const current = snapshotRef.current;
      if (epoch.current !== generation || !current) return { ok: false, message: "" };
      const controller = new AbortController();
      pending.current = controller;
      setBusy(true);
      try {
        const next = await api.put<JudgmentSettingsSnapshot>(`/api/judgment/settings${query}`,
          { level: at, revision: current.revision, config: edit(at === "global" ? current.global : current.project ?? {}) }, { signal: controller.signal });
        if (epoch.current === generation) { snapshotRef.current = next; setSnapshot(next); setCheck(undefined); }
        return { ok: true };
      } catch (failure) {
        return { ok: false, message: epoch.current === generation ? settingsErrorText(failure).message : "" };
      } finally {
        if (epoch.current === generation) { pending.current = null; setBusy(false); }
      }
    };
    const result = chain.current.then(run, run);
    chain.current = result;
    return result;
  };
  const blurb = <PageHead blurb={tr("judgment.settings.pageBlurb")} />;
  if (!projectId) return <div className="judgment-settings">{blurb}<EmptyState icon="circle-check" title={tr("judgment.settings.openProject")} /></div>;
  if (!snapshot) return <div className="judgment-settings">{blurb}
    {error ? <ErrorState title={tr("judgment.settings.loadTitle")} error={error} onRetry={() => setReload((value) => value + 1)} />
      : <EmptyState busy compact title={tr("judgment.settings.loading")} />}</div>;

  const config = level === "global" ? snapshot.global : snapshot.project ?? {};
  const { engineId: _engine, ...engineDefaults } = snapshot.defaultTarget ?? {};
  const target = resolveTarget({ defaults: { engineId: (snapshot.engines.find((entry) => entry.recommended) ?? snapshot.engines[0])?.id },
    global: snapshot.global, project: level === "project" ? snapshot.project : undefined, scope: "settings.preview.v1",
    engineDefaults, defaultModels: snapshot.defaultModels });
  const routes = snapshot.providers;
  const provider = routes.find((entry) => entry.provider.id === target.providerId);
  const engine = snapshot.engines.find((entry) => entry.id === snapshot.engineId);
  const models = provider?.models ?? [];
  // Engines that predate per-provider credentials report one handle for their default provider.
  const legacyHandle = snapshot.engineSettings?.secretHandle, primary = snapshot.defaultTarget?.providerId;
  const credentials = snapshot.engineSettings?.credentials ?? (legacyHandle && primary ? { [primary]: legacyHandle } : {});
  const handles = snapshot.engineSettings?.handles ?? [];
  const automaticRoutes = routes.filter((entry) => entry.automatic);
  const save = (next: Partial<JudgmentConfig>) => void mutate("/api/judgment/settings", { level, revision: snapshot.revision, config: next });
  const setProvider = (providerId: string) => {
    const { providerId: _provider, modelId: _model, ...rest } = config;
    setExpanded(undefined);
    save({ ...rest, ...(providerId ? { providerId } : {}) });
  };
  const setEngine = (engineId: string) => {
    const { engineId: _engine, providerId: _provider, modelId: _model, ...rest } = config;
    setExpanded(undefined);
    save({ ...rest, ...(engineId ? { engineId } : {}) });
  };
  const enabled = config.enabled ?? snapshot.global.enabled;
  const modelMissing = !!config.modelId && !models.some((model) => model.modelID === config.modelId);
  const ready = !!provider && provider.status === "available" && !!target.modelId && !modelMissing;
  const modelName = (id?: string) => models.find((model) => model.modelID === id)?.name ?? id;

  const status: { tone: BadgeTone; badge: string; title: string; detail: string } = !enabled
    ? { tone: "neutral", badge: tr("judgment.status.offBadge"), title: tr("judgment.status.offTitle"), detail: tr("judgment.status.offDetail") }
    : !engine || !provider ? { tone: "danger", badge: tr("judgment.settings.unavailable"), title: tr("judgment.status.noEngineTitle"), detail: tr("judgment.status.noEngineDetail") }
      : provider.status !== "available" ? { tone: "warning", badge: tr("judgment.status.needsSetupBadge"),
        title: config.providerId ? tr("judgment.status.connectProvider", { provider: provider.provider.name }) : tr("judgment.status.connectRoute"),
        detail: config.providerId ? tr("judgment.status.chooseKey", { provider: provider.provider.name })
          : tr("judgment.status.automaticNoRoute") }
        : modelMissing ? { tone: "warning", badge: tr("judgment.status.modelUnavailableBadge"), title: tr("judgment.status.modelNotOffered", { model: config.modelId ?? "" }),
          detail: tr("judgment.status.modelUnavailableDetail") }
          : { tone: "success", badge: tr("judgment.status.readyBadge"), title: provider.provider.name,
            detail: [modelName(target.modelId), provider.local ? tr("judgment.status.runsOnServer") : provider.harness ? tr("judgment.status.harnessAccount") : provider.endpoint, config.providerId ? undefined : tr("judgment.status.chosenAutomatically")].filter(Boolean).join(" · ") };
  const checkProvider = routes.find((entry) => entry.provider.id === check?.providerId)?.provider.name;

  const route = (option: JudgmentProviderOption | undefined) => {
    const id = option?.provider.id ?? "";
    const selected = (config.providerId ?? "") === id;
    const effective = target.providerId === id;
    const needsKey = !!option && !keyless(option) && selectable(option);
    const open = needsKey && (expanded === id || (expanded === undefined && enabled && effective && option.status !== "available"));
    const panel = `${radioName}-${id || "automatic"}-credential`;
    const description = option ? option.description ?? option.endpoint
      : automaticRoutes.length ? tr("judgment.route.firstConnected", { routes: automaticRoutes.map((entry) => entry.provider.name).join(", ") })
        : tr("judgment.route.recommended");
    const using = routes.find((entry) => entry.provider.id === primary && entry.status === "available");
    const badge: [BadgeTone, string] | undefined = !option ? (using ? ["success", tr("judgment.route.using", { provider: using.provider.name })] : ["warning", tr("judgment.route.nothingConnected")])
      : option.status === "available" ? (option.local ? ["info", tr("judgment.route.local")] : option.harness ? ["info", tr("judgment.route.yourAccount")] : keyless(option) ? ["info", tr("judgment.route.free")] : ["success", tr("judgment.route.connected")])
        // A route that only needs a key offers Connect instead of a second "not connected" label.
        : option.status === "authentication-required" && needsKey ? undefined
          : [option.status === "authentication-required" ? "neutral" : "danger", statusLabel(option.status)];
    const connected = !!option && option.status === "available";
    return <div key={id || "automatic"} className="judgment-route" data-selected={selected || undefined} data-disabled={(option && !selectable(option)) || undefined}>
      <label className="judgment-route-main">
        <input type="radio" name={radioName} checked={selected} disabled={busy || !engine || (!!option && !selectable(option))}
          onChange={() => setProvider(id)} />
        <span className="judgment-route-text">
          <span className="judgment-route-name">{option?.provider.name ?? tr("judgment.settings.automatic")}</span>
          {description && <span className="judgment-route-description">{description}</span>}
        </span>
      </label>
      <span className="judgment-route-aside">
        {badge && <Badge tone={badge[0]} dot>{badge[1]}</Badge>}
        {needsKey && <Button size="sm" variant={connected || open ? "ghost" : "quiet"} disabled={busy} aria-expanded={open} aria-controls={panel}
          aria-label={credentials[id] ? tr("judgment.route.changeKeyFor", { provider: option.provider.name }) : tr("judgment.route.connectProvider", { provider: option.provider.name })}
          onClick={() => setExpanded(open ? null : id)}>{credentials[id] ? tr("judgment.route.changeKey") : tr("judgment.route.connect")}</Button>}
      </span>
      {open && option && <div className="judgment-route-detail" id={panel}>
        <Select label={tr("judgment.route.credentialLabel", { provider: option.provider.name })} ariaLabel={tr("judgment.route.credentialLabel", { provider: option.provider.name })} disabled={busy}
          value={credentials[id] ?? ""} placeholder={tr("judgment.route.chooseVaultKey")}
          options={[{ value: "", label: tr("judgment.status.notConnected") }, ...handles.map((entry) => ({ value: entry.handle, label: entry.label }))]}
          onChange={(value) => void mutate("/api/judgment/credential", { providerId: id, ...(value ? { secretHandle: value } : {}) })} />
        <Button size="sm" iconStart={KeyIcon} onClick={openVault}>{tr("judgment.route.addKey")}</Button>
        {option.provider.docs && <a className="judgment-link" href={option.provider.docs} target="_blank" rel="noreferrer noopener">
          {tr("judgment.route.getKey", { provider: option.provider.name })}<Icon icon={ExternalLinkIcon} size="sm" /></a>}
        <p className="judgment-route-note">{handles.length ? "" : `${tr("judgment.route.noKeys")} `}
          {tr("judgment.route.keyStays", { endpoint: option.endpoint ?? option.provider.name })}</p>
      </div>}
      {option && keyless(option) && !option.local && !option.harness && selected && <div className="judgment-route-detail"><p className="judgment-route-note">
        {tr("judgment.route.keylessNote", { endpoint: option.endpoint ?? option.provider.name })}</p></div>}
    </div>;
  };

  return <div className="judgment-settings" aria-busy={busy}>
    {blurb}
    <Row label={tr("judgment.settings.settingsFor")} hint={level === "global" ? tr("judgment.settings.settingsForGlobalHint") : tr("judgment.settings.settingsForProjectHint")}>
      <Seg<typeof level> label={tr("judgment.settings.settingsFor")} value={level} disabled={busy} options={[["global", tr("judgment.settings.allProjects")], ["project", tr("judgment.settings.thisProject")]]}
        onChange={(value) => { setLevel(value); setExpanded(undefined); }} />
    </Row>
    {error && <ErrorState compact title={tr("judgment.settings.somethingWrong")} error={error} onRetry={() => setReload((value) => value + 1)} />}

    <section className="judgment-status" data-tone={status.tone} data-settings-item="judgment.enabled" aria-label={tr("judgment.settings.statusAria")}>
      <div className="judgment-status-toggle">
        <span className="judgment-status-text">
          <strong id={`${radioName}-enabled`}>{tr("judgment.settings.useJudgment")}</strong>
          <span>{tr("judgment.settings.useJudgmentHint")}</span>
        </span>
        <Switch labelledBy={`${radioName}-enabled`} checked={enabled} disabled={busy} onChange={(value) => save({ ...config, enabled: value })} />
      </div>
      {enabled && <div className="judgment-status-main">
        <span className="judgment-status-text">
          <span className="judgment-status-title"><Badge tone={status.tone} dot>{status.badge}</Badge><strong>{status.title}</strong></span>
          <span>{status.detail}</span>
        </span>
        <Tooltip content={tr("judgment.settings.testHint")}><Button size="sm" disabled={!ready || (busy && !checking)} busy={checking} onClick={() => void runCheck()}>{tr("judgment.settings.testConnection")}</Button></Tooltip>
      </div>}
      {check && <p className="judgment-status-check" role={check.ok ? "status" : "alert"} data-ok={check.ok}>
        {check.ok ? (checkProvider
          ? tr("judgment.settings.answeredVia", { duration: check.durationMs, model: check.modelId ?? "Judgment", provider: checkProvider })
          : tr("judgment.settings.answered", { duration: check.durationMs, model: check.modelId ?? "Judgment" }))
          : checkFailure(check.reason)}</p>}
    </section>

    <JudgmentUses uses={snapshot.uses ?? []} level={level} config={config} global={snapshot.global} judgmentOn={enabled} routes={routes}
      {...(target.modelId ? { automaticModel: modelName(target.modelId) ?? target.modelId } : {})} localRoute={!!provider?.local} commit={commitUses} />

    <Section itemId="judgment.provider" title={tr("judgment.settings.routeTitle")} hint={tr("judgment.settings.routeHint")}>
      <div className="judgment-routes" role="radiogroup" aria-label={tr("judgment.settings.routeAria")} data-settings-item="judgment.credential">
        {route(undefined)}
        {routes.map(route)}
      </div>
    </Section>

    <Section itemId="judgment.model" title={tr("judgment.settings.modelTitle")} hint={provider?.status !== "available"
        ? tr("judgment.settings.modelConnectHint")
        : config.modelId ? modelName(config.modelId) : `${tr("judgment.settings.automatic")}${target.modelId ? ` · ${modelName(target.modelId)}` : ""}`}
      {...(config.modelId ? { action: <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
        const { modelId: _model, ...rest } = config;
        save(rest);
      }}>{tr("judgment.settings.useAutomaticModel")}</Button> } : {})}>
      {provider?.status === "available" && (provider.discovery || models.length > 1) && <div className="judgment-model">
        <fieldset disabled={busy || provider?.status !== "available"} aria-label={tr("judgment.settings.modelAria")}>
          <ModelPicker models={models} value={config.modelId && target.providerId ? { providerID: target.providerId, modelID: config.modelId } : undefined}
            recommended={target.providerId && target.modelId ? { providerID: target.providerId, modelID: target.modelId } : undefined}
            onPick={(model) => { const { modelId: _model, ...rest } = config; save({ ...rest, ...(model ? { providerId: model.providerID, modelId: model.modelID } : {}) }); }} />
        </fieldset>
        {provider?.discovery && <Button size="sm" variant="ghost" iconStart={RefreshIcon} disabled={busy || provider.status !== "available"}
          onClick={() => void mutate("/api/judgment/models/refresh", { providerId: provider.provider.id }, "post")}>{tr("judgment.settings.refreshModels")}</Button>}
      </div>}
    </Section>

    <Section title={tr("judgment.settings.privacyTitle")} hint={tr("judgment.settings.privacyHint")}
      {...(level === "project" ? { action: <Button size="sm" variant="ghost" disabled={busy || !snapshot.project} onClick={() => save({})}>{tr("judgment.settings.useAllProjectsSettings")}</Button> } : {})}>
      {snapshot.engines.length > 1
        ? <Row itemId="judgment.engine" label={tr("judgment.settings.engineTitle")} hint={tr("judgment.settings.engineHint")}>
          <Select label={tr("judgment.settings.engineAria")} ariaLabel={tr("judgment.settings.engineAria")} disabled={busy} value={config.engineId ?? ""} onChange={setEngine}
            options={[{ value: "", label: tr("judgment.settings.automatic") }, ...snapshot.engines.map((entry) => ({ value: entry.id, label: entry.name }))]} />
        </Row>
        : <ReadonlyRow itemId="judgment.engine" label={tr("judgment.settings.engineTitle")} hint={tr("judgment.settings.engineReadonlyHint")} value={engine?.name ?? tr("judgment.settings.unavailable")} />}
    </Section>
  </div>;
}
