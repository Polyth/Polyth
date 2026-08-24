import { useMemo, useRef, useState } from "react";
import type { ModelDescriptor, ModelRef } from "@polyth/contracts";
import { isFavorite, modelKey, orderProviders } from "@polyth/models";
import {
  reorderModelFavorites,
  reorderModelProviders,
  setModelProviderExpanded,
  toggleModelFavorite,
  useModelPrefs,
} from "../modelPrefs.ts";
import { useEscape } from "../useEscape.ts";
import { useShellMode } from "../responsiveShell.ts";
import { dismissKeyboard } from "../mobileViewport.ts";
import { tapFeedback } from "../haptics.ts";
import Sheet, { SheetRow, SheetSection } from "./mobile/Sheet.tsx";
import { Icon } from "../icons.tsx";

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

/** Modalities in a stable reading order, with the acronyms spelled properly.
 *  Reported capabilities only — nothing is inferred. */
const MODALITY_ORDER = ["text", "image", "audio", "video", "pdf"];

export function modelModalityLabels(model: ModelDescriptor): string[] {
  const raw = (model.capabilities ?? [])
    .filter((capability) =>
      (capability.startsWith("input:") || capability.startsWith("output:"))
      && !capability.endsWith(":none"))
    .map((capability) => capability.slice(capability.indexOf(":") + 1).toLowerCase());
  const unique = [...new Set(raw)];
  if (unique.length === 0) unique.push("text");
  unique.sort((a, b) => {
    const ra = MODALITY_ORDER.indexOf(a), rb = MODALITY_ORDER.indexOf(b);
    return (ra < 0 ? MODALITY_ORDER.length : ra) - (rb < 0 ? MODALITY_ORDER.length : rb)
      || a.localeCompare(b);
  });
  return unique.map((value) => value === "pdf" ? "PDF" : value[0]!.toUpperCase() + value.slice(1));
}

/** UX-MOBILE-01 §13/§40: one calm metadata line — `Text · Image · 500K` —
 *  instead of a mixed bag of glyphs. Reported capabilities only, no guesses. */
export function modelMetaLine(model?: ModelDescriptor): string {
  if (!model) return "";
  const modalities = modelModalityLabels(model);
  const context = model.context
    ? model.context >= 1_000_000
      ? `${Number((model.context / 1_000_000).toFixed(1))}M`
      : model.context >= 1_000
        ? `${Math.round(model.context / 1_000)}K`
        : String(model.context)
    : null;
  return [...modalities, ...(context ? [context] : [])].join(" · ");
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
  const phone = useShellMode() === "phone";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [draggedProvider, setDraggedProvider] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEscape(open && !phone, () => {
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
  const favoriteRank = new Map(prefs.favorites.map((key, index) => [key, index]));
  const favorites = filtered
    .filter((model) => isFavorite(prefs, modelKey(model)))
    .sort((a, b) => (favoriteRank.get(modelKey(a)) ?? 0) - (favoriteRank.get(modelKey(b)) ?? 0));

  const close = () => {
    setOpen(false);
    setQuery("");
    setEditing(false);
  };
  const choose = (model?: ModelDescriptor) => {
    if (phone) tapFeedback();
    onPick(model ? { providerID: model.providerID, modelID: model.modelID } : undefined);
    close();
    if (!phone) triggerRef.current?.focus();
  };
  const isSelected = (model: ModelDescriptor) => current
    ? current.providerID === model.providerID && current.modelID === model.modelID
    : false;

  // §22: tapping the model while typing dismisses the keyboard FIRST, then
  // opens the sheet — the picker can never end up under the keyboard.
  const toggleOpen = () => {
    if (open) {
      close();
      return;
    }
    if (phone) void dismissKeyboard().then(() => setOpen(true));
    else setOpen(true);
  };

  const star = (model: ModelDescriptor, variant: "row" | "sheet" = "row") => {
    const favorite = isFavorite(prefs, modelKey(model));
    return (
      <button
        className={`${variant === "sheet" ? "sheet-row-star" : "star-btn"}${favorite ? " on" : ""}`}
        title={favorite ? "Remove favorite" : "Add favorite"}
        aria-label={`${favorite ? "Remove" : "Add"} ${model.name} ${favorite ? "from" : "to"} favorites`}
        aria-pressed={favorite}
        onClick={(event) => {
          event.stopPropagation();
          toggleModelFavorite(modelKey(model));
        }}
      >{favorite ? "★" : "☆"}</button>
    );
  };

  const row = (model: ModelDescriptor) => {
    const selected = isSelected(model);
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
        {star(model)}
      </div>
    );
  };

  // ---- mobile sheet rows -----------------------------------------------------
  const moveFavorite = (model: ModelDescriptor, delta: number) => {
    const key = modelKey(model);
    const index = prefs.favorites.indexOf(key);
    const target = prefs.favorites[index + delta];
    if (target) reorderModelFavorites(key, target);
  };
  const sheetRow = (model: ModelDescriptor, group: "favorites" | "provider") => (
    <SheetRow
      key={`${group}:${modelKey(model)}`}
      title={model.name}
      meta={modelMetaLine(model)}
      selected={isSelected(model)}
      onClick={() => choose(model)}
      ariaLabel={`Use ${model.name}`}
      trailing={editing && group === "favorites" ? (
        <span className="sheet-row-tools">
          <button
            type="button"
            className="sheet-row-tool"
            aria-label={`Move ${model.name} up`}
            disabled={prefs.favorites.indexOf(modelKey(model)) <= 0}
            onClick={() => moveFavorite(model, -1)}
          >↑</button>
          <button
            type="button"
            className="sheet-row-tool"
            aria-label={`Move ${model.name} down`}
            disabled={prefs.favorites.indexOf(modelKey(model)) >= prefs.favorites.length - 1}
            onClick={() => moveFavorite(model, 1)}
          >↓</button>
        </span>
      ) : star(model, "sheet")}
    />
  );

  const trigger = phone ? (
    <button
      ref={triggerRef}
      className="model-trigger-mobile"
      type="button"
      aria-label={`Select model, current ${label}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={toggleOpen}
    >
      <span className="model-trigger-name">{label}</span>
      <span className="model-trigger-caret" aria-hidden="true"><Icon.chevronDown /></span>
    </button>
  ) : (
    <button
      ref={triggerRef}
      className="chip picker-chip model-picker-trigger"
      type="button"
      title={`Select model, current ${label}`}
      aria-label={`Select model, current ${label}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      onClick={toggleOpen}
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
  );

  return (
    <span className="picker picker-model model-picker">
      {trigger}
      {open && phone && (
        <Sheet
          title="Model"
          size="tall"
          className="model-sheet"
          onClose={close}
          search={{
            value: query,
            onChange: setQuery,
            placeholder: "Search models",
            ariaLabel: "Search models",
          }}
          {...(favorites.length > 1 ? {
            action: {
              label: editing ? "Done" : "Edit",
              pressed: editing,
              onClick: () => setEditing((value) => !value),
            },
          } : {})}
        >
          <div role="listbox" aria-label="Models">
            <SheetRow
              title="Auto"
              meta="Workspace default"
              selected={!current}
              onClick={() => choose()}
              ariaLabel="Use the workspace default model"
            />
            {favorites.length > 0 && (
              <SheetSection title="Favorites" count={favorites.length}>
                {favorites.map((model) => sheetRow(model, "favorites"))}
              </SheetSection>
            )}
            {providers.map((provider) => {
              const items = provider.models.filter((model) => !isFavorite(prefs, modelKey(model)));
              if (items.length === 0) return null;
              const expanded = q.length > 0 || prefs.expandedProviders.includes(provider.id);
              return (
                <section className="sheet-section" key={provider.id}>
                  <h3 className="sheet-section-head">
                    <button
                      type="button"
                      className="sheet-section-toggle"
                      aria-expanded={expanded}
                      onClick={() => setModelProviderExpanded(provider.id, !expanded)}
                    >
                      <span>{provider.name}</span>
                      <small>{items.length}</small>
                      <span className={`sheet-section-caret${expanded ? " open" : ""}`} aria-hidden="true">
                        <Icon.chevronDown />
                      </span>
                    </button>
                  </h3>
                  {expanded && items.map((model) => sheetRow(model, "provider"))}
                </section>
              );
            })}
            {filtered.length === 0 && <p className="sheet-empty">No models match “{query}”.</p>}
          </div>
        </Sheet>
      )}
      {open && !phone && (
        <>
          <div className="menu-backdrop" onClick={close} />
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
