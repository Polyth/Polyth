// Providers & Models: managed provider instances as the navigation.
// Status is derived (Ready / Needs setup / Disabled) and is never
// the same thing as the enable toggle. Model search is local to a card.
import { useEffect, useMemo, useState } from "react";
import { deriveProviderStatus, filterProviderModels, isFavorite, orderProviders } from "@polyth/models";
import {
  reorderModelProviders,
  setModelProviderExpanded,
  toggleModelFavorite,
  useModelPrefs,
} from "./modelPrefs.ts";
import { setModels } from "../../../apps/web/src/store.ts";
import {
  api,
  type AvailableProviderDto,
  type ProviderAuthMethodDto,
  type ProviderCatalogDto,
  type VisibilityStateDto,
} from "@polyth/session/web-api";
import { EmptyState, PageHead, Toggle } from "../../../apps/web/src/components/settings/parts.tsx";
import { modelDisplayName } from "../../../apps/web/src/composer/discovery.ts";
import Picker from "../../../apps/web/src/components/Picker.tsx";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import ProviderConnect from "./ProviderConnect.tsx";
import ProviderLogo from "./ProviderLogo.tsx";
import CustomProviderDialog from "./CustomProviderDialog.tsx";
import MoveControls from "../../../apps/web/src/components/MoveControls.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  AddIcon,
  Badge,
  Button,
  FavoriteIcon,
  Icon,
  IconButton,
  RefreshIcon,
  Switch,
  TextInput,
} from "../../../apps/web/src/components/ui/index.ts";

function fmtContext(context?: number): string {
  if (!context) return "";
  return context >= 1000 ? `${Math.round(context / 1000)}k ctx` : `${context} ctx`;
}

function statusLabel(status: ProviderCatalogDto["status"]): { text: string; tone: "neutral" | "warning" | "danger" | "success" } | null {
  if (status === "needs-setup") return { text: tr("settings.modelspage.statusNeedsSetup"), tone: "warning" };
  if (status === "disabled") return { text: tr("settings.modelspage.statusDisabled"), tone: "neutral" };
  return null;
}

/** Re-derive the quiet badge from catalog facts + the enabled overlay. */
function overlayStatus(provider: ProviderCatalogDto, enabled: boolean): NonNullable<ProviderCatalogDto["status"]> {
  return deriveProviderStatus({
    enabled,
    configured: provider.configured === true,
    hasCredential: provider.hasCredential === true,
    connected: provider.connected,
    authRequired: provider.custom?.authMode === "none" ? false : provider.custom?.authMode === "api-key" ? true : undefined,
  });
}

export default function ModelsPage() {
  const prefs = useModelPrefs();
  const [providers, setProviders] = useState<ProviderCatalogDto[] | null>(null);
  const [error, setError] = useState("");
  const [draggedProvider, setDraggedProvider] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState("");
  const [options, setOptions] = useState<{
    available: AvailableProviderDto[];
    authMethods: Record<string, ProviderAuthMethodDto[]>;
    loaded: boolean;
    loading: boolean;
    error: string;
  }>({ available: [], authMethods: {}, loaded: false, loading: false, error: "" });
  const [refreshing, setRefreshing] = useState(false);
  const [reconfiguring, setReconfiguring] = useState<ReadonlySet<string>>(new Set());
  const [customOpen, setCustomOpen] = useState<null | { id?: string }>(null);
  const [modelQuery, setModelQuery] = useState<Record<string, string>>({});
  const catalogModels = useMemo(
    () => providers?.flatMap((provider) => provider.models) ?? [],
    [providers],
  );

  const refreshCatalog = () =>
    api.listProviders().then(setProviders).catch((e) => setError(e instanceof Error ? e.message : String(e)));

  const loadProviderOptions = async (opts: { force?: boolean; quiet?: boolean } = {}) => {
    if (options.loading) return;
    if (options.loaded && !opts.force) return;
    setOptions((prev) => ({ ...prev, loading: true, error: opts.quiet ? prev.error : "" }));
    try {
      const [nextAvailable, nextAuthMethods] = await Promise.all([
        api.listAvailableProviders(),
        api.providerAuthMethods().catch(() => ({})),
      ]);
      setOptions({
        available: nextAvailable,
        authMethods: nextAuthMethods,
        loaded: true,
        loading: false,
        error: "",
      });
    } catch (e) {
      setOptions((prev) => ({
        ...prev,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  };

  useEffect(() => {
    void refreshCatalog();
    void loadProviderOptions({ quiet: true });
  }, []);

  const closeReconfigure = (id: string) =>
    setReconfiguring((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  const toggleReconfigure = (id: string) =>
    setReconfiguring((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const handleAddProvider = async (id: string) => {
    const picked = options.available.find((p) => p.id === id);
    setError("");
    try {
      await api.addProvider(id, picked?.name);
      setOptions((prev) => ({ ...prev, available: prev.available.filter((p) => p.id !== id) }));
      setModelProviderExpanded(id, true);
      await refreshCatalog();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRemoveProvider = async (p: ProviderCatalogDto) => {
    setError("");
    try {
      if (p.origin === "custom" && p.editable !== false) {
        const ok = await confirmAlert(
          tr("settings.modelspage.removeCustomConfirm", { name: p.name }),
          { title: tr("settings.modelspage.removeProvider"), confirmLabel: tr("common.remove") },
        );
        if (!ok) return;
        await api.removeCustomProvider(p.id);
      } else {
        await api.removeProvider(p.id);
      }
      await refreshCatalog();
      if (options.loaded) {
        await api.listAvailableProviders()
          .then((available) => setOptions((prev) => ({ ...prev, available })))
          .catch(() => {});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const publish = (catalog: ProviderCatalogDto[]) => {
    setProviders(catalog);
    const enabled = catalog.flatMap((provider) => provider.enabled
      ? provider.models.filter((model) => model.enabled && model.connected).map((model) => ({
          providerID: model.providerID,
          modelID: model.modelID,
          name: model.name,
          ...(model.providerName ? { providerName: model.providerName } : {}),
          ...(model.context !== undefined ? { context: model.context } : {}),
          ...(model.cost ? { cost: model.cost } : {}),
          ...(model.capabilities ? { capabilities: model.capabilities } : {}),
          ...(model.variants ? { variants: model.variants } : {}),
          connected: model.connected,
        }))
      : []);
    setModels(enabled);
  };

  const reconcile = (catalog: ProviderCatalogDto[], state: VisibilityStateDto) =>
    catalog.map((provider) => {
      const providerEnabled = !state.disabledProviders.includes(provider.id);
      return {
        ...provider,
        enabled: providerEnabled,
        status: overlayStatus(provider, providerEnabled),
        models: provider.models.map((model) => ({
          ...model,
          enabled: providerEnabled && !state.disabledModels.includes(model.key),
        })),
      };
    });

  const mutate = async (
    key: string,
    optimistic: (catalog: ProviderCatalogDto[]) => ProviderCatalogDto[],
    fn: () => Promise<VisibilityStateDto>,
  ) => {
    if (!providers) return;
    const before = providers;
    publish(optimistic(before));
    setBusyKey(key);
    setError("");
    try {
      publish(reconcile(before, await fn()));
    } catch (e) {
      publish(before);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey("");
    }
  };

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError("");
    try {
      publish(await api.refreshProviders());
      await loadProviderOptions({ force: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const shown = useMemo(
    () => (providers ? orderProviders(providers, prefs) : []),
    [providers, prefs],
  );

  if (providers === null && !error) {
    return <div className="models-page"><PageHead title={tr("settings.modelspage.providersModels")} /><EmptyState title={tr("settings.modelspage.loadingCatalog")} busy /></div>;
  }

  const editing = customOpen?.id ? providers?.find((p) => p.id === customOpen.id) : undefined;

  return (
    <div className="models-page">
      <PageHead
        title={tr("settings.modelspage.providersModels")}
        blurb={tr("settings.modelspage.whatTheModelPickerOffersTogglesAre")}
      />
      <div className="models-toolbar" data-settings-item="models.catalog">
        <IconButton
          className="models-refresh"
          icon={RefreshIcon}
          size="sm"
          label={tr("common.refresh")}
          busy={refreshing}
          disabled={refreshing}
          onClick={() => void handleRefresh()}
        />
        <Picker
          className="models-add-provider"
          label={tr("settings.modelspage.addProvider")}
          ariaLabel={tr("settings.modelspage.addProvider")}
          triggerIcon={<Icon icon={AddIcon} size="sm" />}
          onOpen={() => void loadProviderOptions()}
          items={options.available.map((p) => ({
            id: p.id,
            label: p.name,
            group: "",
            ...(options.authMethods[p.id]?.some((m) => m.type === "oauth") ? { detail: tr("settings.modelspage.oauthMethod") } : {}),
          }))}
          onPick={(id) => void handleAddProvider(id)}
          placeholder={tr("settings.modelspage.addProvider")}
          searchPlaceholder={tr("settings.modelspage.searchProviders")}
          emptyMessage={options.error
            ? tr("settings.modelspage.catalogueFailed")
            : options.loaded && options.available.length === 0
              ? tr("settings.modelspage.allBuiltinsAdded")
              : options.loading
                ? tr("settings.modelspage.loadingCatalog")
                : undefined}
          emptyAction={options.error
            ? { label: tr("common.retry"), run: () => void loadProviderOptions({ force: true }) }
            : undefined}
          footerAction={{
            label: tr("settings.modelspage.customProvider"),
            run: () => setCustomOpen({}),
          }}
        />
      </div>

      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="provider-list">
        {shown.map((p, index) => {
          const enabledCount = p.models.filter((m) => m.enabled).length;
          const expanded = prefs.expandedProviders.includes(p.id);
          const status = statusLabel(p.status);
          const query = modelQuery[p.id] ?? "";
          const visibleModels = filterProviderModels(p.models, query);
          const customOwned = p.origin === "custom" && p.editable !== false;
          const externalCustom = p.origin === "externally-configured";
          return (
            <div
              key={p.id}
              className={`provider-card ${p.enabled ? "" : "provider-disabled"}`}
              draggable
              onDragStart={() => setDraggedProvider(p.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (draggedProvider) {
                  reorderModelProviders(shown.map((provider) => provider.id), draggedProvider, p.id);
                }
                setDraggedProvider(null);
              }}
            >
              <div className="provider-head">
                <button
                  className="provider-expand"
                  aria-expanded={expanded}
                  aria-label={expanded
                    ? tr("settings.modelspage.collapseValue", { value: p.name })
                    : tr("settings.modelspage.expandValue", { value: p.name })}
                  onClick={() => {
                    if (p.models.length === 0) void loadProviderOptions();
                    setModelProviderExpanded(p.id, !expanded);
                  }}
                >
                  <span className="provider-drag" aria-hidden="true">⠿</span>
                  <span className={`provider-chevron ${expanded ? "open" : ""}`} aria-hidden="true">›</span>
                  <ProviderLogo providerID={p.id} providerName={p.name} className="set-provider-logo" />
                  <span className="provider-name">{p.name}</span>
                  {status && (
                    <Badge tone={status.tone} className="provider-status">{status.text}</Badge>
                  )}
                  <span className="provider-count mono">{enabledCount}/{p.models.length}</span>
                </button>
                <MoveControls
                  label={p.name}
                  index={index}
                  count={shown.length}
                  onMove={(nextIndex) => {
                    const target = shown[nextIndex];
                    if (target) reorderModelProviders(shown.map((provider) => provider.id), p.id, target.id);
                  }}
                />
                <Toggle
                  on={p.enabled}
                  label={tr("settings.modelspage.valueProviderValue", {
                    value: p.enabled ? tr("settings.pages.disable") : tr("settings.pages.enable"),
                    name: p.name,
                  })}
                  onChange={(on) => void mutate(
                    p.id,
                    (catalog) => catalog.map((provider) => provider.id === p.id
                      ? {
                          ...provider,
                          enabled: on,
                          status: overlayStatus(provider, on),
                          models: on
                            ? provider.models
                            : provider.models.map((model) => ({ ...model, enabled: false })),
                        }
                      : provider),
                    () => api.setProviderEnabled(p.id, on),
                  )}
                />
              </div>
              {expanded && (
                <div className="provider-models">
                  {p.models.length > 0 && (
                    <TextInput
                      className={`provider-model-filter${p.models.length < 6 ? " provider-model-filter--quiet" : ""}`}
                      value={query}
                      placeholder={tr("settings.modelspage.filterProviderModels", { name: p.name })}
                      aria-label={tr("settings.modelspage.filterProviderModels", { name: p.name })}
                      onChange={(e) => setModelQuery((prev) => ({ ...prev, [p.id]: e.target.value }))}
                    />
                  )}
                  {p.models.length === 0 && (
                    <p className="provider-empty-models">{tr("settings.modelspage.noModelsYet")}</p>
                  )}
                  {query.trim() && visibleModels.length === 0 && p.models.length > 0 && (
                    <p className="provider-empty-models">{tr("settings.modelspage.noMatches")}</p>
                  )}
                  {visibleModels.map((m) => {
                    const fav = isFavorite(prefs, m.key);
                    const displayName = modelDisplayName(m, catalogModels);
                    return (
                      <div key={m.key} className={`set-model-row ${m.enabled ? "" : "model-disabled"}`}>
                        <IconButton
                          icon={FavoriteIcon}
                          size="sm"
                          variant="ghost"
                          className={`model-star-btn ${fav ? "on" : ""}`}
                          pressed={fav}
                          label={fav ? tr("settings.modelspage.removeFavorite") : tr("settings.modelspage.addFavorite")}
                          onClick={() => toggleModelFavorite(m.key)}
                        />
                        <span className="set-model-name" title={displayName}>{displayName}</span>
                        {m.context !== undefined && <span className="set-model-ctx mono">{fmtContext(m.context)}</span>}
                        <span className="set-model-meta mono">{m.key}</span>
                        <Switch
                          checked={m.enabled}
                          label={!p.enabled
                            ? tr("settings.modelspage.enableTheProviderFirst")
                            : m.enabled
                            ? tr("settings.modelspage.disableValue", { value: displayName })
                            : tr("settings.modelspage.enableValue", { value: displayName })}
                          disabled={busyKey === m.key || !p.enabled}
                          onChange={(on) => void mutate(
                            m.key,
                            (catalog) => catalog.map((provider) => provider.id === p.id
                              ? { ...provider, models: provider.models.map((model) => model.key === m.key ? { ...model, enabled: on } : model) }
                              : provider),
                            () => api.setModelEnabled(m.key, on),
                          )}
                        />
                      </div>
                    );
                  })}
                  {customOwned && (
                    <div className="provider-connect-toggle">
                      <Button size="sm" variant="ghost" onClick={() => setCustomOpen({ id: p.id })}>
                        {tr("settings.modelspage.providerSettings")}
                      </Button>
                    </div>
                  )}
                  {externalCustom && (
                    <p className="provider-configured-outside">{tr("settings.modelspage.configuredOutsideHint")}</p>
                  )}
                  {(p.origin !== "custom" || externalCustom) && p.models.length === 0 && (
                    <ProviderConnect
                      providerId={p.id}
                      methods={options.authMethods[p.id]}
                      onConnected={() => void refreshCatalog()}
                    />
                  )}
                  {(p.origin !== "custom" || externalCustom) && p.models.length > 0 && (
                    <div className="provider-connect-toggle">
                      <Button size="sm" variant="ghost" onClick={() => {
                        void loadProviderOptions();
                        toggleReconfigure(p.id);
                      }}>
                        {tr("settings.modelspage.connectionSettings")}
                      </Button>
                    </div>
                  )}
                  {(p.origin !== "custom" || externalCustom) && p.models.length > 0 && reconfiguring.has(p.id) && (
                    <ProviderConnect
                      providerId={p.id}
                      methods={options.authMethods[p.id]}
                      onConnected={() => { void refreshCatalog(); }}
                      onDisconnect={() => { void refreshCatalog(); closeReconfigure(p.id); }}
                    />
                  )}
                  {p.removable !== false && (
                    <div className="provider-connect-toggle">
                      <Button size="sm" variant="ghost" onClick={() => void handleRemoveProvider(p)}>
                        {tr("settings.modelspage.removeProvider")}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {providers?.length === 0 && (
          <EmptyState
            title={tr("settings.modelspage.noModelsAvailable")}
            body={tr("settings.modelspage.checkThatTheBackendIsRunningAnd")}
          />
        )}
      </div>
      {customOpen && (
        <CustomProviderDialog
          existing={editing
            ? {
                id: editing.id,
                name: editing.name,
                baseURL: editing.custom?.baseURL ?? "",
                protocol: editing.custom?.protocol ?? "openai-compatible",
                authMode: editing.custom?.authMode ?? "api-key",
                headerNames: editing.custom?.headerNames,
                modelIDs: editing.custom?.modelIDs
                  ?? editing.models.filter((model) => !model.connected).map((model) => model.modelID),
                readOnly: editing.editable === false || editing.origin === "externally-configured",
              }
            : undefined}
          onClose={() => setCustomOpen(null)}
          onSaved={(id) => {
            setModelProviderExpanded(id, true);
            void refreshCatalog();
          }}
        />
      )}
    </div>
  );
}
