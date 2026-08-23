import { useMemo, useRef, useState } from "react";
import type { ModelDescriptor, ModelRef } from "@polyth/contracts";
import { isFavorite, modelKey, orderProviders } from "@polyth/models";
import {
  reorderModelProviders,
  setModelProviderExpanded,
  toggleModelFavorite,
  useModelPrefs,
} from "../modelPrefs.ts";
import { useEscape } from "../useEscape.ts";

export function modelModalities(model: ModelDescriptor): string {
  const modalities = (model.capabilities ?? [])
    .filter((capability) =>
      (capability.startsWith("input:") || capability.startsWith("output:"))
      && !capability.endsWith(":none"))
    .map((capability) => capability.slice(capability.indexOf(":") + 1));
  return modalities.length > 0
    ? [...new Set(modalities)].map((value) => value[0]!.toUpperCase() + value.slice(1)).join(", ")
    : "Text";
}

export function modelContextLabel(context?: number): string {
  if (!context) return "Context unknown";
  if (context >= 1_000_000) return `${Number((context / 1_000_000).toFixed(1))}m context`;
  if (context >= 1_000) return `${Math.round(context / 1_000)}k context`;
  return `${context} context`;
}

export function modelSupportsThinking(model: ModelDescriptor | undefined): boolean {
  return (model?.variants?.length ?? 0) > 0;
}

interface ModelPickerProps {
  models: ModelDescriptor[];
  value?: ModelRef;
  recommended?: ModelRef;
  onPick: (model?: ModelRef) => void;
  direction?: "up" | "down";
}

export default function ModelPicker({
  models,
  value,
  recommended,
  onPick,
  direction = "up",
}: ModelPickerProps) {
  const prefs = useModelPrefs();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draggedProvider, setDraggedProvider] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEscape(open, () => {
    setOpen(false);
    triggerRef.current?.focus();
  });

  const current = value
    ? models.find((model) => model.providerID === value.providerID && model.modelID === value.modelID)
    : undefined;
  const fallback = recommended
    ? models.find((model) =>
        model.providerID === recommended.providerID && model.modelID === recommended.modelID)
    : undefined;
  const label = current?.name ?? fallback?.name ?? "Auto";
  const q = query.trim().toLowerCase();
  const filtered = models.filter((model) =>
    !q || [model.name, model.modelID, model.providerID, model.providerName ?? ""]
      .some((text) => text.toLowerCase().includes(q)));

  const providers = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; models: ModelDescriptor[] }>();
    for (const model of filtered) {
      const provider = byId.get(model.providerID) ?? {
        id: model.providerID,
        name: model.providerName ?? model.providerID,
        models: [],
      };
      provider.models.push(model);
      byId.set(model.providerID, provider);
    }
    return orderProviders([...byId.values()], prefs);
  }, [filtered, prefs]);
  const providerIds = providers.map((provider) => provider.id);
  const favorites = filtered.filter((model) => isFavorite(prefs, modelKey(model)));

  const choose = (model?: ModelDescriptor) => {
    onPick(model ? { providerID: model.providerID, modelID: model.modelID } : undefined);
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  };
  const row = (model: ModelDescriptor) => {
    const selected = current
      ? current.providerID === model.providerID && current.modelID === model.modelID
      : false;
    const favorite = isFavorite(prefs, modelKey(model));
    return (
      <div
        key={modelKey(model)}
        className={`model-picker-row${selected ? " current" : ""}`}
        role="option"
        aria-selected={selected}
        tabIndex={0}
        onClick={() => choose(model)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          choose(model);
        }}
      >
        <span className="model-picker-check" aria-hidden="true">{selected ? "✓" : ""}</span>
        <span className="model-picker-copy">
          <strong>{model.name}</strong>
          <small>{modelModalities(model)} · {modelContextLabel(model.context)}</small>
        </span>
        <button
          className={`star-btn${favorite ? " on" : ""}`}
          title={favorite ? "Remove favorite" : "Add favorite"}
          aria-label={`${favorite ? "Remove" : "Add"} ${model.name} ${favorite ? "from" : "to"} favorites`}
          aria-pressed={favorite}
          onClick={(event) => {
            event.stopPropagation();
            toggleModelFavorite(modelKey(model));
          }}
        >{favorite ? "★" : "☆"}</button>
      </div>
    );
  };

  return (
    <span className="picker picker-model model-picker">
      <button
        ref={triggerRef}
        className="chip picker-chip model-picker-trigger"
        type="button"
        title={`Select model, current ${label}`}
        aria-label={`Select model, current ${label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((valueOpen) => !valueOpen)}
      >
        <span className="model-trigger-copy">
          <small>Model</small>
          <strong className="picker-chip-text">{label}</strong>
        </span>
        {(current ?? fallback) && (
          <span className="model-trigger-meta">
            {modelModalities(current ?? fallback!)} · {modelContextLabel((current ?? fallback)?.context)}
          </span>
        )}
        <span className="picker-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className={`picker-pop model-picker-pop ${direction}`}>
            <input
              autoFocus
              value={query}
              placeholder="Search models…"
              aria-label="Filter models"
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="model-picker-list" role="listbox" aria-label="Models">
              <div className="model-picker-row model-picker-auto" role="option" aria-selected={!current} onClick={() => choose()}>
                <span className="model-picker-check" aria-hidden="true">{!current ? "✓" : ""}</span>
                <span className="model-picker-copy"><strong>Auto</strong><small>Workspace default</small></span>
              </div>
              {favorites.length > 0 && (
                <section className="model-provider-section favorites">
                  <div className="model-provider-head static"><span>★</span><strong>Favorites</strong><small>{favorites.length}</small></div>
                  <div>{favorites.map(row)}</div>
                </section>
              )}
              {providers.map((provider) => {
                const expanded = q.length > 0 || prefs.expandedProviders.includes(provider.id);
                const items = provider.models.filter((model) => !isFavorite(prefs, modelKey(model)));
                if (items.length === 0) return null;
                return (
                  <section
                    className="model-provider-section"
                    key={provider.id}
                    draggable={!q}
                    onDragStart={() => setDraggedProvider(provider.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (draggedProvider) reorderModelProviders(providerIds, draggedProvider, provider.id);
                      setDraggedProvider(null);
                    }}
                  >
                    <button
                      className="model-provider-head"
                      aria-expanded={expanded}
                      onClick={() => setModelProviderExpanded(provider.id, !expanded)}
                    >
                      <span className="model-provider-grip" aria-hidden="true">⠿</span>
                      <strong>{provider.name}</strong>
                      <small>{items.length}</small>
                      <span aria-hidden="true">{expanded ? "⌄" : "›"}</span>
                    </button>
                    {expanded && <div>{items.map(row)}</div>}
                  </section>
                );
              })}
              {filtered.length === 0 && <div className="palette-empty">No models found</div>}
            </div>
          </div>
        </>
      )}
    </span>
  );
}
