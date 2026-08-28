import { useEffect, useState } from "react";
import { api } from "@polyth/session/web-api";
import type {
  InstalledPluginDto,
  OpenCodePluginConfigEntry,
  OpenCodePluginEntryDto,
  OpenCodePluginPreviewDto,
} from "@polyth/contracts";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { EmptyState, PageHead } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { useWidgetCatalog } from "../../../apps/web/src/widgets/catalog.ts";
import { useWidgetLayout } from "../../../apps/web/src/widgets/widgetLayout.ts";
import { describePluginSpec, parseOpenCodePluginJson } from "./pluginImport.ts";
import { Button, IconButton, Tabs, Textarea, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { CloseIcon } from "../../../apps/web/src/components/ui/icons.ts";

const OTTO_PLUGIN_EXAMPLE = `{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@otto-assistant/opencode-claude"]
}`;

function OpenCodePluginsSection() {
  const [plugins, setPlugins] = useState<OpenCodePluginEntryDto[]>([]);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<OpenCodePluginPreviewDto | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const result = await api.opencodePluginsList();
      setPlugins(result.plugins);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => { void refresh(); }, []);

  const importPlugins = async () => {
    if (!preview || preview.errors.length > 0 || preview.entries.length === 0) return;
    setBusy(true);
    setError("");
    setNotice("");
    const entries: OpenCodePluginConfigEntry[] = preview.entries.map((entry) =>
      entry.options ? [entry.spec, entry.options] : entry.spec);
    try {
      const result = await api.opencodePluginsImport({ plugins: entries });
      setPlugins(result.plugins);
      setText("");
      setPreview(null);
      setNotice(
        `${result.imported.length} OpenCode plugin${result.imported.length === 1 ? "" : "s"} staged.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (plugin: OpenCodePluginEntryDto) => {
    if (!await confirmAlert(`Remove OpenCode plugin "${plugin.spec}" from opencode.json?`, {
      title: "Remove OpenCode plugin",
      confirmLabel: tr("common.remove"),
    })) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.opencodePluginRemove(plugin.spec);
      setPlugins(result.plugins);
      if (result.removed) setNotice(`${plugin.spec} removal staged.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="opencode-plugin-section" data-settings-item="plugins.opencode">
      <div className="plugin-library-head">
        <div>
          <strong>OpenCode plugins</strong>
          <span>Paste a package spec, plugin array, or OpenCode config. Only the plugin array is merged into opencode.json.</span>
        </div>
        <span>{plugins.length} configured</span>
      </div>
      <div className="mcp-list">
        {plugins.length === 0 && (
          <EmptyState title="No OpenCode plugins configured" body="Paste JSON below to add one without changing providers, MCP servers, agents, or other config." />
        )}
        {plugins.map((plugin) => {
          const info = describePluginSpec(plugin.spec);
          return (
            <div className="set-row" key={plugin.spec}>
              <div className="set-row-text">
                <div className="set-row-label">{info.name}</div>
                <div className="set-row-hint mono">{info.path}</div>
                <div className="set-row-hint">
                  {info.description}
                  {plugin.options && ` · Options: ${JSON.stringify(plugin.options)}`}
                </div>
              </div>
              <div className="set-row-control">
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove(plugin)}>Remove</Button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mcp-form">
        <div className="stat-label">
          Import OpenCode plugin JSON <span className="muted">(string entries and [spec, options] tuples are supported)</span>
        </div>
        <Textarea
          rows={7}
          className="mono"
          aria-label="OpenCode plugin JSON"
          placeholder={OTTO_PLUGIN_EXAMPLE}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setPreview(null);
            setError("");
            setNotice("");
          }}
        />
        {preview && (
          <div className="mcp-import-preview" aria-live="polite">
            {preview.entries.map((entry) => {
              const existing = plugins.some((plugin) => plugin.spec === entry.spec);
              return (
                <div key={entry.spec} className="set-row-hint mono">
                  {existing ? "↻" : "+"} {entry.spec}
                  {entry.options && ` · ${JSON.stringify(entry.options)}`}
                  {existing && <span> — existing entry will be updated</span>}
                </div>
              );
            })}
            {preview.ignoredKeys.length > 0 && (
              <div className="set-row-hint">
                Not imported: {preview.ignoredKeys.join(", ")}. Those config keys remain unchanged.
              </div>
            )}
            {preview.errors.map((message, index) => <div className="form-error" key={index}>{message}</div>)}
          </div>
        )}
        <div className="mcp-form-row">
          <Button
            size="sm"
            disabled={busy || !text.trim()}
            onClick={() => setPreview(parseOpenCodePluginJson(text))}
          >
            Preview
          </Button>
          <Button
            size="sm"
            busy={busy}
            disabled={!preview || preview.entries.length === 0 || preview.errors.length > 0}
            onClick={() => void importPlugins()}
          >
            {busy ? "Importing…" : `Import ${preview?.entries.length ?? 0} plugin${(preview?.entries.length ?? 0) === 1 ? "" : "s"}`}
          </Button>
        </div>
      </div>
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="plugin-toast" role="status"><span>{notice}</span><Button size="sm" variant="ghost" onClick={() => setNotice("")}>Dismiss</Button></div>}
    </section>
  );
}

function PluginLogViewer({ id }: { id: string }) {
  const [lines, setLines] = useState<Array<{ at: number; line: string }>>([]);
  useEffect(() => { void api.pluginsLogs(id).then(setLines).catch(() => setLines([])); }, [id]);
  return (
    <div className="plugin-log" role="log" aria-label={tr("settings.pages.logsForValue", { id: id })}>
      {lines.length === 0 && <span className="muted">{tr("settings.pages.noLogOutput")}</span>}
      {lines.map((l, i) => <div key={i} className="mono plugin-log-line">{l.line}</div>)}
    </div>
  );
}

export function ManagedPluginsSection() {
  const [plugins, setPlugins] = useState<InstalledPluginDto[]>([]);
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<"overview" | "widgets" | "commands" | "tools" | "settings" | "permissions" | "contributions">("overview");
  const [toast, setToast] = useState("");
  const widgets = useWidgetCatalog();
  const layout = useWidgetLayout();
  const sourceValid = /^(?:npm|file):\S+$/.test(source.trim());
  const refresh = () => void api.pluginsList().then(setPlugins);
  useEffect(() => { refresh(); }, []);

  const install = async () => {
    if (!sourceValid) return;
    setError("");
    try {
      const installed = await api.pluginsInstall(source.trim());
      setSource("");
      setToast(tr("settings.pages.pluginInstalledContributionsAvailable", { name: installed.name }));
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const op = async (id: string, what: "enable" | "disable" | "reload") => {
    setError("");
    try {
      const plugin = await api.pluginsOp(id, what);
      setToast(what === "disable"
        ? tr("settings.pages.pluginDisabledPlacementsKept", { name: plugin.name })
        : what === "enable"
          ? tr("settings.pages.pluginEnabledSeeContributions", { name: plugin.name })
          : tr("settings.pages.pluginReloaded", { name: plugin.name }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    refresh();
  };

  const remove = async (plugin: InstalledPluginDto) => {
    const active = Object.values(layout.widgets).filter((placement) =>
      placement.visible
      && (placement.pluginId === plugin.id
        || widgets.some((widget) => widget.id === placement.definitionId && widget.pluginId === plugin.id)));
    const warning = active.length > 0
      ? tr("settings.pages.pluginWidgetsInLayoutUninstallWarning", {
          count: active.length,
          name: plugin.name,
        })
      : tr("settings.pages.removePluginValue", { name: plugin.name });
    if (!await confirmAlert(warning, { title: tr("settings.pages.removePlugin"), confirmLabel: tr("common.remove") })) return;
    await api.pluginsRemove(plugin.id);
    setToast(tr("settings.pages.pluginRemoved", { name: plugin.name }));
    if (selected === plugin.id) setSelected(null);
    refresh();
  };

  const selectedPlugin = plugins.find((plugin) => plugin.id === selected);
  const contributionCount = (plugin: InstalledPluginDto, prefix: string) =>
    plugin.contributions.filter((item) => item.slot.startsWith(prefix)).length;

  return (
    <div className="plugin-library" data-settings-item="plugins.managed">
      <div className="plugin-library-head">
        <div><strong>{tr("settings.pages.managedPolythPlugins")}</strong><span>{tr("settings.pages.extensionsWithAPolythPlugin")}</span></div>
        <span>{plugins.length} {tr("settings.pages.installed")}</span>
      </div>
      {plugins.length === 0 && (
        <EmptyState
          title={tr("settings.pages.noManagedPluginsInstalled")}
          body={tr("settings.pages.installManagedPluginHint")}
        />
      )}
      <div className="plugin-card-grid">
        {plugins.map((p) => {
          const widgetCount = contributionCount(p, "widget.");
          const commandCount = contributionCount(p, "command");
          const toolCount = p.capabilities.length;
          return (
            <article key={p.id} className={`plugin-card ${p.enabled ? "enabled" : "disabled"}`}>
              <button type="button" className="plugin-card-main" onClick={() => setSelected(p.id)}>
                <span className="plugin-card-icon">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="plugin-card-copy">
                  <strong>{p.name}</strong>
                  <small>{p.source}</small>
                </span>
                <span className={`tag mcp-status ${p.status === "ready" ? "connected" : p.status === "error" ? "error" : "disabled"}`}>
                  {p.status === "ready"
                    ? tr("settings.pages.ready")
                    : p.status === "error"
                      ? tr("common.error")
                      : p.status === "disabled"
                        ? tr("settings.packagespage.disabled")
                        : p.status}
                </span>
                <p>{p.lastError || tr("settings.pages.pluginContributionsCount", {
                  name: p.name,
                  count: p.contributions.length,
                })}</p>
                <span className="plugin-card-counts">
                  <b>{widgetCount} {tr("settings.pages.widgets")}</b><b>{commandCount} {tr("settings.pages.commands")}</b><b>{toolCount} {tr("settings.pages.tools")}</b>
                </span>
              </button>
              <div className="plugin-card-actions">
                {p.update && <Button size="sm" onClick={() => void op(p.id, "reload")}>{tr("settings.pages.updateTo")}{" "}{p.update.version}</Button>}
                <Button size="sm" onClick={() => void op(p.id, p.enabled ? "disable" : "enable")}>{p.enabled ? tr("settings.pages.disable") : tr("settings.pages.enable")}</Button>
                <Button size="sm" onClick={() => setLogsFor(logsFor === p.id ? null : p.id)}>{tr("settings.pages.logs")}</Button>
                <Button size="sm" variant="danger" onClick={() => void remove(p)}>{tr("settings.pages.uninstall")}</Button>
              </div>
            </article>
          );
        })}
      </div>
      {selectedPlugin && (
        <section className="plugin-detail">
          <header>
            <span className="plugin-card-icon">{selectedPlugin.name.slice(0, 1).toUpperCase()}</span>
            <div><strong>{selectedPlugin.name}</strong><small>{tr("settings.pages.v")}{selectedPlugin.version} · {selectedPlugin.source}</small></div>
            <IconButton icon={CloseIcon} size="sm" label={tr("settings.pages.closePluginDetails")} onClick={() => setSelected(null)} />
          </header>
          <Tabs
            size="sm"
            className="plugin-detail-tabs ui-scroll-tabs"
            label={tr("settings.pages.pluginContributionsCount", { name: selectedPlugin.name, count: selectedPlugin.contributions.length })}
            value={detailTab}
            tabs={(["overview", "widgets", "commands", "tools", "settings", "permissions", "contributions"] as const).map((tab) => ({
              id: tab,
              label: tab[0]!.toUpperCase() + tab.slice(1),
            }))}
            onChange={(tab) => setDetailTab(tab as typeof detailTab)}
          />
          <div className="plugin-detail-body">
            {detailTab === "overview" && <p>{selectedPlugin.enabled ? tr("settings.pages.enabledAndReadyToContributeToYour") : tr("settings.pages.disabledExistingLayoutPlacementsAreKeptUntil")}</p>}
            {detailTab === "widgets" && <p>{contributionCount(selectedPlugin, "widget.")} {tr("settings.pages.widgetContributionsInstallingAPluginNeverInserts")}</p>}
            {detailTab === "commands" && <p>{contributionCount(selectedPlugin, "command")} {tr("settings.pages.commandContributions")}</p>}
            {detailTab === "tools" && <p>{selectedPlugin.capabilities.length ? selectedPlugin.capabilities.join(", ") : tr("settings.pages.noDeclaredTools")}</p>}
            {detailTab === "settings" && <p>{contributionCount(selectedPlugin, "settings.")} {tr("settings.pages.settingsPagesOrControls")}</p>}
            {detailTab === "permissions" && <p><span className={`tag plugin-trust trust-${selectedPlugin.trust}`}>{selectedPlugin.trust}</span> {tr("settings.pages.permissionsAreRequestedWhenThePluginNeeds")}</p>}
            {detailTab === "contributions" && (
              <ul>{selectedPlugin.contributions.map((item) => <li key={`${item.slot}:${item.id}`}><code>{item.slot}</code> {item.id}</li>)}</ul>
            )}
          </div>
        </section>
      )}
      {logsFor && <PluginLogViewer id={logsFor} />}
      <div className="set-add-form">
        <TextInput
          uiSize="sm"
          value={source}
          placeholder={tr("settings.pages.npmScopeName100Or")}
          aria-invalid={source.length > 0 && !sourceValid ? true : undefined}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && sourceValid) void install(); }}
        />
        <Button size="sm" disabled={!sourceValid} onClick={() => void install()}>{tr("settings.pages.install")}</Button>
      </div>
      {error && <div className="form-error">{error}</div>}
      {toast && <div className="plugin-toast" role="status"><span>{toast}</span><Button size="sm" variant="ghost" onClick={() => setToast("")}>{tr("settings.pages.dismiss")}</Button></div>}
    </div>
  );
}

export default function PluginsPage() {
  return (
    <>
      <PageHead title="Plugins" blurb="Configure OpenCode runtime plugins or install managed Polyth UI extensions." />
      <OpenCodePluginsSection />
      <ManagedPluginsSection />
    </>
  );
}
