import { useEffect, useState } from "react";
import { api } from "@polyth/session/web-api";
import type {
  InstalledPluginDto,
  OpenCodePluginConfigEntry,
  OpenCodePluginEntryDto,
  OpenCodePluginPreviewDto,
  PackageCapabilityRequestDto,
  PackageConnectionReviewDto,
  PackageConnectionSecurityDto,
} from "@polyth/contracts";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { EmptyState, PageHead } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { useWidgetCatalog } from "../../../apps/web/src/widgets/catalog.ts";
import { useWidgetLayout } from "../../../apps/web/src/widgets/widgetLayout.ts";
import { describePluginSpec, parseOpenCodePluginJson } from "./pluginImport.ts";
import { isSupportedInstallSource } from "../src/installSourceContract.ts";
import { Button, IconButton, Tabs, Textarea, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { CloseIcon } from "../../../apps/web/src/components/ui/icons.ts";

const OTTO_PLUGIN_EXAMPLE = `{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@otto-assistant/opencode-claude"]
}`;

export function OpenCodePluginsSection() {
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

function isInstallSource(value: string): boolean {
  return isSupportedInstallSource(value);
}

interface CapabilityReviewView {
  required: boolean;
  origins: string[];
  methods: string[];
  modelClasses: string[];
  maxOutputTokens?: number;
}

/** The server manifest parser already validates these fields. The root
 * contracts DTO predates v2 constraints, so the settings UI re-validates the
 * JSON-compatible extension before presenting it instead of relying on an
 * unsafe cast or pretending optional authority is required. */
function capabilityReviewView(capability: PackageCapabilityRequestDto): CapabilityReviewView {
  const raw = capability as unknown as Record<string, unknown>;
  const constraints = raw.constraints && typeof raw.constraints === "object" && !Array.isArray(raw.constraints)
    ? raw.constraints as Record<string, unknown>
    : {};
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  const maxOutputTokens = typeof constraints.maxOutputTokens === "number" && Number.isFinite(constraints.maxOutputTokens)
    ? constraints.maxOutputTokens
    : undefined;
  return {
    required: raw.required !== false,
    origins: strings(constraints.origins),
    methods: strings(constraints.methods),
    modelClasses: strings(constraints.modelClasses),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}

function capabilityLine(capability: PackageCapabilityRequestDto): string {
  const label = tr(`packages.plugins.capability.${capability.name}` as Parameters<typeof tr>[0]);
  const view = capabilityReviewView(capability);
  const detail = [
    ...(view.origins.length ? [`origins: ${view.origins.join(", ")}`] : []),
    ...(view.methods.length ? [`methods: ${view.methods.join(", ")}`] : []),
    ...(view.modelClasses.length ? [`models: ${view.modelClasses.join(", ")}`] : []),
    ...(view.maxOutputTokens !== undefined ? [`max output: ${view.maxOutputTokens} tokens`] : []),
  ];
  const requirement = view.required ? "required" : "optional";
  return `${label} · ${requirement}${detail.length ? ` · ${detail.join(" · ")}` : ""}`;
}

function securityLine(label: string, value?: string | string[]): string | null {
  if (!value || (Array.isArray(value) && value.length === 0)) return null;
  return `${label}: ${Array.isArray(value) ? value.join(", ") : value}`;
}

function ConnectionSecurity({ value }: { value: PackageConnectionSecurityDto }) {
  const lines = [
    securityLine(tr("packages.plugins.kind"), value.kind),
    securityLine(tr("packages.plugins.apiOrigins"), value.origins),
    securityLine(tr("packages.plugins.oauthAuthorize"), value.authorizeUrl),
    securityLine(tr("packages.plugins.oauthToken"), value.tokenUrl),
    securityLine(tr("packages.plugins.oauthClientId"), value.clientId),
    securityLine(tr("packages.plugins.oauthScopes"), value.scopes),
  ].filter((line): line is string => Boolean(line));
  return (
    <ul>
      {lines.map((line) => <li key={line}>{line}</li>)}
    </ul>
  );
}

function ConnectionReviewList({ items }: { items: PackageConnectionReviewDto[] }) {
  if (items.length === 0) return null;
  return (
    <div className="plugin-permission-block">
      <strong>{tr("packages.plugins.connectionSecurity")}</strong>
      {items.map((item) => (
        <div key={item.id}>
          <p>
            {item.label}
            {item.kind === "changed" ? ` — ${tr("packages.plugins.changed")}` : ` — ${tr("packages.plugins.new")}`}
          </p>
          {item.current && (
            <>
              <span className="muted">{tr("packages.plugins.current")}</span>
              <ConnectionSecurity value={item.current} />
            </>
          )}
          <span className="muted">{tr("packages.plugins.requested")}</span>
          <ConnectionSecurity value={item.next} />
        </div>
      ))}
    </div>
  );
}

function PermissionList({
  title,
  items,
}: {
  title: string;
  items: PackageCapabilityRequestDto[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="plugin-permission-block">
      <strong>{title}</strong>
      <ul>
        {items.map((item) => {
          const view = capabilityReviewView(item);
          return (
            <li key={`${item.name}:${view.required}:${JSON.stringify(item.constraints ?? {})}`}>{capabilityLine(item)}</li>
          );
        })}
      </ul>
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
  const sourceValid = isInstallSource(source);
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

  const approveReview = async (
    plugin: InstalledPluginDto,
    options: { enableAfter?: boolean; includeOptional?: boolean } = {},
  ) => {
    setError("");
    const review = plugin.permissions.review;
    if (!review) return;
    try {
      const capabilities = review.capabilities
        .filter((item) => options.includeOptional || capabilityReviewView(item).required)
        .map((item) => item.name);
      const connections = review.connections.map((item) => item.id);
      await api.pluginsGrant(plugin.id, capabilities, connections);
      if (options.enableAfter) {
        const enabled = await api.pluginsOp(plugin.id, "enable");
        setToast(tr("settings.pages.pluginEnabledSeeContributions", { name: enabled.name }));
      } else if (plugin.update) {
        setToast(tr("settings.pages.pluginReloaded", { name: plugin.name }));
      } else {
        setToast(tr("settings.pages.pluginReloaded", { name: plugin.name }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    refresh();
  };

  const stageUpdate = async (id: string) => {
    setError("");
    try {
      const plugin = await api.pluginsUpdate(id);
      if (plugin.permissions.review || plugin.update) {
        setSelected(id);
        setDetailTab("permissions");
        setToast(tr("packages.plugins.additionalAccessRequested"));
      } else {
        setToast(tr("settings.pages.pluginReloaded", { name: plugin.name }));
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const plugin = plugins.find((item) => item.id === id);
      setError(plugin?.previousVersion
        ? tr("packages.plugins.updateFailedRestored", { version: plugin.previousVersion })
        : message);
    }
    refresh();
  };

  const rollback = async (id: string) => {
    setError("");
    try {
      const plugin = await api.pluginsRollback(id);
      setToast(tr("packages.plugins.updateFailedRestored", { version: plugin.version }));
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

  const openReview = (plugin: InstalledPluginDto) => {
    setSelected(plugin.id);
    setDetailTab("permissions");
  };

  const selectedPlugin = plugins.find((plugin) => plugin.id === selected);
  const contributionCount = (plugin: InstalledPluginDto, prefix: string) =>
    plugin.contributions.filter((item) => item.slot.startsWith(prefix)).length;
  const sandboxed = (plugin: InstalledPluginDto) => plugin.runtimeKind === "sandboxed";
  const hasReview = (plugin: InstalledPluginDto) => Boolean(plugin.permissions.review);
  const needsReviewToEnable = (plugin: InstalledPluginDto) =>
    sandboxed(plugin) && !plugin.enabled && plugin.permissions.requested.some(
      (item) => capabilityReviewView(item).required && !plugin.permissions.effective.includes(item.name),
    );
  const detailTabs = (plugin: InstalledPluginDto) => {
    const tabs: Array<{ id: string; label: string }> = [
      { id: "overview", label: "Overview" },
      { id: "permissions", label: "Permissions" },
    ];
    if ((plugin.connections?.length ?? 0) > 0 || plugin.contributions.length > 0) {
      tabs.push({ id: "contributions", label: "Contributions" });
    }
    if (!sandboxed(plugin)) {
      if (contributionCount(plugin, "widget.") > 0) tabs.push({ id: "widgets", label: "Widgets" });
      if (contributionCount(plugin, "command") > 0) tabs.push({ id: "commands", label: "Commands" });
      if (plugin.permissions.requested.length > 0) tabs.push({ id: "tools", label: "Tools" });
      if (contributionCount(plugin, "settings.") > 0) tabs.push({ id: "settings", label: "Settings" });
    }
    return tabs;
  };

  return (
    <div className="plugin-library" data-settings-item="plugins.managed">
      <div className="plugin-library-head">
        <div><strong>{tr("packages.plugins.packages")}</strong><span>{tr("packages.plugins.packagesHint")}</span></div>
        <span>{plugins.length} {tr("settings.pages.installed")}</span>
      </div>
      {plugins.length === 0 && (
        <EmptyState
          title={tr("packages.plugins.noPackages")}
          body={tr("packages.plugins.sourceHint")}
        />
      )}
      <div className="plugin-card-grid">
        {plugins.map((p) => {
          const widgetCount = contributionCount(p, "widget.");
          const commandCount = contributionCount(p, "command");
          const toolCount = p.permissions.requested.length;
          return (
            <article key={p.id} className={`plugin-card ${p.enabled ? "enabled" : "disabled"}`}>
              <button type="button" className="plugin-card-main" onClick={() => setSelected(p.id)}>
                <span className="plugin-card-icon">{(p.icon ?? p.name).slice(0, 1).toUpperCase()}</span>
                <span className="plugin-card-copy">
                  <strong>{p.name}</strong>
                  <small>{p.source} · {tr("settings.pages.v")}{p.version}</small>
                </span>
                <span className={`tag mcp-status ${!p.enabled ? "disabled" : p.status === "ready" ? "connected" : p.status === "error" ? "error" : "disabled"}`}>
                  {!p.enabled
                    ? tr("packages.plugins.disabledInThisSpace")
                    : p.status === "ready"
                      ? tr("settings.pages.ready")
                      : p.status === "error"
                        ? tr("common.error")
                        : p.status}
                </span>
                <p>{p.lastError || p.description || tr("settings.pages.pluginContributionsCount", {
                  name: p.name,
                  count: p.contributions.length,
                })}</p>
                <span className="plugin-card-counts">
                  <b>{sandboxed(p) ? tr("packages.plugins.sandboxedPackage") : tr("packages.plugins.trustedLocalPackage")}</b>
                  <b>{widgetCount} {tr("settings.pages.widgets")}</b>
                  <b>{commandCount} {tr("settings.pages.commands")}</b>
                  <b>{toolCount} {tr("settings.pages.tools")}</b>
                </span>
              </button>
              <div className="plugin-card-actions">
                {p.update && hasReview(p)
                  ? <Button size="sm" onClick={() => openReview(p)}>{tr("packages.plugins.reviewUpdate")}</Button>
                  : p.update
                    ? <Button size="sm" onClick={() => void stageUpdate(p.id)}>{tr("settings.pages.updateTo")}{" "}{p.update.version}</Button>
                    : null}
                {p.previousVersion && (
                  <Button size="sm" onClick={() => void rollback(p.id)}>{tr("packages.plugins.rollback")}</Button>
                )}
                {p.enabled
                  ? <Button size="sm" onClick={() => void op(p.id, "disable")}>{tr("settings.pages.disable")}</Button>
                  : needsReviewToEnable(p)
                    ? <Button size="sm" onClick={() => openReview(p)}>{tr("packages.plugins.reviewAndEnable")}</Button>
                    : <Button size="sm" onClick={() => void op(p.id, "enable")}>{tr("settings.pages.enable")}</Button>}
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
            <span className="plugin-card-icon">{(selectedPlugin.icon ?? selectedPlugin.name).slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{selectedPlugin.name}</strong>
              <small>{tr("settings.pages.v")}{selectedPlugin.version} · {selectedPlugin.source}</small>
            </div>
            <IconButton icon={CloseIcon} size="sm" label={tr("settings.pages.closePluginDetails")} onClick={() => setSelected(null)} />
          </header>
          <Tabs
            size="sm"
            className="plugin-detail-tabs ui-scroll-tabs"
            label={tr("settings.pages.pluginContributionsCount", { name: selectedPlugin.name, count: selectedPlugin.contributions.length })}
            value={detailTab}
            tabs={detailTabs(selectedPlugin)}
            onChange={(tab) => setDetailTab(tab as typeof detailTab)}
          />
          <div className="plugin-detail-body">
            {detailTab === "overview" && (
              <div className="plugin-permission-block">
                <p className="plugin-trust-copy">
                  <span className={`tag plugin-trust trust-${selectedPlugin.trust}`}>
                    {sandboxed(selectedPlugin)
                      ? tr("packages.plugins.sandboxedPackage")
                      : tr("packages.plugins.trustedLocalPackage")}
                  </span>
                  {" "}
                  {sandboxed(selectedPlugin)
                    ? tr("packages.plugins.sandboxedPackageHint")
                    : tr("packages.plugins.trustedLocalPackageHint")}
                </p>
                <p>{selectedPlugin.description}</p>
                <p>{selectedPlugin.enabled
                  ? tr("settings.pages.enabledAndReadyToContributeToYour")
                  : tr("settings.pages.disabledExistingLayoutPlacementsAreKeptUntil")}</p>
                {selectedPlugin.lastError && <p className="form-error">{selectedPlugin.lastError}</p>}
                {selectedPlugin.connections && selectedPlugin.connections.length > 0 && (
                  <ul>
                    {selectedPlugin.connections.map((connection) => (
                      <li key={connection.id}>{connection.label}: {connection.status}{connection.account ? ` (${connection.account})` : ""}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {detailTab === "widgets" && <p>{contributionCount(selectedPlugin, "widget.")} {tr("settings.pages.widgetContributionsInstallingAPluginNeverInserts")}</p>}
            {detailTab === "commands" && <p>{contributionCount(selectedPlugin, "command")} {tr("settings.pages.commandContributions")}</p>}
            {detailTab === "tools" && (
              <p>
                {selectedPlugin.permissions.requested.length
                  ? selectedPlugin.permissions.requested.map(capabilityLine).join(", ")
                  : tr("settings.pages.noDeclaredTools")}
              </p>
            )}
            {detailTab === "settings" && <p>{contributionCount(selectedPlugin, "settings.")} {tr("settings.pages.settingsPagesOrControls")}</p>}
            {detailTab === "permissions" && (
              <div>
                <p className="plugin-trust-copy">
                  {sandboxed(selectedPlugin)
                    ? tr("packages.plugins.grantToEnable")
                    : tr("settings.pages.permissionsAreRequestedWhenThePluginNeeds")}
                </p>
                {selectedPlugin.permissions.review && (
                  <>
                    <PermissionList
                      title={tr("packages.plugins.additionalAccessRequested")}
                      items={selectedPlugin.permissions.review.capabilities}
                    />
                    <ConnectionReviewList items={selectedPlugin.permissions.review.connections} />
                    <div className="plugin-card-actions">
                      {selectedPlugin.update
                        ? <>
                            <Button size="sm" onClick={() => void approveReview(selectedPlugin)}>{tr("packages.plugins.reviewUpdate")}</Button>
                            {selectedPlugin.permissions.review.capabilities.some((item) => !capabilityReviewView(item).required) && (
                              <Button size="sm" variant="quiet" onClick={() => void approveReview(selectedPlugin, { includeOptional: true })}>Approve update + optional access</Button>
                            )}
                          </>
                        : !selectedPlugin.enabled
                          ? <>
                              <Button size="sm" onClick={() => void approveReview(selectedPlugin, { enableAfter: true })}>{tr("packages.plugins.reviewAndEnable")}</Button>
                              {selectedPlugin.permissions.review.capabilities.some((item) => !capabilityReviewView(item).required) && (
                                <Button size="sm" variant="quiet" onClick={() => void approveReview(selectedPlugin, { enableAfter: true, includeOptional: true })}>Enable + optional access</Button>
                              )}
                            </>
                          : <>
                              <Button size="sm" onClick={() => void approveReview(selectedPlugin)}>{tr("packages.plugins.approveAccess")}</Button>
                              {selectedPlugin.permissions.review.capabilities.some((item) => !capabilityReviewView(item).required) && (
                                <Button size="sm" variant="quiet" onClick={() => void approveReview(selectedPlugin, { includeOptional: true })}>Approve optional access too</Button>
                              )}
                            </>}
                    </div>
                  </>
                )}
                <PermissionList
                  title={tr("packages.plugins.requestedAccess")}
                  items={selectedPlugin.permissions.requested}
                />
                <p>
                  {sandboxed(selectedPlugin)
                    ? tr("packages.plugins.doesNotRequestServerExecution")
                    : tr("packages.plugins.trustedLocalPackageHint")}
                </p>
              </div>
            )}
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
          placeholder={tr("packages.plugins.sourceHint")}
          aria-label={tr("packages.plugins.addPackage")}
          aria-invalid={source.length > 0 && !sourceValid ? true : undefined}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && sourceValid) void install(); }}
        />
        <Button size="sm" disabled={!sourceValid} onClick={() => void install()}>{tr("packages.plugins.addPackage")}</Button>
      </div>
      {error && <div className="form-error">{error}</div>}
      {toast && <div className="plugin-toast" role="status"><span>{toast}</span><Button size="sm" variant="ghost" onClick={() => setToast("")}>{tr("settings.pages.dismiss")}</Button></div>}
    </div>
  );
}

export default function PluginsPage() {
  return (
    <div className="pkg-plugins">
      <PageHead title={tr("packages.plugins.pageTitle")} blurb={tr("packages.plugins.pageBlurb")} />
      <ManagedPluginsSection />
    </div>
  );
}
