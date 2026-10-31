// P2-W3A model picker: a quiet composer chip that opens one compact catalog
// surface — an anchored Quiet Glass popover on every form factor (search,
// keyboard navigation, provider groups, and favorites with drag reorder on
// desktop; the compact phone surface keeps the same choices without search or
// edit mode: harness tabs and provider groups are its whole navigation).
// Every row stays calm (name + one meta line); the full technical card
// (context, modalities, reasoning, tools, pricing, availability) lives behind
// an explicit per-row details view, never on the row itself.
// The shell imports this picker directly, so it carries its own stylesheet into
// the shell bundle; the Models package stylesheet only attaches on activation.
import "./model-picker-styles.css";
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
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { ModelDescriptor, ModelRef } from "@polyth/contracts";
import { hiddenModelMatcher, isFavorite, modelKey, orderProviders, providerPreferenceKey } from "@polyth/models";
import {
  reorderModelFavorites,
  noteModelUsed,
  reorderModelProviders,
  setModelProviderExpanded,
  toggleModelFavorite,
  useModelPrefs,
} from "./modelPrefs.ts";
import { useShellMode } from "@polyth/web/responsive-shell";
import { dismissKeyboard, getViewportMetrics } from "@polyth/web/mobile-viewport";
import { tapFeedback } from "@polyth/web/haptics";
import {
  FavoriteIcon,
  IconButton,
  Menu,
  ResponsiveOverlay,
  TextInput,
  type MenuEntry,
} from "@polyth/web/ui";
import { useEscape } from "../../../apps/web/src/useEscape.ts";
import { isImeComposing } from "@polyth/web-sdk";
import { Icon } from "@polyth/web/icons";
import ProviderLogo from "./ProviderLogo.tsx";
import { tr } from "@polyth/web/i18n";
import { modelSupportsThinking, providerLabel, thinkingVariantLabel } from "./modelPresentation.ts";
import { setModelThinking, thinkingModelKey, useThinkingPrefs } from "./thinkingPrefs.ts";
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

export interface ModelChipDisplay {
  /** Label shown on the composer chip. */
  label: string;
  /** Catalogue row behind the displayed identity, when this route owns one. */
  model?: ModelDescriptor;
  /** The label is the last known route identity, not a selection for this route. */
  pending: boolean;
}

/**
 * What the model chip shows for one render.
 *
 * `pending` is the display-only anchor the composer holds across a harness
 * switch: the route has no confirmed model yet, so the last known identity is
 * kept instead of falling through to an arbitrary first catalogue entry. It is
 * never a selection — the caller must not send it. Without `pending` this is
 * exactly the previous behaviour: selection, then recommendation, then the
 * first catalogue entry.
 */
export function modelChipDisplay(input: {
  models: readonly ModelDescriptor[];
  value?: ModelRef & { harnessId?: string };
  recommended?: ModelRef & { harnessId?: string };
  pending?: ModelRef & { name?: string };
  emptyLabel: string;
}): ModelChipDisplay {
  if (input.value) {
    const model = input.models.find((candidate) => pickerModelMatches(candidate, input.value!));
    return { label: model?.name ?? input.value.modelID, ...(model ? { model } : {}), pending: false };
  }
  if (input.pending) {
    const model = input.models.find((candidate) => pickerModelMatches(candidate, input.pending!));
    return {
      label: model?.name ?? input.pending.name ?? input.pending.modelID,
      ...(model ? { model } : {}),
      pending: true,
    };
  }
  if (input.recommended) {
    const model = input.models.find((candidate) => pickerModelMatches(candidate, input.recommended!));
    return { label: model?.name ?? input.recommended.modelID, ...(model ? { model } : {}), pending: false };
  }
  const first = input.models[0];
  return first
    ? { label: first.name, model: first, pending: false }
    : { label: input.emptyLabel, pending: false };
}

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
  /** Display-only anchor for a route change: the last known model identity.
   *  While it is set and this route has no confirmed selection, the chip keeps
   *  that label instead of falling through to an arbitrary first catalogue
   *  entry. It is never a selection and must not be sent. */
  pendingModel?: ModelRef & { name?: string };
  /** Controlled thinking choice for the selected model. `null` is explicit
   *  Auto; omitted preserves the variant carried by `value`/`recommended`. */
  thinking?: string | null;
  onPick: (model?: ModelRef & { harnessId?: string }) => void;
  /** Package-contributed catalog routing shown above the model list. */
  header?: ReactNode;
  /** Preferred opening side for the desktop popover (collision may flip it). */
  direction?: "up" | "down";
  /** Current session input tokens for the details context meter. */
  usage?: number;
  /** Catalog is still discovering; an empty list is not authoritative. */
  catalogLoading?: boolean;
  /**
   * Optional leading row that clears the selection instead of binding a
   * catalogue entry. It also replaces the "first catalogue model" fallback
   * label while nothing is selected, so an unset route never pretends to be a
   * concrete model. In multi-select mode it clears the whole set.
   */
  emptyLabel?: string;
  /**
   * Multi-select: a set of models instead of one route. Rows toggle
   * membership through `onToggle` and the popover stays open; `value`,
   * `recommended`, `pendingModel` and `thinking` are ignored. With
   * `emptyLabel`, the leading row clears the set through `onPick(undefined)`.
   */
  selection?: ReadonlyArray<ModelRef & { harnessId?: string }>;
  onToggle?: (model: ModelRef & { harnessId?: string }) => void;
  /** Multi-select cap: unselected rows stop toggling once it is reached. */
  maxSelection?: number;
  /** Other harnesses' catalogs. Only a search reaches them (they are never
   *  listed), so a query finds a model anywhere; picking one hands `onPick` a
   *  ref carrying that harness id and the caller moves the route there. */
  otherHarnesses?: ReadonlyArray<{ harnessId: string; name: string; models: readonly ModelDescriptor[] }>;
  /** Harness profile colors by harness id (`useHarnessColors`): the trigger
   *  tints its logo like the harness tab, so the chip names the profile too. */
  harnessColors?: ReadonlyMap<string, string>;
  className?: string;
}

export default function ModelPicker({
  models: catalogModels,
  harnessId,
  value,
  recommended,
  pendingModel,
  thinking,
  onPick,
  header,
  direction = "down",
  usage,
  catalogLoading = false,
  emptyLabel,
  selection,
  onToggle,
  maxSelection,
  otherHarnesses,
  harnessColors,
  className,
}: ModelPickerProps) {
  const multi = selection !== undefined && onToggle !== undefined;
  if (multi) {
    value = undefined;
    recommended = undefined;
    pendingModel = undefined;
    thinking = undefined;
  }
  const prefs = useModelPrefs();
  const catalog = useMemo(() => pickerCatalogModels(catalogModels, harnessId), [catalogModels, harnessId]);
  // Models this account hid in Settings → Harnesses stay out of the list and
  // search, except one chosen right now: the chip and the list must agree on
  // what is selected, and a hidden model never silently stops a route.
  const { hiddenProviders, hiddenModels, shownModels } = prefs;
  const isHidden = useMemo(
    () => hiddenModelMatcher({ hiddenProviders, hiddenModels, shownModels }),
    [hiddenProviders, hiddenModels, shownModels],
  );
  const keepRefs = [value, recommended, pendingModel, ...(selection ?? [])]
    .filter((ref): ref is ModelRef & { harnessId?: string } => Boolean(ref));
  const keepKey = keepRefs.map((ref) => `${ref.harnessId ?? ""}:${ref.providerID}/${ref.modelID}`).join("|");
  const models = useMemo(
    () => catalog.filter((model) => !isHidden(model, harnessId) || keepRefs.some((ref) => pickerModelMatches(model, ref))),
    // keepKey stands for keepRefs: the refs are rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, isHidden, harnessId, keepKey],
  );
  const hiddenInCatalog = catalog.length - models.length;
  const flatCatalog = flatModelCatalog(models, harnessId);
  const thinkingPrefs = useThinkingPrefs();
  const preferenceHarnessId = harnessId ?? unanimousHarnessId(models) ?? "opencode";
  const phone = useShellMode() === "phone";
  const [open, setOpen] = useState(false);
  const [pickerState, dispatchPicker] = useReducer(
    modelPickerReducer,
    undefined,
    initialModelPickerState,
  );
  const [detail, setDetail] = useState<ModelDescriptor | null>(null);
  const [detailAnchor, setDetailAnchor] = useState<HTMLElement | null>(null);
  // `null` follows the selected model (single-select), so opening the picker or
  // switching its harness lands the keyboard on the current choice rather than
  // on row one.
  const [active, setActive] = useState<number | null>(null);
  const [emptyActive, setEmptyActive] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [dragging, setDragging] = useState<ModelPickerDrag | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Phone has no search to reach past the render cap, so it pages instead.
  const [renderLimit, setRenderLimit] = useState(MAX_RENDERED_MODELS);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pickerShellRef = useRef<HTMLDivElement>(null);
  const openRequestRef = useRef(0);
  const touchTriggerActivationRef = useRef(false);

  useEffect(() => () => {
    openRequestRef.current += 1;
  }, []);

  const current = value
    ? models.find((model) => pickerModelMatches(model, value))
    : undefined;
  const fallback = recommended
    ? models.find((model) => pickerModelMatches(model, recommended))
    : undefined;
  // A pending or partial catalog is not authority to replace the selection.
  const selectedRef = value ?? recommended;
  // An empty-selection route must not fall through to the first catalogue
  // entry: `emptyLabel` asks the trigger and rows to stay unselected instead.
  const allowsEmpty = Boolean(emptyLabel);
  // Composer thinking is persisted separately from model identity. Prefer that
  // controlled value when supplied, while keeping ModelRef.variant compatibility
  // for settings and recovery consumers that still carry it on the ref.
  const selectedThinking = thinking === undefined ? selectedRef?.variant : thinking ?? "";
  const selectedModels = multi
    ? models.filter((model) => selection.some((ref) => pickerModelMatches(model, ref)))
    : [];
  const selectedModel = multi
    ? selectedModels[0]
    : selectedRef ? (value ? current : fallback) : (allowsEmpty ? undefined : models[0]);
  const selectionFull = multi && maxSelection !== undefined && selection.length >= maxSelection;
  // The chip is not the list: a pending route anchor replaces only the trigger
  // label (and its logo), never the selection highlighting below.
  const chip = modelChipDisplay({
    models,
    ...(value ? { value } : {}),
    ...(recommended ? { recommended } : {}),
    ...(pendingModel ? { pending: pendingModel } : {}),
    emptyLabel: tr("modelpicker.noModel"),
  });
  const label = multi
    ? selection.length === 0
      ? emptyLabel ?? tr("modelpicker.noModel")
      : selection.length === 1
        ? selectedModel?.name ?? selection[0]!.modelID
        : tr("modelpicker.valueModels", { count: selection.length })
    : emptyLabel && !selectedRef ? emptyLabel : chip.label;
  const triggerModel = multi
    ? selection.length === 1 ? selectedModel : undefined
    : chip.pending ? chip.model : selectedModel;
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

  const elsewhere = useMemo(() => {
    if (!q || multi || !otherHarnesses?.length) return [];
    return otherHarnesses
      .filter((group) => group.harnessId !== (harnessId ?? unanimousHarnessId(models)))
      .map((group) => ({
        ...group,
        models: group.models.filter((model) => !isHidden(model, group.harnessId)
          && [model.name, model.modelID, model.providerID, model.providerName ?? ""].join("\n").toLowerCase().includes(q)),
      }))
      .filter((group) => group.models.length > 0);
  }, [otherHarnesses, q, multi, harnessId, models, isHidden]);
  // A query that matches only hidden models says so instead of "no models".
  const hiddenMatches = useMemo(() => Boolean(q) && hiddenInCatalog > 0 && catalog.some((model) =>
    isHidden(model, harnessId) && [model.name, model.modelID, model.providerID, model.providerName ?? ""].join("\n").toLowerCase().includes(q)),
  [q, hiddenInCatalog, catalog, isHidden, harnessId]);

  const providers = useMemo(() => {
    if (flatCatalog) return [];
    const byId = new Map<string, {
      id: string;
      providerID: string;
      harnessId: string;
      name: string;
      models: ModelDescriptor[];
    }>();
    for (const model of filtered) {
      const providerHarnessId = model.harnessId ?? harnessId ?? "opencode";
      const preferenceId = providerPreferenceKey(providerHarnessId, model.providerID);
      const provider = byId.get(preferenceId) ?? {
        id: preferenceId,
        providerID: model.providerID,
        harnessId: providerHarnessId,
        name: providerLabel(model.providerID, model.providerName),
        models: [],
      };
      provider.models.push(model);
      byId.set(preferenceId, provider);
    }
    return orderProviders([...byId.values()], prefs, preferenceHarnessId);
  }, [filtered, prefs, flatCatalog, preferenceHarnessId]);
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
  const selectedProviderPreferenceId = selectedModel
    ? providerPreferenceKey(selectedModel.harnessId ?? harnessId ?? "opencode", selectedModel.providerID)
    : undefined;
  // With no selection and an explicit empty route, keep the catalogue
  // discoverable by expanding the first provider instead of opening on a wall
  // of collapsed headings.
  const defaultExpandedProviderId = allowsEmpty && !selectedRef ? providerIds[0] : undefined;
  const isExpanded = (providerId: string) => providerIsExpanded({
    query: pickerState.query,
    sessionOverride: pickerState.expansion[providerId],
    persistedExpanded: expandedProviders.has(providerPreferenceKey(preferenceHarnessId, providerId)),
    selectedProvider: providerId === (selectedProviderPreferenceId ?? defaultExpandedProviderId),
  });
  const setExpanded = (providerId: string, expanded: boolean) => {
    dispatchPicker({ type: "set-expanded", providerId, expanded });
    setModelProviderExpanded(providerId, expanded, preferenceHarnessId);
  };

  // Flattened keyboard-navigable rows (favorites, recents, then every expanded
  // provider's non-favorite models) — mirrors exactly what is rendered. The
  // same bounded policy as the generic Picker prevents a 400+ model catalog
  // from mounting hundreds of rows in one overlay; search (or, on phone,
  // "Show more") reaches the rest.
  const flatRows = useMemo(() => {
    const rows: ModelDescriptor[] = flatCatalog
      ? filtered.slice(0, renderLimit)
      : [...favorites, ...recents].slice(0, renderLimit);
    for (const provider of providers) {
      if (!isExpanded(provider.id) || rows.length >= renderLimit) continue;
      for (const model of provider.models) {
        if (!isFavorite(prefs, modelKey(model)) && !prefs.recents.includes(modelKey(model))) rows.push(model);
        if (rows.length >= renderLimit) break;
      }
    }
    for (const group of elsewhere) rows.push(...group.models.slice(0, Math.max(0, renderLimit - rows.length)));
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatCatalog, filtered, favorites, recents, providers, elsewhere, prefs.favorites, prefs.recents, pickerState, expandedProviders, selectedModel, renderLimit]);
  // The empty row is not a model, so it is not in `flatRows`; it is the first
  // keyboard stop ahead of them and only exists while no search filters it out.
  const emptyRowShown = allowsEmpty && !q;
  const emptyIsActive = emptyRowShown && emptyActive;
  const flatRowIndex = useMemo(
    () => new Map(flatRows.map((model, index) => [modelKey(model), index])),
    [flatRows],
  );
  // A multi-select set has no single current row, and Enter toggles in place
  // there, so its keyboard starts on row one and stays where it was moved.
  const selectedRowIndex = !multi && selectedModel ? flatRowIndex.get(modelKey(selectedModel)) : undefined;
  const activeIndex = flatRows.length > 0 ? Math.min(active ?? selectedRowIndex ?? 0, flatRows.length - 1) : -1;
  const activeKey = !emptyIsActive && activeIndex >= 0 ? modelKey(flatRows[activeIndex]!) : null;
  const activeDescendant = emptyIsActive ? "model-option-empty" : activeKey ? `model-option-${activeKey}` : undefined;
  const visibleCandidateCount = flatCatalog ? filtered.length : favorites.length + recents.length + providers.reduce((total, provider) => (
    isExpanded(provider.id)
      ? total + provider.models.filter((model) => !isFavorite(prefs, modelKey(model)) && !prefs.recents.includes(modelKey(model))).length
      : total
  ), 0);
  const elsewhereCount = elsewhere.reduce((total, group) => total + group.models.length, 0);
  const hiddenMatchCount = Math.max(0, visibleCandidateCount + elsewhereCount - flatRows.length);
  const shownFavorites = favorites.filter((model) => flatRowIndex.has(modelKey(model)));

  // Keyboard navigation keeps the active row visible inside the scroll area.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(".model-picker-row.active")
      ?.scrollIntoView({ block: "nearest" });
  }, [open, activeKey, emptyIsActive]);

  const closeDetails = () => {
    setDetail(null);
    setDetailAnchor(null);
    setShowDetails(false);
  };
  useEffect(() => {
    closeDetails();
    setActive(null);
    setEmptyActive(false);
    setRenderLimit(MAX_RENDERED_MODELS);
    dispatchPicker({ type: "reset" });
  }, [harnessId]);
  const hoverDetailsModel = showDetails && !emptyIsActive && activeIndex >= 0 ? flatRows[activeIndex] : null;
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
      focusSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, phone]);

  // Desktop keeps the search field mounted at the edge nearest the trigger;
  // `/` or typing on the focused list moves there, seeded with the typed
  // character. Phone has no field: a query it could not show or clear would
  // silently filter the list.
  const searchRef = useRef<HTMLInputElement>(null);
  const setQuery = (query: string) => {
    dispatchPicker({ type: "search", query });
    // A query starts on its first match; clearing it returns to the selection.
    setActive(query.trim() ? 0 : null);
    setEmptyActive(false);
    closeDetails();
  };
  const focusSearch = (seed = "") => {
    if (seed) setQuery(pickerState.query + seed);
    searchRef.current?.focus();
  };
  const clearSearch = () => {
    setQuery("");
    if (!phone) searchRef.current?.focus();
  };
  // Stacked above the popover's own layer: Escape clears a query first.
  useEscape(open && pickerState.query !== "", clearSearch);
  // A desktop query must not outlive its field when the shell turns phone.
  useEffect(() => {
    if (phone && pickerState.query) setQuery("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone]);

  // The harness strip scrolls sideways once it outgrows the surface; open
  // with the selected harness centred (the browser clamps at either end), so
  // it is never clipped or under the strip's edge fade.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const tab = pickerShellRef.current?.querySelector<HTMLElement>('[role="tablist"] [role="tab"][aria-selected="true"]');
      const strip = tab?.closest<HTMLElement>('[role="tablist"]');
      if (!tab || !strip || strip.scrollWidth <= strip.clientWidth) return;
      const tabRect = tab.getBoundingClientRect();
      const stripRect = strip.getBoundingClientRect();
      strip.scrollLeft += (tabRect.left + tabRect.width / 2) - (stripRect.left + stripRect.width / 2);
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const close = () => {
    openRequestRef.current += 1;
    setOpen(false);
    dispatchPicker({ type: "reset" });
    closeDetails();
    setActive(null);
    setEmptyActive(false);
    setRenderLimit(MAX_RENDERED_MODELS);
  };
  const choose = (model: ModelDescriptor) => {
    if (multi) {
      if (selectionFull && !isSelected(model)) return;
      if (phone) tapFeedback();
      onToggle?.({
        providerID: model.providerID,
        modelID: model.modelID,
        ...(model.harnessId ? { harnessId: model.harnessId } : {}),
      });
      return;
    }
    if (phone) tapFeedback();
    const variant = rowThinking(model);
    onPick({
      providerID: model.providerID,
      modelID: model.modelID,
      ...(model.harnessId ? { harnessId: model.harnessId } : {}),
      ...(variant !== undefined ? { variant } : {}),
    });
    if (variant !== undefined) setModelThinking(model, variant);
    noteModelUsed(modelKey(model));
    close();
    if (!phone) triggerRef.current?.focus();
  };
  const isSelected = (model: ModelDescriptor) => multi
    ? selectedModels.some((entry) => modelKey(entry) === modelKey(model))
    : selectedModel
      ? modelKey(selectedModel) === modelKey(model)
      : false;
  const emptySelected = multi ? selection.length === 0 : selectedModel === undefined;
  const rowThinking = (model: ModelDescriptor): string | undefined => {
    const choice = isSelected(model) && selectedThinking !== undefined
      ? selectedThinking
      : thinkingPrefs[thinkingModelKey(model)];
    // Only advertised efforts can be restored. Auto remains an explicit choice.
    return choice === "" || (choice !== undefined && model.variants?.includes(choice))
      ? choice
      : undefined;
  };
  const clearSelection = () => {
    if (phone) tapFeedback();
    onPick(undefined);
    if (multi) return;
    close();
    if (!phone) triggerRef.current?.focus();
  };

  const pickVariant = (model: ModelDescriptor, variant?: string) => {
    if (phone) tapFeedback();
    onPick({
      providerID: model.providerID,
      modelID: model.modelID,
      ...(model.harnessId ? { harnessId: model.harnessId } : {}),
      // Keep Auto distinguishable from a plain model selection for callers
      // that persist model-specific thinking preferences.
      variant: variant ?? "",
    });
    setModelThinking(model, variant ?? "");
    noteModelUsed(modelKey(model));
  };

  const variantMenu = (model: ModelDescriptor) => {
    // A set of models has no per-route thinking choice.
    if (multi || !modelSupportsThinking(model)) return null;
    const variants = [...new Set(model.variants ?? [])];
    if (variants.length === 0) return null;
    const choice = rowThinking(model);
    const explicitVariant = choice || undefined;
    const defaultVariant = model.defaultVariant && variants.includes(model.defaultVariant)
      ? model.defaultVariant
      : undefined;
    const displayVariant = choice === ""
      ? undefined
      : explicitVariant ?? defaultVariant;
    const displayLabel = displayVariant ? thinkingVariantLabel(displayVariant) : tr("composer.auto");
    const entries: MenuEntry[] = [
      {
        id: "auto",
        label: tr("composer.auto"),
        kind: "radio",
        checked: explicitVariant === undefined,
        onSelect: () => pickVariant(model),
      },
      ...variants.map((variant): MenuEntry => ({
        id: variant,
        label: thinkingVariantLabel(variant),
        kind: "radio",
        checked: explicitVariant === variant,
        onSelect: () => pickVariant(model, variant),
      })),
    ];
    return (
      // Menu content is portalled to <body>, but React still bubbles its click
      // through this tree. Stop it here so choosing effort cannot also activate
      // the containing model row with its captured, previous effort.
      <span className="model-thinking-control" onClick={(event) => event.stopPropagation()}>
        <Menu
          label={tr("composer.thinking")}
          title={tr("composer.thinking")}
          entries={entries}
          align="end"
          phonePresentation="popover"
          className="model-thinking-menu"
        >
          {({ ref, onClick, ...triggerProps }) => (
            <button
              ref={ref}
              type="button"
              className="model-thinking-trigger"
              title={tr("composer.thinkingEffortValue", { value: displayLabel })}
              aria-label={tr("composer.thinkingEffortValue", { value: displayLabel })}
              {...triggerProps}
              onClick={(event) => {
                event.stopPropagation();
                onClick();
              }}
            >
              <span>{displayLabel}</span>
              <Icon.chevronDown />
            </button>
          )}
        </Menu>
      </span>
    );
  };

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

  // §22: a picker outside a keep-keyboard surface dismisses the keyboard
  // FIRST and mounts once that promise settles, so its stable anchor captures
  // the final, keyboard-closed position. In the composer the editor holds the
  // keyboard (dismissKeyboard() yields) and the popover anchors above it.
  const toggleOpen = () => {
    if (open) {
      close();
      return;
    }
    const request = ++openRequestRef.current;
    const reveal = () => {
      if (request === openRequestRef.current) setOpen(true);
    };
    if (!phone) {
      reveal();
      return;
    }
    const viewport = getViewportMetrics();
    const keyboardWasOpen = viewport.covering || viewport.keyboardInset > 0;
    const dismissal = dismissKeyboard();
    if (keyboardWasOpen) void dismissal.then(reveal);
    else reveal();
  };

  // A phone browser can dismiss the keyboard on pointer down and then drop
  // the delayed click while the viewport is resizing. Start the same guarded
  // open/close path on touch/pen down, and consume its follow-up click.
  const onTriggerPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") {
      touchTriggerActivationRef.current = false;
      return;
    }
    touchTriggerActivationRef.current = true;
    toggleOpen();
  };
  const onTriggerClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const touchAlreadyActivated = touchTriggerActivationRef.current;
    touchTriggerActivationRef.current = false;
    if (touchAlreadyActivated && event.detail > 0) {
      event.preventDefault();
      return;
    }
    toggleOpen();
  };

  // One keyboard contract for the search field and the focused listbox.
  // Typing a character on the list continues in the field.
  const onListKey = (event: KeyboardEvent<HTMLElement>) => {
    const onList = event.target === listRef.current;
    if (event.currentTarget === listRef.current && !onList) return;
    if (!phone && onList && event.key.length === 1 && event.key !== " " && event.key !== "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      focusSearch(event.key);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setShowDetails(true);
      if (!emptyIsActive) setActive((index) => Math.min((index ?? activeIndex) + 1, Math.max(flatRows.length - 1, 0)));
      else if (flatRows.length > 0) { setEmptyActive(false); setActive(0); }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setShowDetails(true);
      if (emptyRowShown && activeIndex <= 0) setEmptyActive(true);
      else if (!emptyIsActive) setActive((index) => Math.max((index ?? activeIndex) - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setShowDetails(true);
      if (emptyRowShown) setEmptyActive(true);
      else setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setShowDetails(true);
      if (flatRows.length > 0) { setEmptyActive(false); setActive(flatRows.length - 1); }
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (emptyIsActive) { clearSelection(); return; }
      const model = flatRows[activeIndex];
      if (model) choose(model);
    }
  };

  const star = (model: ModelDescriptor) => {
    const favorite = isFavorite(prefs, modelKey(model));
    return (
      <IconButton
        type="button"
        className={`model-star-btn${favorite ? " on" : ""}`}
        icon={FavoriteIcon}
        size="sm"
        variant="ghost"
        pressed={favorite}
        title={favorite ? tr("modelpicker.removeFavorite") : tr("modelpicker.addFavorite")}
        label={favorite
          ? tr("modelpicker.removeValueFromFavorites", { name: model.name })
          : tr("modelpicker.addValueToFavorites", { name: model.name })}
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation();
          toggleModelFavorite(modelKey(model));
        }}
      />
    );
  };

  const capabilityIcons = (model: ModelDescriptor) => {
    const modalities = new Set((model.capabilities ?? []).map((capability) => capability.toLowerCase()));
    const icons: Array<[string, ReactNode]> = [["Text", <Icon.text />]];
    if ([...modalities].some((capability) => capability.endsWith(":image"))) icons.push([tr("modelpicker.image"), <Icon.image />]);
    if ([...modalities].some((capability) => capability.endsWith(":audio"))) icons.push([tr("modelpicker.audio"), <Icon.speaker />]);
    if ([...modalities].some((capability) => capability.endsWith(":video"))) icons.push([tr("modelpicker.video"), <Icon.video />]);
    if (modalities.has("toolcall")) icons.push([tr("modelpicker.toolCalls"), <Icon.workflow />]);
    return <span className="model-capability-icons" aria-label={icons.map(([label]) => label).join(", ")}>{icons.map(([label, icon]) => <span key={label} title={label} aria-hidden="true">{icon}</span>)}</span>;
  };

  const row = (model: ModelDescriptor, group: "favorites" | "recent" | "provider" | "elsewhere") => {
    const selected = isSelected(model);
    const unavailable = selectionFull && !selected;
    const key = modelKey(model);
    const favoriteDrag = group === "favorites";
    return (
      <div
        key={key}
        id={`model-option-${key}`}
        className={`model-picker-row${selected ? " current" : ""}${activeKey === key ? " active" : ""}${dragging?.kind === "favorite" && dragging.id === key ? " dragging" : ""}${dropTarget === key ? " drop-target" : ""}`}
        role="option"
        aria-selected={selected}
        aria-disabled={unavailable || undefined}
        tabIndex={-1}
        onClick={() => choose(model)}
        onMouseEnter={() => {
          const index = flatRowIndex.get(key);
          if (index !== undefined) {
            setDetail(null);
            setDetailAnchor(null);
            setEmptyActive(false);
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
        {variantMenu(model)}
        {!flatCatalog && star(model)}
        {selected && <span className="model-row-selected" aria-hidden="true"><Icon.check /></span>}
      </div>
    );
  };

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      className={`config-chip model-picker-trigger${className ? ` ${className}` : ""}`}
      data-pending={chip.pending ? "true" : undefined}
      title={tr("modelpicker.selectModelCurrentValue", { label })}
      aria-label={tr("modelpicker.selectModelCurrentValue", { label })}
      aria-haspopup="dialog"
      aria-expanded={open}
      onPointerDown={onTriggerPointerDown}
      onPointerCancel={() => { touchTriggerActivationRef.current = false; }}
      onClick={onTriggerClick}
    >
      {triggerModel && (
        <ProviderLogo
          providerID={triggerModel.providerID}
          providerName={triggerModel.providerName}
          harnessId={triggerModel.harnessId}
          size="compact"
          className="model-trigger-logo"
          tint={harnessColors?.get(triggerModel.harnessId ?? harnessId ?? "")}
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
            focusBack={phone}
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

  const searchField = (
    <div className="model-pop-search">
      <span className="model-pop-search-icon" aria-hidden="true"><Icon.search /></span>
      <TextInput
        ref={searchRef}
        uiSize="sm"
        className="model-pop-search-input"
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        value={pickerState.query}
        placeholder={tr("modelpicker.searchModels2")}
        role="combobox"
        aria-label={tr("modelpicker.filterModels")}
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls="model-pop-listbox"
        aria-activedescendant={activeDescendant}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (isImeComposing(event)) return; onListKey(event); }}
      />
      {pickerState.query && (
        <button
          type="button"
          className="model-pop-search-clear"
          title={tr("mobile.sheet.clearSearch")}
          aria-label={tr("mobile.sheet.clearSearch")}
          // Keep the field (and a phone keyboard) focused through the tap.
          onPointerDown={(event) => event.preventDefault()}
          onClick={clearSearch}
        >
          <Icon.close />
        </button>
      )}
    </div>
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
        className="model-pop"
        popoverOverflow="visible"
        initialFocus={!phone ? ".model-pop-search input" : undefined}
      >
        <div ref={pickerShellRef} className="model-picker-shell">
          {/* Harness tabs stay put while searching: a query only filters rows. */}
          {header && (
            <div className="model-picker-bar">
              <div className="model-picker-header">{header}</div>
            </div>
          )}
          {phone && detail ? detailsPanelContent : (
            <div className={`model-pop-content${direction === "up" && !phone ? " search-end" : ""}`}>
              {!phone && searchField}
              <div
                ref={listRef}
                id="model-pop-listbox"
                className="model-picker-list ui-scroll"
                role="listbox"
                aria-label={tr("modelpicker.models")}
                aria-multiselectable={multi || undefined}
                tabIndex={0}
                aria-activedescendant={activeDescendant}
                onKeyDown={onListKey}
              >
                {emptyRowShown && (
                  <div
                    id="model-option-empty"
                    className={`model-picker-row model-picker-row-empty${emptySelected ? " current" : ""}${emptyIsActive ? " active" : ""}`}
                    role="option"
                    aria-selected={emptySelected}
                    tabIndex={-1}
                    onClick={clearSelection}
                    onMouseEnter={() => {
                      setDetail(null);
                      setDetailAnchor(null);
                      setEmptyActive(true);
                    }}
                  >
                    <span className="model-picker-grip spacer" aria-hidden="true" />
                    <span className="model-picker-copy"><strong>{emptyLabel}</strong></span>
                    {emptySelected && <span className="model-row-selected" aria-hidden="true"><Icon.check /></span>}
                  </div>
                )}
                {flatCatalog && filtered.filter((model) => flatRowIndex.has(modelKey(model))).map((model) => row(model, "provider"))}
                {/* Favorites, then recents: one unlabeled quick block. The
                    filled star already marks a favorite; titles were chrome. */}
                {(shownFavorites.length > 0 || recents.length > 0) && (
                  <section className="model-provider-section model-picker-quick">
                    {shownFavorites.map((model) => row(model, "favorites"))}
                    {recents.filter((model) => flatRowIndex.has(modelKey(model))).map((model) => row(model, "recent"))}
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
                      draggable={!phone && !q}
                      onDragStart={(event) => startDrag(event, "provider", provider.id)}
                      onDragOver={allowDrop}
                      onDrop={(event) => {
                        const dragged = dragId(event, "provider");
                        if (dragged) reorderModelProviders(providerIds, dragged, provider.id, preferenceHarnessId);
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
                          providerID={provider.providerID}
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
                {/* Search reaches every runnable harness: matches elsewhere
                    follow this harness's own, grouped under the harness. */}
                {elsewhere.map((group) => {
                  const shown = group.models.filter((model) => flatRowIndex.has(modelKey(model)));
                  if (shown.length === 0) return null;
                  return (
                    <section className="model-provider-section model-picker-elsewhere" key={`elsewhere:${group.harnessId}`}>
                      <div className="model-provider-head static">
                        <ProviderLogo providerID={group.harnessId} providerName={group.name} className="model-provider-logo" />
                        <strong>{group.name}</strong>
                        <small>{group.models.length}</small>
                      </div>
                      {shown.map((model) => row(model, "elsewhere"))}
                    </section>
                  );
                })}
                {filtered.length === 0 && elsewhere.length === 0 && (
                  <div className="palette-empty">
                    {catalogLoading ? tr("common.loading")
                      : !q && hiddenInCatalog > 0 ? tr("modelpicker.allHidden")
                        : hiddenMatches ? tr("modelpicker.hiddenMatches")
                          : tr("modelpicker.noModelsFound")}
                  </div>
                )}
                {hiddenMatchCount > 0 && (phone ? (
                  <button
                    type="button"
                    className="model-picker-more"
                    onClick={() => setRenderLimit((limit) => limit + MAX_RENDERED_MODELS)}
                  >
                    {tr("harnessmodels.showMore", { count: hiddenMatchCount })}
                  </button>
                ) : (
                  <div className="picker-more">{hiddenMatchCount} {tr("picker.moreRefineTheFilter")}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      </ResponsiveOverlay>
      <AdjacentDetailsPanel
        open={open && !phone && detailsOpen}
        anchor={detailsAnchor}
        pickerShellRef={pickerShellRef}
        onClose={closeDetails}
      >
        {detailsPanelContent}
      </AdjacentDetailsPanel>
    </span>
  );
}
