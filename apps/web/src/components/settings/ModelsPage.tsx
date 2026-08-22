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
} from "../../modelPrefs.ts";
import { setModels, useStore } from "../../store.ts";
import { providerColor } from "../../format.ts";
import { api, type ProviderCatalogDto, type VisibilityStateDto } from "../../api.ts";
import { EmptyState, PageHead, Seg, Toggle } from "./parts.tsx";
import { modelDisplayName } from "../../composer/discovery.ts";

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
  const [scope, setScope] = useState<Scope>("connected");
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [draggedProvider, setDraggedProvider] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState("");
  const catalogModels = useMemo(
    () => providers?.flatMap((provider) => provider.models) ?? [],
    [providers],
  );

  const refreshCatalog = () =>
    api.listProviders().then(setProviders).catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => { void refreshCatalog(); }, []);

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
    return <><PageHead title="Providers & Models" /><EmptyState title="Loading catalog…" /></>;
  }
  if (providers !== null && providers.length === 0) {
    return (
      <>
        <PageHead title="Providers & Models" />
        <EmptyState title="No models available" body="Check that the backend is running and configured with providers." />
      </>
    );
  }

  const chipProviders = (providers ?? []).filter((p) => (scope === "connected" ? p.connected : true));

  return (
    <>
      <PageHead
        title="Providers & Models"
        blurb="What the model picker offers. Toggles are written to the OpenCode config (disabled providers and per-provider blacklists), so every client sees the same catalog."
      />
      <div className="models-toolbar" data-settings-item="models.catalog">
        <input
          className="set-search models-search"
          value={q}
          placeholder="Search models…"
          aria-label="Search models"
          onChange={(e) => setQ(e.target.value)}
        />
        <Seg value={scope} options={[["connected", "Connected"], ["all", "All"]]} onChange={setScope} />
      </div>

      <div className="provider-chips" role="group" aria-label="Filter by provider">
        <button
          className={`chip provider-chip ${providerFilter === null ? "on" : ""}`}
          aria-pressed={providerFilter === null}
          onClick={() => setProviderFilter(null)}
        >
          All providers
        </button>
        {chipProviders.map((p) => (
          <button
            key={p.id}
            className={`chip provider-chip ${providerFilter === p.id ? "on" : ""} ${p.enabled ? "" : "chip-off"}`}
            aria-pressed={providerFilter === p.id}
            onClick={() => setProviderFilter(providerFilter === p.id ? null : p.id)}
          >
            <span className="set-model-dot" style={{ background: providerColor(p.id) }} />
            {p.name}
          </button>
        ))}
      </div>

      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="provider-list">
        {shown.map((p) => {
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
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${p.name}`}
                  onClick={() => setModelProviderExpanded(p.id, !expanded)}
                >
                  <span className="provider-drag" aria-hidden="true">⠿</span>
                  <span className={`provider-chevron ${expanded ? "open" : ""}`} aria-hidden="true">›</span>
                  <span className="set-model-dot" style={{ background: providerColor(p.id) }} />
                  <span className="provider-name">{p.name}</span>
                  {!p.connected && <span className="tag provider-tag">not connected</span>}
                  <span className="provider-count mono">{enabledCount}/{p.models.length}</span>
                </button>
                <Toggle
                  on={p.enabled}
                  label={`${p.enabled ? "Disable" : "Enable"} provider ${p.name}`}
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
                  {p.models.map((m) => {
                    const fav = isFavorite(prefs, m.key);
                    const displayName = modelDisplayName(m, catalogModels);
                    return (
                      <div key={m.key} className={`set-model-row ${m.enabled ? "" : "model-disabled"}`}>
                        <button
                          className={`star-btn ${fav ? "on" : ""}`}
                          title={fav ? "Remove favorite" : "Add favorite"}
                          aria-pressed={fav}
                          onClick={() => toggleModelFavorite(m.key)}
                        >{fav ? "★" : "☆"}</button>
                        <span className="set-model-name" title={displayName}>{displayName}</span>
                        {m.context !== undefined && <span className="set-model-ctx mono">{fmtContext(m.context)}</span>}
                        <span className="set-model-meta mono">{m.key}</span>
                        <button
                          className="switch switch-sm"
                          role="switch"
                          aria-checked={m.enabled}
                          aria-label={`${m.enabled ? "Disable" : "Enable"} ${displayName}`}
                          disabled={busyKey === m.key || !p.enabled}
                          title={!p.enabled ? "Enable the provider first" : m.enabled ? "Disable model" : "Enable model"}
                          onClick={() => void mutate(
                            m.key,
                            (catalog) => catalog.map((provider) => provider.id === p.id
                              ? { ...provider, models: provider.models.map((model) => model.key === m.key ? { ...model, enabled: !m.enabled } : model) }
                              : provider),
                            () => api.setModelEnabled(m.key, !m.enabled),
                          )}
                        >
                          <i />
                        </button>
                      </div>
                    );
                  })}
                  {p.models.length === 0 && <div className="muted" style={{ fontSize: 12, padding: "4px 8px" }}>No matches in this provider.</div>}
                </div>
              )}
            </div>
          );
        })}
        {shown.length === 0 && <EmptyState title="No matches" body="Try the All scope or clear the search." />}
      </div>
    </>
  );
}
