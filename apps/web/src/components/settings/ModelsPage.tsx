// Providers & Models: the OpenCode-truth catalog. Accordion per provider with
// enable/disable at both levels (mirrored into opencode.json server-side),
// search, provider filter chips, and a Connected/All scope. Favorites (star)
// still feed the composer picker ordering. Every toggle refreshes the model
// list in the store so the composer picker updates immediately.
import { useEffect, useMemo, useState } from "react";
import { isFavorite, modelKey } from "@polyth/models";
import { toggleModelFavorite, useModelPrefs } from "../../modelPrefs.ts";
import { setModels, updateSettings, useStore } from "../../store.ts";
import { providerColor } from "../../format.ts";
import { formatModelRef } from "../../settings.ts";
import { api, type ProviderCatalogDto } from "../../api.ts";
import { EmptyState, PageHead, Row, Seg, Toggle } from "./parts.tsx";

type Scope = "connected" | "all";

function fmtContext(context?: number): string {
  if (!context) return "";
  return context >= 1000 ? `${Math.round(context / 1000)}k ctx` : `${context} ctx`;
}

export default function ModelsPage() {
  const models = useStore((s) => s.models);
  const settings = useStore((s) => s.settings);
  const prefs = useModelPrefs();
  const [providers, setProviders] = useState<ProviderCatalogDto[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>("connected");
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busyKey, setBusyKey] = useState("");

  const refreshCatalog = () =>
    api.listProviders().then(setProviders).catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => { void refreshCatalog(); }, []);

  /** Server toggle + immediate composer refresh (picker only lists enabled). */
  const mutate = async (key: string, fn: () => Promise<unknown>) => {
    setBusyKey(key);
    setError("");
    try {
      await fn();
      await refreshCatalog();
      setModels(await api.listModels());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey("");
    }
  };

  const query = q.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!providers) return [];
    return providers
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
      .filter((p) => p.models.length > 0 || !query);
  }, [providers, scope, providerFilter, query]);

  // Search auto-expands so hits are visible without clicking each provider.
  const isOpen = (id: string) => (query ? true : open[id] ?? false);

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
      <Row label="Default model" hint="Used when a session has not selected a model." itemId="models.default">
        <select value={settings.defaultModel} onChange={(e) => updateSettings({ defaultModel: e.target.value })}>
          <option value="">Server default</option>
          {models.map((model) => (
            <option key={modelKey(model)} value={formatModelRef(model)}>
              {model.providerID} / {model.name || model.modelID}
            </option>
          ))}
        </select>
      </Row>

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
            <div key={p.id} className={`provider-card ${p.enabled ? "" : "provider-disabled"}`}>
              <div className="provider-head">
                <button
                  className="provider-expand"
                  aria-expanded={expanded}
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${p.name}`}
                  onClick={() => setOpen((o) => ({ ...o, [p.id]: !expanded }))}
                >
                  <span className={`provider-chevron ${expanded ? "open" : ""}`} aria-hidden="true">›</span>
                  <span className="set-model-dot" style={{ background: providerColor(p.id) }} />
                  <span className="provider-name">{p.name}</span>
                  {!p.connected && <span className="tag provider-tag">not connected</span>}
                  <span className="provider-count mono">{enabledCount}/{p.models.length}</span>
                </button>
                <Toggle
                  on={p.enabled}
                  label={`${p.enabled ? "Disable" : "Enable"} provider ${p.name}`}
                  onChange={(on) => void mutate(p.id, () => api.setProviderEnabled(p.id, on))}
                />
              </div>
              {expanded && (
                <div className="provider-models">
                  {p.models.map((m) => {
                    const fav = isFavorite(prefs, m.key);
                    return (
                      <div key={m.key} className={`set-model-row ${m.enabled ? "" : "model-disabled"}`}>
                        <button
                          className={`star-btn ${fav ? "on" : ""}`}
                          title={fav ? "Remove favorite" : "Add favorite"}
                          aria-pressed={fav}
                          onClick={() => toggleModelFavorite(m.key)}
                        >{fav ? "★" : "☆"}</button>
                        <span className="set-model-name">{m.name}</span>
                        {m.context !== undefined && <span className="set-model-ctx mono">{fmtContext(m.context)}</span>}
                        <span className="set-model-meta mono">{m.key}</span>
                        <button
                          className="switch switch-sm"
                          role="switch"
                          aria-checked={m.enabled}
                          aria-label={`${m.enabled ? "Disable" : "Enable"} ${m.name}`}
                          disabled={busyKey === m.key || !p.enabled}
                          title={!p.enabled ? "Enable the provider first" : m.enabled ? "Disable model" : "Enable model"}
                          onClick={() => void mutate(m.key, () => api.setModelEnabled(m.key, !m.enabled))}
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
