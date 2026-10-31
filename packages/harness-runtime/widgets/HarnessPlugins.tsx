import { useCallback, useEffect, useState } from "react";
import type { HarnessSnapshot, OpenCodePluginPreviewDto } from "@polyth/contracts";
import type {
  NativePluginAction,
  NativePluginDto,
  NativePluginListDto,
  NativePluginMutationResponseDto,
  NativePluginScope,
} from "@polyth/contracts/capability-installations";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { Badge, Button, Notice, Select, Switch, Textarea, TextInput, Tooltip } from "../../../apps/web/src/components/ui/index.ts";
import { EmptyState, ErrorState, FormField, ReadonlyRow, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import { hostTranslate, type Translate } from "./englishTranslate.ts";
import { describePluginSpec, parseOpenCodePluginJson } from "./pluginImport.ts";
import {
  appliesText,
  componentChips,
  importQuestion,
  importSummary,
  installableScopes,
  installQuestion,
  outcomeNotice,
  parsePluginOptions,
  projectName,
  projectScope,
  requestFailureText,
  scopeHint,
  scopeLabel,
  sourceLabel,
  type PluginImportResult,
  type PluginOutcomeNotice,
} from "./pluginPresentation.ts";

const api = createApiTransport();

/** One busy key per action, scope and plugin. */
const busyKey = (action: NativePluginAction, scope: NativePluginScope | undefined, plugin: string): string =>
  `${action}:${scope ?? ""}:${plugin}`;

type SendResult =
  | { response: NativePluginMutationResponseDto }
  | { failure: PluginOutcomeNotice; unconfirmed: boolean };

/** Plugins installed through this harness's own plugin system, managed in the
 *  harness's native scope. Polyth reports what its sessions actually get from
 *  each one; changes apply to new conversations or the next runtime. */
export default function HarnessPlugins({ host, harnessId, snapshot, projectId }: {
  host: WebPackageHost;
  harnessId: string;
  snapshot?: HarnessSnapshot;
  projectId?: string | null;
}) {
  const [list, setList] = useState<NativePluginListDto>();
  const [loadError, setLoadError] = useState<unknown>();
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<PluginOutcomeNotice>();
  const [ref, setRef] = useState("");
  const [scope, setScope] = useState<NativePluginScope>();
  const [optionsText, setOptionsText] = useState("");
  const [optionsError, setOptionsError] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [importText, setImportText] = useState("");
  const [importPreview, setImportPreview] = useState<OpenCodePluginPreviewDto>();
  const [importReviewing, setImportReviewing] = useState(false);
  const t: Translate = hostTranslate(host.ui.locale.translate);
  const RISK = t("plugins.risk");
  const OPTIONS_NOTE = t("plugins.optionsNote");
  const name = snapshot?.identity.name ?? harnessId;
  const remote = Boolean(snapshot?.context.remote);
  const path = `/api/harnesses/${encodeURIComponent(harnessId)}/plugins${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`;

  const load = useCallback(async () => {
    try {
      setList(await api.get<NativePluginListDto>(path));
      setLoadError(undefined);
    } catch (cause) {
      setLoadError(cause);
    }
  }, [path]);
  useEffect(() => { void load(); }, [load]);

  /** One request. Never retried: an unconfirmed result means read again. */
  const send = async (action: NativePluginAction, plugin: string, pluginScope?: NativePluginScope, options?: Record<string, unknown>): Promise<SendResult> => {
    try {
      const response = await api.post<NativePluginMutationResponseDto>(path, {
        action,
        plugin,
        ...(pluginScope ? { scope: pluginScope } : {}),
        ...(options ? { options } : {}),
        confirm: true,
      });
      return { response };
    } catch (cause) {
      const status = (cause as { status?: unknown }).status;
      const known = typeof status === "number";
      const message = host.errors.friendly(t("plugins.changeAction", { name }), cause);
      return { failure: { tone: known ? "error" : "warning", text: requestFailureText(known ? status : undefined, message, t) }, unconfirmed: !known };
    }
  };

  const mutate = async (action: NativePluginAction, plugin: string, pluginScope?: NativePluginScope, options?: Record<string, unknown>): Promise<boolean> => {
    setBusy(busyKey(action, pluginScope, plugin));
    setNotice(undefined);
    try {
      const result = await send(action, plugin, pluginScope, options);
      if ("failure" in result) {
        // Without a response the command may still have run; show the real state.
        if (result.unconfirmed) await load();
        setNotice(result.failure);
        return false;
      }
      const { response } = result;
      if (response.list) setList(response.list);
      else await load();
      setNotice(outcomeNotice(action, plugin, response, (response.list ?? list)?.support.applies ?? "next-session", t));
      return response.outcome === "confirmed";
    } finally {
      setBusy("");
    }
  };

  const uninstall = async (plugin: NativePluginDto) => {
    if (!await confirmAlert(t("plugins.removeConfirm", { plugin: plugin.name, name }), {
      title: t("plugins.removeTitle"),
      confirmLabel: t("plugins.remove"),
      destructive: true,
    })) return;
    await mutate("uninstall", plugin.id, plugin.scope);
  };

  if (!list) {
    return <div className="pkg-harnesses-plugins" aria-busy={!loadError}>
      {loadError
        ? <ErrorState compact title={t("plugins.readFailed", { name })} error={loadError} onRetry={() => void load()} />
        : <EmptyState compact busy title={t("plugins.reading")} />}
    </div>;
  }

  const { support, project } = list;
  const working = Boolean(busy);
  const can = (action: NativePluginAction) => !remote && support.actions.includes(action);
  const installScopes = installableScopes(support.installScopes, project);
  const projectScopesHidden = installScopes.length < support.installScopes.length;
  const chosenScope = scope && installScopes.includes(scope) ? scope : installScopes[0];
  const refText = ref.trim();
  const withOptions = Boolean(support.installOptions && optionsText.trim());
  const canInstall = can("install") && installScopes.length > 0;

  const review = () => {
    if (!refText) return;
    if (support.installOptions) {
      const parsed = parsePluginOptions(optionsText, t);
      setOptionsError(parsed.error ?? "");
      if (parsed.error) return;
    }
    setReviewing(true);
  };
  const install = async () => {
    const parsed = support.installOptions ? parsePluginOptions(optionsText, t) : {};
    if (parsed.error) {
      setOptionsError(parsed.error);
      setReviewing(false);
      return;
    }
    if (await mutate("install", refText, chosenScope, parsed.options)) {
      setRef("");
      setOptionsText("");
      setReviewing(false);
    }
  };

  const importEntries = importPreview && importPreview.errors.length === 0 ? importPreview.entries : [];
  const previewImport = () => {
    setImportPreview(parseOpenCodePluginJson(importText, t));
    setImportReviewing(false);
  };
  const runImport = async () => {
    const entries = importEntries;
    setBusy("import");
    setNotice(undefined);
    const results: PluginImportResult[] = [];
    try {
      // One at a time; the route also serializes per harness. An unconfirmed
      // result stops the import so nothing runs on top of an unknown state.
      for (const entry of entries) {
        const result = await send("install", entry.spec, chosenScope, entry.options);
        if ("failure" in result) {
          results.push({ spec: entry.spec, failure: result.failure });
          if (result.unconfirmed) break;
          continue;
        }
        results.push({ spec: entry.spec, response: result.response });
        if (result.response.outcome === "unknown") break;
      }
      // Show the state after the last attempt, read again if it carried none.
      const last = results.at(-1);
      const latest = last && "response" in last ? last.response.list : undefined;
      if (latest) setList(latest);
      else await load();
      setNotice(importSummary(results, entries.length, (latest ?? list).support.applies, t));
      if (results.length === entries.length && results.every((result) => "response" in result && result.response.outcome === "confirmed")) {
        setImportText("");
        setImportPreview(undefined);
      }
      setImportReviewing(false);
    } finally {
      setBusy("");
    }
  };

  return <div className="pkg-harnesses-plugins" data-settings-item={`harness.${harnessId}.plugins`}>
    {notice && <Notice tone={notice.tone} role={notice.tone === "success" ? "status" : "alert"}>
      {notice.text}
      {notice.details && notice.details.length > 0 && <ul className="pkg-harnesses-plugins-details">
        {notice.details.map((detail, index) => <li key={index}>{detail}</li>)}
      </ul>}
    </Notice>}
    {list.warnings?.map((warning) => <Notice key={warning} tone="warning">{warning}</Notice>)}
    {remote && <Notice>{t("plugins.remoteOnly")}</Notice>}
    <Section title={t("plugins.installedTitle")} hint={appliesText(list, t)}
      action={<Button size="sm" variant="ghost" busy={busy === "reload"} disabled={working} onClick={() => { setBusy("reload"); void load().finally(() => setBusy("")); }}>{t("plugins.checkAgain")}</Button>}>
      {list.plugins.length === 0
        ? <EmptyState compact title={t("plugins.emptyTitle", { name })} body={canInstall ? t("plugins.emptyInstallBelow") : t("plugins.emptyNone", { name })} />
        : <ul className="pkg-harnesses-plugins-list">
            {list.plugins.map((plugin) => {
              const key = `${plugin.scope}:${plugin.id}`;
              // A project row cannot change without the project it belongs to.
              const locked = plugin.readOnly || remote || (projectScope(plugin.scope) && !project);
              const toggleable = !locked && plugin.enabled !== "unknown" && can(plugin.enabled ? "disable" : "enable");
              return <li key={key} className="pkg-harnesses-plugins-row" data-enabled={String(plugin.enabled)}>
                <div className="pkg-harnesses-plugins-main">
                  <span className="pkg-harnesses-plugins-name">
                    <strong>{plugin.name}</strong>
                    {plugin.version && <small>{plugin.version}</small>}
                  </span>
                  <small className="pkg-harnesses-plugins-meta">
                    <span>{sourceLabel(plugin, t)}</span>
                    <Tooltip content={scopeHint(plugin.scope, project, t)}><span tabIndex={0}>{scopeLabel(plugin.scope, t)}{plugin.projectPath ? ` · ${plugin.projectPath}` : ""}</span></Tooltip>
                    {plugin.enabled === "unknown" && <span>{t("plugins.stateUnknown")}</span>}
                  </small>
                  {componentChips(plugin, t).length > 0 && <span className="pkg-harnesses-plugins-chips">
                    {componentChips(plugin, t).map((chip) => <Tooltip key={chip.id} content={chip.description}>
                      <span className="pkg-harnesses-plugins-chip" tabIndex={0} aria-label={`${chip.label}: ${chip.effect}. ${chip.description}`}>
                        <Badge tone={chip.tone}>{chip.label} · {chip.effect}</Badge>
                      </span>
                    </Tooltip>)}
                  </span>}
                  {plugin.note && <small className="pkg-harnesses-plugins-note">{plugin.note}</small>}
                </div>
                <span className="pkg-harnesses-plugins-actions">
                  {toggleable && <Switch label={t(plugin.enabled ? "plugins.turnOff" : "plugins.turnOn", { plugin: plugin.name })} checked={plugin.enabled === true} disabled={working} onChange={(on) => void mutate(on ? "enable" : "disable", plugin.id, plugin.scope)} />}
                  {!locked && can("update") && <Button size="sm" variant="ghost" busy={busy === busyKey("update", plugin.scope, plugin.id)} disabled={working} aria-label={t("plugins.updateAria", { plugin: plugin.name })} onClick={() => void mutate("update", plugin.id, plugin.scope)}>{t("plugins.update")}</Button>}
                  {!locked && can("uninstall") && <Button size="sm" variant="ghost" busy={busy === busyKey("uninstall", plugin.scope, plugin.id)} disabled={working} aria-label={t("plugins.removeAria", { plugin: plugin.name })} onClick={() => void uninstall(plugin)}>{t("plugins.remove")}</Button>}
                </span>
              </li>;
            })}
          </ul>}
    </Section>
    {support.marketplaces && (list.marketplaces?.length ?? 0) > 0 && <Section title={t("plugins.marketplaces")} hint={t("plugins.marketplacesHint", { name })}>
      {list.marketplaces!.map((marketplace) => <ReadonlyRow key={marketplace.name} label={marketplace.name} value={marketplace.ref ?? marketplace.source ?? t("plugins.notReported")} mono />)}
    </Section>}
    {can("install") && projectScopesHidden && <Notice>{t("plugins.openFromProject")}</Notice>}
    {canInstall && <Section title={t("plugins.installTitle")} hint={RISK}>
      <form className="pkg-harnesses-plugins-install" onSubmit={(event) => { event.preventDefault(); review(); }}>
        <FormField label={t("plugins.pluginLabel")} hint={t("plugins.pluginHint", { example: support.installHint })}>
          {(field) => <TextInput {...field} uiSize="sm" value={ref} maxLength={512} autoComplete="off" spellCheck={false} disabled={working}
            onChange={(event) => { setRef(event.target.value); setReviewing(false); }} />}
        </FormField>
        {installScopes.length > 1
          ? <FormField label={t("plugins.installFor")} hint={chosenScope ? scopeHint(chosenScope, project, t) : undefined}>
              {() => <Select label={t("plugins.installFor")} value={chosenScope} disabled={working}
                options={installScopes.map((value) => ({ value, label: scopeLabel(value, t) }))}
                onChange={(value) => { setScope(value as NativePluginScope); setReviewing(false); }} />}
            </FormField>
          : chosenScope && projectScope(chosenScope) && project && <ReadonlyRow label={t("plugins.installFor")} value={projectName(project, t)} />}
        {support.installOptions && <FormField label={t("plugins.optionsLabel")} optional hint={t("plugins.optionsHint", { note: OPTIONS_NOTE })} error={optionsError || undefined}>
          {(field) => <Textarea {...field} className="pkg-harnesses-plugins-json" rows={3} value={optionsText} spellCheck={false} autoComplete="off" disabled={working}
            invalid={Boolean(optionsError)} placeholder='{"key": "value"}'
            onChange={(event) => { setOptionsText(event.target.value); setOptionsError(""); setReviewing(false); }} />}
        </FormField>}
        {reviewing
          ? <div className="pkg-harnesses-plugins-confirm" role="group" aria-label={t("plugins.confirmInstallAria")}>
              <p>{installQuestion(refText, chosenScope, project, withOptions, t)} {withOptions ? `${OPTIONS_NOTE} ` : ""}{RISK} {t("plugins.trustOnly")}</p>
              <Button size="sm" variant="primary" busy={busy === busyKey("install", chosenScope, refText)} disabled={working} onClick={() => void install()}>{t("plugins.install")}</Button>
              <Button size="sm" variant="ghost" disabled={working} onClick={() => setReviewing(false)}>{t("plugins.cancel")}</Button>
            </div>
          : <div className="pkg-harnesses-plugins-submit">
              <Button size="sm" type="submit" disabled={working || !refText}>{t("plugins.reviewInstall")}</Button>
            </div>}
      </form>
    </Section>}
    {canInstall && support.installOptions && <Section title={t("plugins.importTitle")} hint={t("plugins.importHint")}>
      <div className="pkg-harnesses-plugins-install">
        <FormField label={t("plugins.pluginJson")} error={importPreview?.errors.length ? importPreview.errors.join(" ") : undefined}>
          {(field) => <Textarea {...field} className="pkg-harnesses-plugins-json" rows={4} value={importText} spellCheck={false} autoComplete="off" disabled={working}
            invalid={Boolean(importPreview?.errors.length)} placeholder='{"plugin": ["name", ["name", {"key": "value"}]]}'
            onChange={(event) => { setImportText(event.target.value); setImportPreview(undefined); setImportReviewing(false); }} />}
        </FormField>
        {importEntries.length > 0 && <ul className="pkg-harnesses-plugins-preview" aria-label={t("plugins.importListAria")}>
          {importEntries.map((entry) => {
            const spec = describePluginSpec(entry.spec, t);
            return <li key={entry.spec}>
              <strong>{spec.name}</strong>
              <small className="pkg-harnesses-plugins-meta">
                <span>{spec.description}</span>
                <span>{spec.path}</span>
                {entry.options && <span>{t("plugins.withOptions")}</span>}
              </small>
            </li>;
          })}
        </ul>}
        {importPreview && importPreview.ignoredKeys.length > 0 && <small className="pkg-harnesses-plugins-note">{t("plugins.ignoredKeys", { keys: importPreview.ignoredKeys.join(", ") })}</small>}
        {importReviewing
          ? <div className="pkg-harnesses-plugins-confirm" role="group" aria-label={t("plugins.confirmImportAria")}>
              <p>
                {importQuestion(importEntries.length, chosenScope, project, t)}
                {" "}
                {importEntries.some((entry) => entry.options) ? `${t("plugins.optionsIncluded", { note: OPTIONS_NOTE })} ` : ""}
                {RISK} {t("plugins.trustOnly")}
              </p>
              <Button size="sm" variant="primary" busy={busy === "import"} disabled={working} onClick={() => void runImport()}>{t("plugins.installAll")}</Button>
              <Button size="sm" variant="ghost" disabled={working} onClick={() => setImportReviewing(false)}>{t("plugins.cancel")}</Button>
            </div>
          : <div className="pkg-harnesses-plugins-submit">
              {importEntries.length > 0
                ? <Button size="sm" disabled={working} onClick={() => setImportReviewing(true)}>{t("plugins.reviewImport")}</Button>
                : <Button size="sm" disabled={working || !importText.trim()} onClick={previewImport}>{t("plugins.preview")}</Button>}
            </div>}
      </div>
    </Section>}
  </div>;
}
