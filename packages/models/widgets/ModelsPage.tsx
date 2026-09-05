// Providers & Models: the OpenCode-truth catalog. Accordion per provider with
// enable/disable at both levels (mirrored into opencode.json server-side),
// search, provider filter chips, and a Connected/All scope. Favorites (star)
// still feed the composer picker ordering. Every toggle refreshes the model
// list in the store so the composer picker updates immediately.
import { useEffect, useMemo, useState } from "react";
import { isFavorite, modelKey, orderProviders } from "@polyth/models";
import {
  reorderModelProviders,
  setModelProviderExpanded,
  toggleModelFavorite,
  useModelPrefs,
} from "./modelPrefs.ts";
import { setModels, useStore } from "../../../apps/web/src/store.ts";
import {
  api,
  type AvailableProviderDto,
  type ProviderAuthMethodDto,
  type ProviderCatalogDto,
  type VisibilityStateDto,
} from "@polyth/session/web-api";
import { EmptyState, PageHead, Seg, Toggle } from "../../../apps/web/src/components/settings/parts.tsx";
import { modelDisplayName } from "../../../apps/web/src/composer/discovery.ts";
import Picker from "../../../apps/web/src/components/Picker.tsx";
import ProviderConnect from "./ProviderConnect.tsx";
import ProviderLogo from "./ProviderLogo.tsx";
import MoveControls from "../../../apps/web/src/components/MoveControls.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { AddIcon, Button, FavoriteIcon, Icon, IconButton, Switch, TextInput } from "../../../apps/web/src/components/ui/index.ts";

type Scope = "connected" | "all";

function fmtContext(context?: number): string {
  if (!context) return "";
  return context >= 1000 ? `${Math.round(context / 1000)}k ctx` : `${context} ctx`;
}

export default function ModelsPage() {
  const models = useStore((s) => s.models);
  const prefs = useModelPrefs();
  const [providers, setProviders] = useState<ProviderCatalogDto[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [draggedProvider, setDraggedProvider] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState("");
  const [available, setAvailable] = useState<AvailableProviderDto[]>([]);
  const [authMethods, setAuthMethods] = useState<Record<string, ProviderAuthMethodDto[]>>({});
  const [providerOptionsLoaded, setProviderOptionsLoaded] = useState(false);
  const [providerOptionsLoading, setProviderOptionsLoading] = useState(false);
  const [reconfiguring, setReconfiguring] = useState<ReadonlySet<string>>(new Set());
  const catalogModels = useMemo(
    () => providers?.flatMap((provider) => provider.models) ?? [],
    [providers],
  );

  const refreshCatalog = () =>
    api.listProviders().then(setProviders).catch((e) => setError(e instanceof Error ? e.message : String(e)));

  const loadProviderOptions = async () => {
    if (providerOptionsLoaded || providerOptionsLoading) return;
    setProviderOptionsLoading(true);
    setError("");
    try {
      const [nextAvailable, nextAuthMethods] = await Promise.all([
        api.listAvailableProviders(),
        api.providerAuthMethods().catch(() => ({})),
      ]);
      setAvailable(nextAvailable);
      setAuthMethods(nextAuthMethods);
      setProviderOptionsLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProviderOptionsLoading(false);
    }
  };

  useEffect(() => { void refreshCatalog(); }, []);

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
    const picked = available.find((p) => p.id === id);
    setError("");
    try {
      await api.addProvider(id, picked?.name);
      setAvailable((prev) => prev.filter((p) => p.id !== id));
      setModelProviderExpanded(id, true);
      await refreshCatalog();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleRemoveProvider = async (id: string) => {
    setError("");
    try {
      await api.removeProvider(id);
      await refreshCatalog();
      if (providerOptionsLoaded) await api.listAvailableProviders().then(setAvailable).catch(() => {});
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
        models: provider.models.map((model) => ({
          ...model,
          enabled: providerEnabled && !state.disabledModels.includes(model.key),
        })),
      };
    });

  /** Optimistic UI; the response only reconciles visibility flags and never
   * re-runs OpenCode's expensive provider discovery endpoint. */
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

  const query = q.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!providers) return [];
    return orderProviders(providers
      .filter((p) => (scope === "connected" ? p.connected : true))
      .filter((p) => (providerFilter ? p.id === providerFilter : true))
      .map((p) => ({
        ...p,
        models: query
          ? p.models.filter((m) =>
              m.name.toLowerCase().includes(query)
              || m.key.toLowerCase().includes(query)
              || p.name.toLowerCase().includes(query))
          : p.models,
      }))
      .filter((p) => p.models.length > 0 || !query), prefs);
  }, [providers, scope, providerFilter, query, prefs]);

  // Search auto-expands so hits are visible without clicking each provider.
  const isOpen = (id: string) => query.length > 0 || prefs.expandedProviders.includes(id);

  if (providers === null && !error) {
    return <div className="models-page"><PageHead title={tr("settings.modelspage.providersModels")} /><EmptyState title={tr("settings.modelspage.loadingCatalog")} busy /></div>;
  }
  const chipProviders = (providers ?? []).filter((p) => (scope === "connected" ? p.connected : true));

  return (
    <div className="models-page">
      <PageHead
        title={tr("settings.modelspage.providersModels")}
        blurb={tr("settings.modelspage.whatTheModelPickerOffersTogglesAre")}
      />
      <div className="models-toolbar" data-settings-item="models.catalog">
        <TextInput
          className="models-search"
          value={q}
          placeholder={tr("settings.modelspage.searchModels")}
          aria-label={tr("settings.modelspage.searchModels2")}
          onChange={(e) => setQ(e.target.value)}
        />
        <Seg value={scope} options={[
          ["connected", tr("sidebar.connected")],
          ["all", tr("importsessionsdialog.all")],
        ]} onChange={setScope} />
        <Picker
          className="models-add-provider"
          label={tr("settings.modelspage.addProvider")}
          ariaLabel={tr("settings.modelspage.addProvider")}
          triggerIcon={<Icon icon={AddIcon} size="sm" />}
          onOpen={() => void loadProviderOptions()}
          items={available.map((p) => ({
            id: p.id,
            label: p.name,
            group: "",
            ...(authMethods[p.id]?.some((m) => m.type === "oauth") ? { detail: tr("settings.modelspage.oauthMethod") } : {}),
          }))}
          onPick={(id) => void handleAddProvider(id)}
          placeholder={providerOptionsLoading
            ? tr("settings.modelspage.loadingCatalog")
            : available.length === 0 ? tr("settings.modelspage.noProvidersToAdd") : tr("settings.modelspage.addProvider")}
          disabled={providerOptionsLoaded && available.length === 0}
        />
      </div>

      <div className="provider-chips ui-scroll-tabs" role="group" aria-label={tr("settings.modelspage.filterByProvider")}>
        <button
          className={`chip provider-chip ${providerFilter === null ? "on" : ""}`}
          aria-pressed={providerFilter === null}
          onClick={() => setProviderFilter(null)}
        >
          {tr("settings.modelspage.allProviders")}</button>
        {chipProviders.map((p) => (
          <button
            key={p.id}
            className={`chip provider-chip ${providerFilter === p.id ? "on" : ""} ${p.enabled ? "" : "chip-off"}`}
            aria-pressed={providerFilter === p.id}
            onClick={() => setProviderFilter(providerFilter === p.id ? null : p.id)}
          >
            <ProviderLogo providerID={p.id} providerName={p.name} className="set-provider-logo" />
            {p.name}
          </button>
        ))}
      </div>

      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="provider-list">
        {shown.map((p, index) => {
          const enabledCount = p.models.filter((m) => m.enabled).length;
          const expanded = isOpen(p.id);
          return (
            <div
              key={p.id}
              className={`provider-card ${p.enabled ? "" : "provider-disabled"}`}
              draggable={!query}
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
                  {!p.connected && <span className="tag provider-tag">{tr("settings.modelspage.notConnected")}</span>}
                  <span className="provider-count mono">{enabledCount}/{p.models.length}</span>
                </button>
                {!query && (
                  <MoveControls
                    label={p.name}
                    index={index}
                    count={shown.length}
                    onMove={(nextIndex) => {
                      const target = shown[nextIndex];
                      if (target) reorderModelProviders(shown.map((provider) => provider.id), p.id, target.id);
                    }}
                  />
                )}
                <Toggle
                  on={p.enabled}
                  label={tr("settings.modelspage.valueProviderValue", {
                    value: p.enabled ? tr("settings.pages.disable") : tr("settings.pages.enable"),
                    name: p.name,
                  })}
                  onChange={(on) => void mutate(
                    p.id,
                    (catalog) => catalog.map((provider) => provider.id === p.id
                      ? { ...provider, enabled: on, models: provider.models.map((model) => ({ ...model, enabled: on })) }
                      : provider),
                    () => api.setProviderEnabled(p.id, on),
                  )}
                />
              </div>
              {expanded && (
                <div className="provider-models">
                  {p.models.length === 0 && (
                    <>
                      <ProviderConnect
                        providerId={p.id}
                        methods={authMethods[p.id]}
                        onConnected={() => void refreshCatalog()}
                      />
                      <div className="provider-connect-toggle">
                        <Button size="sm" variant="ghost" onClick={() => void handleRemoveProvider(p.id)}>
                          {tr("settings.modelspage.removeProvider")}
                        </Button>
                      </div>
                    </>
                  )}
                  {p.models.map((m) => {
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
                          label={m.enabled
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
                  {p.models.length > 0 && (
                    <div className="provider-connect-toggle">
                      <Button size="sm" variant="ghost" onClick={() => {
                        void loadProviderOptions();
                        toggleReconfigure(p.id);
                      }}>
                        {tr("settings.modelspage.connectionSettings")}
                      </Button>
                    </div>
                  )}
                  {p.models.length > 0 && reconfiguring.has(p.id) && (
                    <ProviderConnect
                      providerId={p.id}
                      methods={authMethods[p.id]}
                      onConnected={() => { void refreshCatalog(); }}
                      onDisconnect={() => { void refreshCatalog(); closeReconfigure(p.id); }}
                    />
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
        {providers && providers.length > 0 && shown.length === 0 && (
          <EmptyState title={tr("settings.modelspage.noMatches")} body={tr("settings.modelspage.tryTheAllScopeOrClearThe")} />
        )}
      </div>
    </div>
  );
}
