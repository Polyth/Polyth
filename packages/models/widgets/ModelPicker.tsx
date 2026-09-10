// P2-W3A model picker: a quiet composer chip that opens one catalog surface —
// an anchored popover on desktop (search, keyboard navigation, provider
// groups, favorites with drag reorder) and the shared bottom Sheet on phones.
// Every row stays calm (name + one meta line); the full technical card
// (context, modalities, reasoning, tools, pricing, availability) lives behind
// an explicit per-row details view, never on the row itself.
import {
  useEffect,
  useLayoutEffect,
  lazy,
  useMemo,
  useReducer,
  useRef,
  useState,
  Suspense,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { ModelDescriptor, ModelRef } from "@polyth/contracts";
import { isFavorite, modelKey, orderProviders } from "@polyth/models";
import {
  reorderModelFavorites,
  noteModelUsed,
  reorderModelProviders,
  setModelProviderExpanded,
  toggleModelFavorite,
  useModelPrefs,
} from "./modelPrefs.ts";
import { useShellMode } from "@polyth/web/responsive-shell";
import { dismissKeyboard } from "@polyth/web/mobile-viewport";
import { tapFeedback } from "@polyth/web/haptics";
import { useSheetTrigger } from "@polyth/web/sheet-trigger";
import {
  InfoIcon,
  Button,
  ChevronDownIcon,
  ChevronUpIcon,
  FavoriteIcon,
  IconButton,
  ResponsiveOverlay,
  SheetRow,
  SheetSection,
  TextInput,
} from "@polyth/web/ui";
import { useEscape } from "../../../apps/web/src/useEscape.ts";
import { Icon } from "@polyth/web/icons";
import ProviderLogo from "./ProviderLogo.tsx";
import { tr } from "@polyth/web/i18n";
import {
  initialModelPickerState,
  modelPickerReducer,
  providerIsExpanded,
  pickerModelMatches,
  pickerCatalogModels,
  flatModelCatalog,
} from "./modelPickerState.ts";

const MAX_RENDERED_MODELS = 200;
const MODEL_PICKER_DRAG_TYPE = "application/x-polyth-model-picker";
const DETAILS_PANEL_WIDTH = 272;
type ModelPickerDragKind = "favorite" | "provider";
type ModelPickerDrag = { kind: ModelPickerDragKind; id: string };

function unanimousHarnessId(models: readonly ModelDescriptor[]): string | undefined {
  const harnessId = models[0]?.harnessId;
  return harnessId && models.every((model) => model.harnessId === harnessId) ? harnessId : undefined;
}

function visibleBand() {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (vv) {
    return {
      top: vv.offsetTop,
      bottom: vv.offsetTop + vv.height,
      left: vv.offsetLeft,
      right: vv.offsetLeft + vv.width,
    };
  }
  return { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
}

/** Adjacent details surface: beside the picker shell, aligned to the active row. */
function AdjacentDetailsPanel({
  open,
  anchor,
  pickerShellRef,
  onClose,
  children,
}: {
  open: boolean;
  anchor: HTMLElement | null;
  pickerShellRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; ready: boolean }>({
    left: 0,
    top: 0,
    ready: false,
  });
  useEscape(open, onClose);

  useLayoutEffect(() => {
    if (!open || !anchor) {
      setPosition({ left: 0, top: 0, ready: false });
      return;
    }
    const update = () => {
      const pickerShell = pickerShellRef.current;
      if (!pickerShell) return;
      const band = visibleBand();
      const margin = 8;
      const gap = 8;
      const pickerRect = pickerShell.getBoundingClientRect();
      const rowRect = anchor.getBoundingClientRect();
      const panelRect = panelRef.current?.getBoundingClientRect();
      const panelWidth = panelRect?.width || DETAILS_PANEL_WIDTH;
      const panelHeight = panelRect?.height || 260;
      let left = pickerRect.right + gap;
      if (left + panelWidth > band.right - margin) {
        left = Math.max(margin, pickerRect.left - gap - panelWidth);
      }
      const top = Math.min(
        Math.max(band.top + margin, rowRect.top - 8),
        band.bottom - margin - panelHeight,
      );
      setPosition((previous) => (
        previous.ready && previous.left === left && previous.top === top
          ? previous
          : { left, top, ready: true }
      ));
    };
    update();
    const frame = requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(update);
    const shell = pickerShellRef.current;
    if (shell) observer?.observe(shell);
    observer?.observe(anchor);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [open, anchor, pickerShellRef]);

  if (!open || !anchor || typeof document === "undefined") return null;

  return createPortal(
    <aside
      ref={panelRef}
      className="model-details-panel"
      aria-live="polite"
      style={{
        top: position.top,
        left: position.left,
        visibility: position.ready ? undefined : "hidden",
      }}
      onMouseEnter={(event) => event.stopPropagation()}
    >
      {children}
    </aside>,
    document.body,
  );
}

const LazyModelDetails = lazy(() => import("./ModelDetails.tsx").then((module) => ({ default: module.ModelDetails })));
const LazyModelHoverDetails = lazy(() => import("./ModelDetails.tsx").then((module) => ({ default: module.ModelHoverDetails })));

interface ModelPickerProps {
  models: ModelDescriptor[];
  harnessId?: string;
  value?: ModelRef & { harnessId?: string };
  recommended?: ModelRef & { harnessId?: string };
  onPick: (model?: ModelRef & { harnessId?: string }) => void;
  /** Package-contributed catalog routing shown above the model list. */
  header?: ReactNode;
  /** Preferred opening side for the desktop popover (collision may flip it). */
  direction?: "up" | "down";
  /** Current session input tokens for the details context meter. */
  usage?: number;
  className?: string;
}

export default function ModelPicker({
  models: catalogModels,
  harnessId,
  value,
  recommended,
  onPick,
  header,
  direction = "down",
  usage,
  className,
}: ModelPickerProps) {
  const models = useMemo(() => pickerCatalogModels(catalogModels, harnessId), [catalogModels, harnessId]);
  const flatCatalog = flatModelCatalog(models, harnessId);
  const prefs = useModelPrefs();
  const phone = useShellMode() === "phone";
  const [open, setOpen] = useState(false);
  const [pickerState, dispatchPicker] = useReducer(
    modelPickerReducer,
    undefined,
    initialModelPickerState,
  );
  const [editing, setEditing] = useState(false);
  const [detail, setDetail] = useState<ModelDescriptor | null>(null);
  const [detailAnchor, setDetailAnchor] = useState<HTMLElement | null>(null);
  const [active, setActive] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const [dragging, setDragging] = useState<ModelPickerDrag | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pickerShellRef = useRef<HTMLDivElement>(null);

  const current = value
    ? models.find((model) => pickerModelMatches(model, value))
    : undefined;
  const fallback = recommended
    ? models.find((model) => pickerModelMatches(model, recommended))
    : undefined;
  // A pending or partial catalog is not authority to replace the selection.
  const selectedRef = value ?? recommended;
  const selectedModel = selectedRef ? (value ? current : fallback) : models[0];
  const label = selectedModel?.name ?? selectedRef?.modelID ?? tr("modelpicker.noModel");
  const q = pickerState.query.trim().toLowerCase();
  // Build normalized search text only when the catalog changes. Rapid typing
  // scans one precomputed string per model instead of lowercasing four fields.
  const searchIndex = useMemo(() => models.map((model) => ({
    model,
    text: [model.name, model.modelID, model.providerID, model.providerName ?? ""]
      .join("\n")
      .toLowerCase(),
  })), [models]);
  const filtered = useMemo(
    () => searchIndex
      .filter((entry) => !q || entry.text.includes(q))
      .map((entry) => entry.model),
    [searchIndex, q],
  );

  const providers = useMemo(() => {
    if (flatCatalog) return [];
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
  }, [filtered, prefs, flatCatalog]);
  const providerIds = providers.map((provider) => provider.id);
  const favorites = useMemo(() => {
    if (flatCatalog) return [];
    const favoriteRank = new Map(prefs.favorites.map((key, index) => [key, index]));
    return filtered
      .filter((model) => favoriteRank.has(modelKey(model)))
      .sort((left, right) =>
        (favoriteRank.get(modelKey(left)) ?? 0) - (favoriteRank.get(modelKey(right)) ?? 0));
  }, [filtered, prefs.favorites, flatCatalog]);
  const recents = useMemo(() => {
    if (flatCatalog) return [];
    const rank = new Map(prefs.recents.map((key, index) => [key, index]));
    return filtered
      .filter((model) => rank.has(modelKey(model)) && !isFavorite(prefs, modelKey(model)))
      .sort((left, right) => (rank.get(modelKey(left)) ?? 0) - (rank.get(modelKey(right)) ?? 0));
  }, [filtered, prefs.favorites, prefs.recents, flatCatalog]);
  const expandedProviders = useMemo(
    () => new Set(prefs.expandedProviders),
    [prefs.expandedProviders],
  );
  const isExpanded = (providerId: string) => providerIsExpanded({
    query: pickerState.query,
    sessionOverride: pickerState.expansion[providerId],
    persistedExpanded: expandedProviders.has(providerId),
    selectedProvider: providerId === selectedModel?.providerID,
  });
  const setExpanded = (providerId: string, expanded: boolean) => {
    dispatchPicker({ type: "set-expanded", providerId, expanded });
    setModelProviderExpanded(providerId, expanded);
  };

  // Flattened keyboard-navigable rows (favorites, recents, then every expanded
  // provider's non-favorite models) — mirrors exactly what is rendered. The
  // same bounded policy as the generic Picker prevents a 400+ model catalog
  // from mounting hundreds of rows in one overlay; search reaches the rest.
  const flatRows = useMemo(() => {
    if (flatCatalog) return filtered.slice(0, MAX_RENDERED_MODELS);
    const rows: ModelDescriptor[] = [...favorites, ...recents].slice(0, MAX_RENDERED_MODELS);
    for (const provider of providers) {
      if (!isExpanded(provider.id) || rows.length >= MAX_RENDERED_MODELS) continue;
      for (const model of provider.models) {
        if (!isFavorite(prefs, modelKey(model)) && !prefs.recents.includes(modelKey(model))) rows.push(model);
        if (rows.length >= MAX_RENDERED_MODELS) break;
      }
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatCatalog, filtered, favorites, recents, providers, prefs.favorites, prefs.recents, pickerState, expandedProviders, selectedModel]);
  const activeIndex = flatRows.length > 0 ? Math.min(active, flatRows.length - 1) : -1;
  const activeKey = activeIndex >= 0 ? modelKey(flatRows[activeIndex]!) : null;
  const flatRowIndex = useMemo(
    () => new Map(flatRows.map((model, index) => [modelKey(model), index])),
    [flatRows],
  );
  const visibleCandidateCount = flatCatalog ? filtered.length : favorites.length + recents.length + providers.reduce((total, provider) => (
    isExpanded(provider.id)
      ? total + provider.models.filter((model) => !isFavorite(prefs, modelKey(model)) && !prefs.recents.includes(modelKey(model))).length
      : total
  ), 0);
  const hiddenMatchCount = Math.max(0, visibleCandidateCount - flatRows.length);
  const shownFavorites = favorites.filter((model) => flatRowIndex.has(modelKey(model)));

  // Keyboard navigation keeps the active row visible inside the scroll area.
  useEffect(() => {
    if (!open || phone) return;
    listRef.current
      ?.querySelector(".model-picker-row.active")
      ?.scrollIntoView({ block: "nearest" });
  }, [open, phone, activeKey]);

  const closeDetails = () => {
    setDetail(null);
    setDetailAnchor(null);
    setShowDetails(false);
  };
  useEffect(() => {
    closeDetails();
    setActive(0);
    dispatchPicker({ type: "reset" });
  }, [harnessId]);
  const hoverDetailsModel = showDetails && activeIndex >= 0 ? flatRows[activeIndex] : null;
  const hoverDetailsAnchor = hoverDetailsModel && !detail
    ? document.getElementById(`model-option-${modelKey(hoverDetailsModel)}`)
    : null;
  const detailsOpen = Boolean(detail) || Boolean(hoverDetailsModel && hoverDetailsAnchor && !phone);
  const detailsAnchor = detail ? detailAnchor : hoverDetailsAnchor;

  // Keep the familiar command-palette slash shortcut local to this open
  // picker; never steal text typed into another control.
  useEffect(() => {
    if (!open || phone) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      document.querySelector<HTMLInputElement>(".model-pop-search input")?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, phone]);

  const close = () => {
    setOpen(false);
    dispatchPicker({ type: "reset" });
    setEditing(false);
    closeDetails();
    setActive(0);
  };
  const choose = (model: ModelDescriptor) => {
    if (phone) tapFeedback();
    onPick({
      providerID: model.providerID,
      modelID: model.modelID,
      ...(model.harnessId ? { harnessId: model.harnessId } : {}),
    });
    noteModelUsed(modelKey(model));
    close();
    if (!phone) triggerRef.current?.focus();
  };
  const isSelected = (model: ModelDescriptor) => selectedModel
    ? modelKey(selectedModel) === modelKey(model)
    : false;

  const startDrag = (event: DragEvent, kind: ModelPickerDragKind, id: string) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(MODEL_PICKER_DRAG_TYPE, `${kind}:${id}`);
    setDragging({ kind, id });
  };
  const dragId = (event: DragEvent, kind: ModelPickerDragKind): string | null => {
    if (dragging?.kind === kind) return dragging.id;
    const data = event.dataTransfer.getData(MODEL_PICKER_DRAG_TYPE);
    const prefix = `${kind}:`;
    return data.startsWith(prefix) ? data.slice(prefix.length) || null : null;
  };
  const allowDrop = (event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  // §22: tapping the model while typing dismisses the keyboard FIRST, then
  // opens the sheet — the picker can never end up under the keyboard.
  const toggleOpen = () => {
    if (open) {
      close();
      return;
    }
    setOpen(true);
    if (phone) void dismissKeyboard();
  };
  const triggerHandlers = useSheetTrigger(phone, toggleOpen);

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setShowDetails(true);
      setActive((index) => Math.min(index + 1, Math.max(flatRows.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setShowDetails(true);
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setShowDetails(true);
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setShowDetails(true);
      setActive(Math.max(flatRows.length - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const model = flatRows[activeIndex];
      if (model) choose(model);
    }
  };

  const star = (model: ModelDescriptor, variant: "row" | "sheet" = "row") => {
    const favorite = isFavorite(prefs, modelKey(model));
    return (
      <IconButton
        type="button"
        className={`${variant === "sheet" ? "sheet-row-star" : "model-star-btn"}${favorite ? " on" : ""}`}
        icon={FavoriteIcon}
        size="sm"
        variant="ghost"
        pressed={favorite}
        title={favorite ? tr("modelpicker.removeFavorite") : tr("modelpicker.addFavorite")}
        label={favorite
          ? tr("modelpicker.removeValueFromFavorites", { name: model.name })
          : tr("modelpicker.addValueToFavorites", { name: model.name })}
        tabIndex={variant === "row" ? -1 : undefined}
        onClick={(event) => {
          event.stopPropagation();
          toggleModelFavorite(modelKey(model));
        }}
      />
    );
  };

  const infoButton = (model: ModelDescriptor, variant: "row" | "sheet" = "row") => (
    <IconButton
      type="button"
      className={variant === "sheet" ? "sheet-row-info" : "model-row-info"}
      icon={InfoIcon}
      size="sm"
      variant="ghost"
      title={tr("modelpicker.detailsForValue", { name: model.name })}
      label={tr("modelpicker.detailsForValue", { name: model.name })}
      tabIndex={variant === "row" ? -1 : undefined}
      onClick={(event) => {
        event.stopPropagation();
        setShowDetails(false);
        setDetail(model);
        setDetailAnchor(event.currentTarget.closest<HTMLElement>(".sheet-row, .model-picker-row") ?? event.currentTarget);
      }}
    />
  );

  const capabilityIcons = (model: ModelDescriptor) => {
    const modalities = new Set((model.capabilities ?? []).map((capability) => capability.toLowerCase()));
    const icons: Array<[string, ReactNode]> = [["Text", <Icon.text />]];
    if ([...modalities].some((capability) => capability.endsWith(":image"))) icons.push([tr("modelpicker.image"), <Icon.image />]);
    if ([...modalities].some((capability) => capability.endsWith(":audio"))) icons.push([tr("modelpicker.audio"), <Icon.speaker />]);
    if ([...modalities].some((capability) => capability.endsWith(":video"))) icons.push([tr("modelpicker.video"), <Icon.video />]);
    if (modalities.has("toolcall")) icons.push([tr("modelpicker.toolCalls"), <Icon.workflow />]);
    return <span className="model-capability-icons" aria-label={icons.map(([label]) => label).join(", ")}>{icons.map(([label, icon]) => <span key={label} title={label} aria-hidden="true">{icon}</span>)}</span>;
  };

  const row = (model: ModelDescriptor, group: "favorites" | "recent" | "provider") => {
    const selected = isSelected(model);
    const key = modelKey(model);
    const favoriteDrag = group === "favorites";
    return (
      <div
        key={key}
        id={`model-option-${key}`}
        className={`model-picker-row${selected ? " current" : ""}${activeKey === key ? " active" : ""}${dragging?.kind === "favorite" && dragging.id === key ? " dragging" : ""}${dropTarget === key ? " drop-target" : ""}`}
        role="option"
        aria-selected={selected}
        tabIndex={-1}
        onClick={() => choose(model)}
          onMouseEnter={(event: MouseEvent<HTMLDivElement>) => {
            const index = flatRowIndex.get(key);
            if (index !== undefined) {
              setDetail(null);
              setDetailAnchor(null);
              setActive(index);
              setShowDetails(true);
            }
        }}
        {...(favoriteDrag ? {
          draggable: !phone && !q,
          onDragStart: (event: DragEvent) => {
            if ((event.target as HTMLElement).closest("button,a")) { event.preventDefault(); return; }
            startDrag(event, "favorite", key);
          },
          onDragOver: (event: DragEvent) => { allowDrop(event); setDropTarget(key); },
          onDragLeave: () => setDropTarget(null),
          onDrop: (event: DragEvent) => {
            const dragged = dragId(event, "favorite");
            if (dragged) reorderModelFavorites(dragged, key);
            setDragging(null);
            setDropTarget(null);
          },
          onDragEnd: () => { setDragging(null); setDropTarget(null); },
        } : {})}
      >
        <span className={`model-picker-grip${favoriteDrag ? "" : " spacer"}`} aria-hidden="true">{favoriteDrag ? "⠿" : ""}</span>
        <ProviderLogo providerID={model.providerID} providerName={model.providerName} harnessId={model.harnessId} className="model-row-provider-logo" />
        <span className="model-picker-copy">
          <strong>
            {model.name}
            {model.connected === false && (
              <em className="model-row-offline">{tr("modelpicker.notConnected")}</em>
            )}
          </strong>
        </span>
        {capabilityIcons(model)}
        {infoButton(model)}
        {!flatCatalog && star(model)}
      </div>
    );
  };

  // ---- mobile sheet rows -----------------------------------------------------
  const moveFavorite = (model: ModelDescriptor, delta: number) => {
    const key = modelKey(model);
    const index = favorites.findIndex((favorite) => modelKey(favorite) === key);
    const target = favorites[index + delta];
    if (target) reorderModelFavorites(key, modelKey(target));
  };
  const sheetRow = (model: ModelDescriptor, group: "favorites" | "recent" | "provider") => (
    <SheetRow
      key={`${group}:${modelKey(model)}`}
      title={model.name}
      icon={(
        <>{editing && group === "favorites" && <span className="model-sheet-grip" aria-hidden="true">⠿</span>}<ProviderLogo providerID={model.providerID} providerName={model.providerName} harnessId={model.harnessId} className="model-row-provider-logo" /></>
      )}
      selected={isSelected(model)}
      onClick={() => choose(model)}
      ariaLabel={tr("modelpicker.useValue", { name: model.name })}
      trailing={editing && group === "favorites" ? (
        <span className="sheet-row-tools">
          <IconButton
            type="button"
            className="sheet-row-tool"
            icon={ChevronUpIcon}
            size="sm"
            variant="ghost"
            label={tr("modelpicker.moveValueUp", { name: model.name })}
            disabled={favorites.findIndex((favorite) => modelKey(favorite) === modelKey(model)) <= 0}
            onClick={() => moveFavorite(model, -1)}
          />
          <IconButton
            type="button"
            className="sheet-row-tool"
            icon={ChevronDownIcon}
            size="sm"
            variant="ghost"
            label={tr("modelpicker.moveValueDown", { name: model.name })}
            disabled={favorites.findIndex((favorite) => modelKey(favorite) === modelKey(model)) >= favorites.length - 1}
            onClick={() => moveFavorite(model, 1)}
          />
        </span>
      ) : (
        <span className="sheet-row-tools">
          {capabilityIcons(model)}
          {infoButton(model, "sheet")}
          {!flatCatalog && star(model, "sheet")}
        </span>
      )}
    />
  );

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      className={`config-chip model-picker-trigger${className ? ` ${className}` : ""}`}
      title={tr("modelpicker.selectModelCurrentValue", { label })}
      aria-label={tr("modelpicker.selectModelCurrentValue", { label })}
      aria-haspopup="dialog"
      aria-expanded={open}
      {...triggerHandlers}
    >
      {selectedModel && (
        <ProviderLogo
          providerID={selectedModel.providerID}
          providerName={selectedModel.providerName}
          harnessId={selectedModel.harnessId}
          size="compact"
          className="model-trigger-logo"
        />
      )}
      <span className="model-trigger-name">{label}</span>
      <span className="config-chip-caret" aria-hidden="true"><Icon.chevronDown /></span>
    </button>
  );

  const detailsPanelModel = detail ?? hoverDetailsModel;
  const detailsPanelContent = detailsPanelModel && (
    <Suspense fallback={null}>
      {detail
        ? (
          <LazyModelDetails
            model={detail}
            selected={isSelected(detail)}
            {...(usage !== undefined ? { usage } : {})}
            onUse={() => choose(detail)}
            onBack={closeDetails}
          />
        )
        : (
          <LazyModelHoverDetails
            model={detailsPanelModel}
            favorite={isFavorite(prefs, modelKey(detailsPanelModel))}
            showFavorite={!flatCatalog}
          />
        )}
    </Suspense>
  );

  return (
    <span className={`picker picker-model model-picker${open ? " open" : ""}`}>
      {trigger}
      <ResponsiveOverlay
          open={open}
          title={tr("modelpicker.model")}
          onClose={close}
          anchorRef={triggerRef}
          restoreFocusRef={triggerRef}
          side={direction === "up" ? "up" : "down"}
          align="start"
          stableAnchor
          className={phone ? "model-sheet" : "model-pop"}
          popoverOverflow="visible"
          initialFocus={!phone ? ".model-pop-search input" : undefined}
          sheetSize="tall"
          sheetSearch={{
            value: pickerState.query,
            onChange: (query: string) => {
              dispatchPicker({ type: "search", query });
              setActive(0);
              closeDetails();
            },
            placeholder: tr("modelpicker.searchModels"),
            ariaLabel: tr("modelpicker.searchModels"),
          }}
          {...(favorites.length > 1 ? {
            sheetAction: {
              label: editing ? tr("common.done") : tr("common.edit"),
              pressed: editing,
              onClick: () => setEditing((value) => !value),
            },
          } : {})}
        >
        <div ref={pickerShellRef} className="model-picker-shell">
          {header && <div className="model-picker-header">{header}</div>}
          {phone ? (
            <div role="listbox" aria-label={tr("modelpicker.models")}>
              {flatCatalog && flatRows.map((model) => sheetRow(model, "provider"))}
              {shownFavorites.length > 0 && (
                <SheetSection title={tr("modelpicker.favorites")} count={favorites.length}>
                  {shownFavorites.map((model) => sheetRow(model, "favorites"))}
                </SheetSection>
              )}
              {recents.length > 0 && (
                <SheetSection title="Recent" count={recents.length}>
                  {recents.map((model) => sheetRow(model, "recent"))}
                </SheetSection>
              )}
              {providers.map((provider) => {
                const items = provider.models.filter((model) => !isFavorite(prefs, modelKey(model)) && !prefs.recents.includes(modelKey(model)));
                if (items.length === 0) return null;
                const expanded = isExpanded(provider.id);
                const shown = items.filter((model) => flatRowIndex.has(modelKey(model)));
                return (
                  <section className="sheet-section" key={provider.id}>
                    <h3 className="sheet-section-head">
                      <button
                        type="button"
                        className="sheet-section-toggle"
                        aria-expanded={expanded}
                        onClick={() => setExpanded(provider.id, !expanded)}
                      >
                        <ProviderLogo
                          providerID={provider.id}
                          providerName={provider.name}
                          harnessId={unanimousHarnessId(provider.models)}
                          className="model-provider-logo"
                        />
                        <span>{provider.name}</span>
                        <small>{items.length}</small>
                        <span className={`sheet-section-caret${expanded ? " open" : ""}`} aria-hidden="true">
                          <Icon.chevronDown />
                        </span>
                      </button>
                    </h3>
                    {expanded && shown.map((model) => sheetRow(model, "provider"))}
                  </section>
                );
              })}
              {filtered.length === 0 && <p className="sheet-empty">{tr("modelpicker.noModelsFound")}</p>}
              {hiddenMatchCount > 0 && (
                <p className="picker-more">{hiddenMatchCount} {tr("picker.moreRefineTheFilter")}</p>
              )}
            </div>
          ) : (
            <div className="model-pop-content">
              <div className="model-pop-search">
                <TextInput
                  value={pickerState.query}
                  placeholder={tr("modelpicker.searchModels2")}
                  role="combobox"
                  aria-label={tr("modelpicker.filterModels")}
                  aria-autocomplete="list"
                  aria-expanded="true"
                  aria-controls="model-pop-listbox"
                  aria-activedescendant={activeKey ? `model-option-${activeKey}` : undefined}
                  onChange={(event) => {
                    dispatchPicker({ type: "search", query: event.target.value });
                    setActive(0);
                    closeDetails();
                  }}
                  onKeyDown={onSearchKey}
                />
              </div>
              <div
                ref={listRef}
                id="model-pop-listbox"
                className="model-picker-list ui-scroll"
                role="listbox"
                aria-label={tr("modelpicker.models")}
              >
                {flatCatalog && flatRows.map((model) => row(model, "provider"))}
                {shownFavorites.length > 0 && (
                  <section className="model-provider-section favorites">
                    <div className="model-provider-head static">
                      <span aria-hidden="true">★</span>
                      <strong>{tr("modelpicker.favorites")}</strong>
                      <small>{favorites.length}</small>
                    </div>
                    <div>{shownFavorites.map((model) => row(model, "favorites"))}</div>
                  </section>
                )}
                {recents.length > 0 && (
                  <section className="model-provider-section recents">
                    <div className="model-provider-head static"><span aria-hidden="true">◷</span><strong>Recent</strong><small>{recents.length}</small></div>
                    <div>{recents.filter((model) => flatRowIndex.has(modelKey(model))).map((model) => row(model, "recent"))}</div>
                  </section>
                )}
                {providers.map((provider) => {
                  const expanded = isExpanded(provider.id);
                  const items = provider.models.filter((model) => !isFavorite(prefs, modelKey(model)) && !prefs.recents.includes(modelKey(model)));
                  if (items.length === 0) return null;
                  const shown = items.filter((model) => flatRowIndex.has(modelKey(model)));
                  return (
                    <section
                      className={`model-provider-section${dragging?.kind === "provider" && dragging.id === provider.id ? " dragging" : ""}`}
                      key={provider.id}
                      draggable={!q}
                      onDragStart={(event) => startDrag(event, "provider", provider.id)}
                      onDragOver={allowDrop}
                      onDrop={(event) => {
                        const dragged = dragId(event, "provider");
                        if (dragged) reorderModelProviders(providerIds, dragged, provider.id);
                        setDragging(null);
                      }}
                      onDragEnd={() => setDragging(null)}
                    >
                      <button
                        type="button"
                        className="model-provider-head"
                        aria-expanded={expanded}
                        onClick={() => setExpanded(provider.id, !expanded)}
                      >
                        <span className="model-provider-grip" aria-hidden="true">⠿</span>
                        <ProviderLogo
                          providerID={provider.id}
                          providerName={provider.name}
                          harnessId={unanimousHarnessId(provider.models)}
                          className="model-provider-logo"
                        />
                        <strong>{provider.name}</strong>
                        <small>{items.length}</small>
                        <span className={`model-provider-caret${expanded ? " open" : ""}`} aria-hidden="true">
                          <Icon.chevronDown />
                        </span>
                      </button>
                      {expanded && <div>{shown.map((model) => row(model, "provider"))}</div>}
                    </section>
                  );
                })}
                {filtered.length === 0 && <div className="palette-empty">{tr("modelpicker.noModelsFound")}</div>}
                {hiddenMatchCount > 0 && (
                  <div className="picker-more">{hiddenMatchCount} {tr("picker.moreRefineTheFilter")}</div>
                )}
              </div>
              <footer className="model-picker-shortcuts" aria-label="Keyboard shortcuts">
                <span>↑↓ Navigate</span><span>Enter Select</span><span>/ Search</span>
              </footer>
            </div>
          )}
        </div>
      </ResponsiveOverlay>
      <AdjacentDetailsPanel
        open={open && detailsOpen}
        anchor={detailsAnchor}
        pickerShellRef={pickerShellRef}
        onClose={closeDetails}
      >
        {detailsPanelContent}
      </AdjacentDetailsPanel>
    </span>
  );
}
