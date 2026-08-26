import { useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { ModelDescriptor, ModelRef } from "@polyth/contracts";
import { isFavorite, modelKey, orderProviders } from "@polyth/models";
import {
  reorderModelFavorites,
  reorderModelProviders,
  setModelProviderExpanded,
  toggleModelFavorite,
  useModelPrefs,
} from "../../../apps/web/src/modelPrefs.ts";
import { useEscape } from "../../../apps/web/src/useEscape.ts";
import { useShellMode } from "../../../apps/web/src/responsiveShell.ts";
import { dismissKeyboard } from "../../../apps/web/src/mobileViewport.ts";
import { tapFeedback } from "../../../apps/web/src/haptics.ts";
import Sheet, { SheetRow, SheetSection } from "../../../apps/web/src/components/mobile/Sheet.tsx";
import { useSheetTrigger } from "../../../apps/web/src/components/mobile/sheetTrigger.ts";
import { Icon } from "../../../apps/web/src/icons.tsx";
import ProviderLogo from "./ProviderLogo.tsx";
import { usePopoverPlacement } from "../../../apps/web/src/usePopoverPlacement.ts";
import { formatList, formatNumber, tr } from "../../../apps/web/src/i18n/index.ts";

function modalityLabel(value: string): string {
  const labels: Record<string, string> = {
    text: tr("modelpicker.text"),
    image: tr("modelpicker.image"),
    audio: tr("modelpicker.audio"),
    video: tr("modelpicker.video"),
    pdf: tr("modelpicker.pdf"),
  };
  return labels[value.toLowerCase()] ?? value;
}

export function modelModalities(model: ModelDescriptor): string {
  const modalities = (model.capabilities ?? [])
    .filter((capability) =>
      (capability.startsWith("input:") || capability.startsWith("output:"))
      && !capability.endsWith(":none"))
    .map((capability) => capability.slice(capability.indexOf(":") + 1));
  return modalities.length > 0
    ? formatList([...new Set(modalities)].map(modalityLabel))
    : tr("modelpicker.text");
}

export function modelContextLabel(context?: number): string {
  if (!context) return tr("modelpicker.contextUnknown");
  if (context >= 1_000_000) {
    return tr("modelpicker.valueMContext", {
      value: formatNumber(context / 1_000_000, { maximumFractionDigits: 1 }),
    });
  }
  if (context >= 1_000) {
    return tr("modelpicker.valueKContext", { value: formatNumber(Math.round(context / 1_000)) });
  }
  return tr("modelpicker.valueContext", { value: formatNumber(context) });
}

/** Modalities in a stable reading order, with the acronyms spelled properly.
 *  Reported capabilities only — nothing is inferred. */
const MODALITY_ORDER = ["text", "image", "audio", "video", "pdf"];

export function modelModalityValues(model: ModelDescriptor): string[] {
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
  return unique;
}

export function modelModalityLabels(model: ModelDescriptor): string[] {
  return modelModalityValues(model).map(modalityLabel);
}

const MODALITY_ICONS: Record<string, () => ReactNode> = {
  text: Icon.text,
  image: Icon.image,
  audio: Icon.speaker,
  video: Icon.video,
  pdf: Icon.file,
};

function shortContext(context?: number): string | null {
  if (!context) return null;
  if (context >= 1_000_000) return `${formatNumber(context / 1_000_000, { maximumFractionDigits: 1 })}M`;
  if (context >= 1_000) return `${formatNumber(Math.round(context / 1_000))}K`;
  return formatNumber(context);
}

/** Compact modality icons + context for mobile rows and the trigger —
 *  reported capabilities only, same source as modelMetaLine. */
export function ModelMetaIcons({ model }: { model: ModelDescriptor }) {
  const context = shortContext(model.context);
  return (
    <span className="model-meta-icons">
      {modelModalityValues(model).map((value) => {
        const Glyph = MODALITY_ICONS[value] ?? Icon.text;
        return (
          <span key={value} className="model-modality-icon" title={modalityLabel(value)}>
            <Glyph />
          </span>
        );
      })}
      {context && <span className="model-meta-context">{context}</span>}
    </span>
  );
}

/** UX-MOBILE-01 §13/§40: one calm metadata line — `Text · Image · 500K` —
 *  instead of a mixed bag of glyphs. Reported capabilities only, no guesses. */
export function modelMetaLine(model?: ModelDescriptor): string {
  if (!model) return "";
  const context = shortContext(model.context);
  return [...modelModalityLabels(model), ...(context ? [context] : [])].join(" · ");
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
  composerMeta?: string;
}

export default function ModelPicker({
  models,
  value,
  recommended,
  onPick,
  direction: _direction = "down",
  composerMeta,
}: ModelPickerProps) {
  const prefs = useModelPrefs();
  const phone = useShellMode() === "phone";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [draggedProvider, setDraggedProvider] = useState<string | null>(null);
  const [draggedFavorite, setDraggedFavorite] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const direction = usePopoverPlacement(open && !phone, triggerRef, popoverRef);
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
  const selectedModel = current ?? fallback ?? models[0];
  const label = selectedModel?.name ?? tr("modelpicker.noModel");
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
  const choose = (model: ModelDescriptor) => {
    if (phone) tapFeedback();
    onPick({ providerID: model.providerID, modelID: model.modelID });
    close();
    if (!phone) triggerRef.current?.focus();
  };
  const isSelected = (model: ModelDescriptor) => selectedModel
    ? selectedModel.providerID === model.providerID && selectedModel.modelID === model.modelID
    : false;

  // §22: tapping the model while typing dismisses the keyboard FIRST, then
  // opens the sheet — the picker can never end up under the keyboard.
  const toggleOpen = () => {
    if (open) {
      close();
      return;
    }
    if (phone) {
      // Open immediately, then let the keyboard go: the sheet must never wait
      // for a click that the keyboard-dismiss reflow can swallow.
      setOpen(true);
      void dismissKeyboard();
    } else {
      setOpen(true);
    }
  };
  const triggerHandlers = useSheetTrigger(phone, toggleOpen);

  const star = (model: ModelDescriptor, variant: "row" | "sheet" = "row") => {
    const favorite = isFavorite(prefs, modelKey(model));
    return (
      <button
        className={`${variant === "sheet" ? "sheet-row-star" : "star-btn"}${favorite ? " on" : ""}`}
        title={favorite ? tr("modelpicker.removeFavorite") : tr("modelpicker.addFavorite")}
        aria-label={favorite
          ? tr("modelpicker.removeValueFromFavorites", { name: model.name })
          : tr("modelpicker.addValueToFavorites", { name: model.name })}
        aria-pressed={favorite}
        onClick={(event) => {
          event.stopPropagation();
          toggleModelFavorite(modelKey(model));
        }}
      >{favorite ? "★" : "☆"}</button>
    );
  };

  const row = (model: ModelDescriptor, favoriteDrag = false) => {
    const selected = isSelected(model);
    const key = modelKey(model);
    return (
      <div
        key={key}
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
        {...(favoriteDrag ? {
          draggable: !q,
          onDragStart: () => setDraggedFavorite(key),
          onDragOver: (event: DragEvent) => event.preventDefault(),
          onDrop: (event: DragEvent) => {
            event.preventDefault();
            if (draggedFavorite) reorderModelFavorites(draggedFavorite, key);
            setDraggedFavorite(null);
          },
        } : {})}
      >
        {favoriteDrag && <span className="model-picker-grip" aria-hidden="true">⠿</span>}
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
      icon={(
        <ProviderLogo
          providerID={model.providerID}
          providerName={model.providerName}
          className="model-row-provider-logo"
        />
      )}
      selected={isSelected(model)}
      onClick={() => choose(model)}
      ariaLabel={tr("modelpicker.useValue", { name: model.name })}
      trailing={editing && group === "favorites" ? (
        <span className="sheet-row-tools">
          <button
            type="button"
            className="sheet-row-tool"
            aria-label={tr("modelpicker.moveValueUp", { name: model.name })}
            disabled={prefs.favorites.indexOf(modelKey(model)) <= 0}
            onClick={() => moveFavorite(model, -1)}
          >↑</button>
          <button
            type="button"
            className="sheet-row-tool"
            aria-label={tr("modelpicker.moveValueDown", { name: model.name })}
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
      aria-label={tr("modelpicker.selectModelCurrentValue", { label: label })}
      aria-haspopup="dialog"
      aria-expanded={open}
      {...triggerHandlers}
    >
      {selectedModel && (
        <ProviderLogo
          providerID={selectedModel.providerID}
          providerName={selectedModel.providerName}
          className="model-trigger-logo"
        />
      )}
      <span className="model-trigger-copy">
        <span className="model-trigger-name">{label}</span>
        {selectedModel && (
          <span className="composer-model-meta"><ModelMetaIcons model={selectedModel} /></span>
        )}
      </span>
    </button>
  ) : (
    <button
      ref={triggerRef}
      className="chip picker-chip model-picker-trigger"
      type="button"
      title={tr("modelpicker.selectModelCurrentValue", { label: label })}
      aria-label={tr("modelpicker.selectModelCurrentValue", { label: label })}
      aria-haspopup="listbox"
      aria-expanded={open}
      onClick={toggleOpen}
    >
      {selectedModel && (
        <ProviderLogo
          providerID={selectedModel.providerID}
          providerName={selectedModel.providerName}
          className="model-trigger-logo"
        />
      )}
      <span className="model-trigger-copy">
        <small>{tr("modelpicker.model")}</small>
        <strong className="picker-chip-text">{label}</strong>
        {composerMeta && <span className="composer-model-meta">{composerMeta}</span>}
      </span>
      {selectedModel && (
        <span className="model-trigger-meta">
          {modelModalities(selectedModel)} · {modelContextLabel(selectedModel.context)}
        </span>
      )}
    </button>
  );

  return (
    <span className="picker picker-model model-picker">
      {trigger}
      {open && phone && (
        <Sheet
          title={tr("modelpicker.model")}
          size="tall"
          className="model-sheet"
          onClose={close}
          search={{
            value: query,
            onChange: setQuery,
            placeholder: tr("modelpicker.searchModels"),
            ariaLabel: tr("modelpicker.searchModels"),
          }}
          {...(favorites.length > 1 ? {
            action: {
              label: editing ? tr("common.done") : tr("common.edit"),
              pressed: editing,
              onClick: () => setEditing((value) => !value),
            },
          } : {})}
        >
          <div role="listbox" aria-label={tr("modelpicker.models")}>
            {favorites.length > 0 && (
              <SheetSection title={tr("modelpicker.favorites")} count={favorites.length}>
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
                      <ProviderLogo
                        providerID={provider.id}
                        providerName={provider.name}
                        className="model-provider-logo"
                      />
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
            {filtered.length === 0 && <p className="sheet-empty">{tr("modelpicker.noModelsMatch")}{query}”.</p>}
          </div>
        </Sheet>
      )}
      {open && !phone && (
        <>
          <div className="menu-backdrop" onClick={close} />
          <div ref={popoverRef} className={`picker-pop model-picker-pop ${direction}`}>
            <input
              autoFocus
              value={query}
              placeholder={tr("modelpicker.searchModels2")}
              aria-label={tr("modelpicker.filterModels")}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="model-picker-list" role="listbox" aria-label={tr("modelpicker.models")}>
              {favorites.length > 0 && (
                <section className="model-provider-section favorites">
                  <div className="model-provider-head static"><span>★</span><strong>{tr("modelpicker.favorites")}</strong><small>{favorites.length}</small></div>
                  <div>{favorites.map((model) => row(model, true))}</div>
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
                      <ProviderLogo
                        providerID={provider.id}
                        providerName={provider.name}
                        className="model-provider-logo"
                      />
                      <strong>{provider.name}</strong>
                      <small>{items.length}</small>
                      <span aria-hidden="true">{expanded ? "⌄" : "›"}</span>
                    </button>
                    {expanded && <div>{items.map((model) => row(model))}</div>}
                  </section>
                );
              })}
              {filtered.length === 0 && <div className="palette-empty">{tr("modelpicker.noModelsFound")}</div>}
            </div>
          </div>
        </>
      )}
    </span>
  );
}
