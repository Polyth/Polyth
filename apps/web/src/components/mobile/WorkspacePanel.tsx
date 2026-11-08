// The phone Workspace: one live grid of app tiles, widgets and layout items
// that is also its own editor, the way an iOS Home Screen is.
//   * Holding any item (or an empty spot) turns editing on; the held item rises
//     under the finger at once, so the same press carries on as a drag
//     (workspaceArrange.ts `activate`). The Edit button under the grid does
//     the same for anyone who does not long-press.
//   * While editing everything jiggles (compositor-only `rotate`), a corner
//     minus removes, a widget's size pill cycles its sizes, headings and
//     labelled dividers are edited in place, items are dragged (a still touch
//     lifts) or moved with arrow keys, and Undo walks back the session.
//   * The header trades Back for Add (+) and Done; Done, Escape or a tap on an
//     empty spot end editing. Adding is a page of its own (WorkspaceGallery.tsx).
// Live widgets stay mounted throughout — editing never remounts them; while
// editing their content is inert, so a press reaches the item, not the widget.
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { projectKinds } from "@polyth/contracts/project-composition";
import { confirmAlert } from "../../alerts.ts";
import { useResolvedCapabilities } from "../../capabilities.ts";
import { toggleCapability } from "../../builtinCapabilities.ts";
import { getCapabilityPlacements } from "../../capabilityLayout.ts";
import { hapticFeedback, selectionFeedback, successFeedback, tapFeedback } from "../../haptics.ts";
import { motionIsReduced, scheduleSurfaceExit } from "../../motionPresence.ts";
import { packageLayerPresented } from "../../mobileLayerStack.ts";
import {
  isProjectContributionRelevant,
  projectRailPlanContext,
  projectRelevanceVersion,
  subscribeProjectRelevance,
} from "../../packages/projectRelevance.ts";
import { useEdgeSwipeBack } from "../../useEdgeSwipeBack.ts";
import { swipeZoneInHost } from "../../shellSwipe.ts";
import { useUiSettings } from "../../uiPrefs.ts";
import {
  markProjectPresentationChanged,
  PROJECT_PRESENTATION_HYDRATED_EVENT,
  projectPresentationEventHasKey,
  projectPresentationEventProjectId,
} from "../../projectPresentationSync.ts";
import { railIconFor, widgetIconFor } from "../../railIcons.ts";
import { tr } from "../../i18n/index.ts";
import { getState, useStore, workspaceProjectId } from "../../store.ts";
import { getWidget, useWidgetCatalog, type WidgetDef } from "../../widgets/catalog.ts";
import {
  setWidgetConfig,
  updateWidgetLayout,
  useWidgetLayout,
  widgetDefinitionId,
  type WidgetLayout,
} from "../../widgets/widgetLayout.ts";
import { ARRANGE_ACTIVATE_MS, useArrange, type ArrangeEngine, type ArrangeItem } from "../../workspaceArrange.ts";
import {
  createWorkspacePanelLayout,
  defaultPanelWidgetIds,
  insertPanelItem,
  panelItemCatalog,
  panelItemLabel,
  panelWidgetAvailable,
  parseWorkspacePanelLayout,
  permutePanelItems,
  removePanelItem,
  stablePanelCatalog,
  updatePanelItem,
  workspacePanelStorageKey,
  type PanelItemDefinition,
  type PanelItemInstance,
  type WorkspacePanelLayout,
} from "../../workspacePanel.ts";
import ViewErrorBoundary from "../ViewErrorBoundary.ts";
import { Button, ChevronRightIcon, EditIcon, Icon, LayersIcon, MinusIcon, PlusIcon, RefreshIcon, UndoIcon } from "../ui/index.ts";
import Sheet, { type SheetStackPhase } from "./Sheet.tsx";
import WorkspaceGallery, { PANEL_SIZE_LABELS, PanelItemGlyph } from "./WorkspaceGallery.tsx";

interface PanelDefaults {
  /** The project's arranged rail launchers, in rail order. */
  launchers: readonly string[];
  /** The project kind's default summary widgets. */
  widgets: readonly string[];
}

/** Undo steps kept for one editing session. */
const HISTORY_LIMIT = 40;
/** Keystrokes into one label within this window undo as one step. */
const HISTORY_COALESCE_MS = 2000;
/** How long newcomers from the Add page stay marked. */
const FRESH_MARK_MS = 2400;
/** How long a removed item takes to shrink away before the rest closes up. */
const REMOVE_EXIT_MS = 160;
/** Finger travel that turns a hold on an empty spot into a scroll. */
const HOLD_SLOP_PX = 8;
/** Jiggle phases: items start their wobble at different points, so the grid
 *  shimmers instead of swaying in step. */
const JIGGLE_PHASES = 7;
const NOTHING_FRESH: ReadonlySet<string> = new Set();

type GalleryState = "closed" | "open" | "closing";

interface HistoryEntry {
  layout: WorkspacePanelLayout;
  /** Coalescing key (one label's typing burst), or null. */
  key: string | null;
  at: number;
}

function storedLayout(projectId: string | null, catalog: readonly PanelItemDefinition[], defaults: PanelDefaults): WorkspacePanelLayout {
  if (!projectId) return createWorkspacePanelLayout(catalog, defaults.launchers, defaults.widgets);
  try { return parseWorkspacePanelLayout(localStorage.getItem(workspacePanelStorageKey(projectId)), catalog, defaults.launchers, defaults.widgets); }
  catch { return createWorkspacePanelLayout(catalog, defaults.launchers, defaults.widgets); }
}

function persist(projectId: string | null, layout: WorkspacePanelLayout): void {
  if (!projectId) return;
  try {
    localStorage.setItem(workspacePanelStorageKey(projectId), JSON.stringify(layout));
    markProjectPresentationChanged(projectId, "workspacePanel");
  } catch { /* private/full */ }
}

const layoutSignature = (layout: WorkspacePanelLayout): string =>
  layout.items.map((item) => `${item.definitionId}:${item.size}:${JSON.stringify(item.config)}`).join("|");

function itemName(item: PanelItemInstance, definition: PanelItemDefinition): string {
  return panelItemLabel(item) || definition.title;
}

/** A stable phase for an item, from its id: reordering never restarts a wobble. */
function jigglePhase(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0;
  return Math.abs(hash) % JIGGLE_PHASES;
}

/** The live config of a widget item: its workbench placement's, else its own. */
function widgetInstance(layout: WidgetLayout, widgetId: string): string {
  return Object.keys(layout.widgets).find((id) => widgetDefinitionId(layout, id) === widgetId) ?? widgetId;
}

/** Shrink an item away, then report back (at once with motion off). */
function playRemoval(element: HTMLElement | null, done: () => void): void {
  if (!element || motionIsReduced() || typeof element.animate !== "function") {
    done();
    return;
  }
  element.dataset.leaving = "true";
  const animation = element.animate(
    [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.6)" }],
    { duration: REMOVE_EXIT_MS, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
  );
  let finished = false;
  const once = () => {
    if (finished) return;
    finished = true;
    done();
  };
  animation.addEventListener("finish", once);
  animation.addEventListener("cancel", once);
  window.setTimeout(once, REMOVE_EXIT_MS + 80);
}

interface ItemActions {
  open(definitionId: string): void;
  remove(id: string): void;
  cycleSize(id: string): void;
  setLabel(id: string, label: string): void;
  updateConfig(id: string, config: PanelItemInstance["config"]): void;
}

const PanelItem = memo(function PanelItem({
  item,
  definition,
  widget,
  config,
  available,
  editing,
  hole,
  fresh,
  engine,
  actions,
  projectId,
  sessionId,
  keyboardHintId,
}: {
  item: PanelItemInstance;
  definition: PanelItemDefinition;
  widget: WidgetDef | undefined;
  config: PanelItemInstance["config"];
  /** The widget has something to show (always true for other items). */
  available: boolean;
  editing: boolean;
  hole: boolean;
  fresh: boolean;
  engine: ArrangeEngine;
  actions: ItemActions;
  projectId: string | null;
  sessionId: string | null;
  keyboardHintId: string;
}) {
  const name = itemName(item, definition);
  const label = panelItemLabel(item);
  const ItemIcon = definition.type === "launcher"
    ? railIconFor(definition.capabilityId ?? definition.sourcePackage)
    : widget ? widgetIconFor(widget) : null;
  const sized = editing && definition.type === "widget" && definition.supportedSizes.length > 1;
  const sizeLabel = tr(PANEL_SIZE_LABELS[item.size]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!editing || event.target !== event.currentTarget) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      actions.remove(item.id);
      return;
    }
    engine.onArrangeKey(item.id, event);
  };
  const className = `workspace-panel-item workspace-panel-item--${definition.type} workspace-panel-item--${item.size}`
    + `${hole ? " is-hole" : ""}${fresh ? " is-fresh" : ""}${!available ? " is-dormant" : ""}`;
  // While editing, the item's own content is inert: a press lands on the item
  // (to lift it), never on a launcher or a widget's buttons.
  const still = editing || undefined;

  let content;
  if (definition.type === "launcher") {
    content = <button className="workspace-panel-launcher" type="button" inert={still} onClick={() => actions.open(definition.id)}>
      {ItemIcon && <ItemIcon />}
      <span>{definition.title}</span>
    </button>;
  } else if (definition.type === "widget") {
    content = <>
      <button className="workspace-panel-widget-head" type="button" inert={still} disabled={!definition.capabilityId} onClick={() => actions.open(definition.id)}>
        {ItemIcon && <ItemIcon />}<strong>{definition.title}</strong>
        {definition.capabilityId && !sized && <ChevronRightIcon className="workspace-panel-disclosure" aria-hidden="true" />}
      </button>
      <div className="workspace-panel-widget-body" inert={still}>
        {widget && available ? <ViewErrorBoundary inline resetKey={`${item.id}:${projectId ?? ""}:${sessionId ?? ""}`}>
          {widget.render({
            projectId,
            sessionId,
            editing: false,
            instanceId: item.id,
            config,
            updateConfig: (next) => actions.updateConfig(item.id, next),
            panelSize: item.size,
          })}
        </ViewErrorBoundary> : <p className="workspace-panel-widget-dormant">{tr("workspace.panel.dormant")}</p>}
      </div>
    </>;
  } else if (definition.type === "header") {
    content = editing ? <input
      className="workspace-panel-label workspace-panel-label--heading"
      data-arrange-control=""
      value={label}
      placeholder={tr("workspace.panel.headingPlaceholder")}
      aria-label={tr("workspace.panel.headingLabel")}
      enterKeyHint="done"
      onChange={(event) => actions.setLabel(item.id, event.target.value)}
    /> : <h3 className="workspace-panel-heading">{label || tr("workspace.panel.headingPlaceholder")}</h3>;
  } else if (definition.type === "labeled-divider") {
    content = <div className="workspace-panel-labeled-divider" role="separator">
      <i />
      {editing ? <input
        className="workspace-panel-label"
        data-arrange-control=""
        value={label}
        placeholder={tr("workspace.panel.sectionPlaceholder")}
        aria-label={tr("workspace.panel.dividerLabel")}
        enterKeyHint="done"
        onChange={(event) => actions.setLabel(item.id, event.target.value)}
      /> : <span>{label || tr("workspace.panel.sectionPlaceholder")}</span>}
      <i />
    </div>;
  } else {
    content = <div className="workspace-panel-divider" role="separator" />;
  }

  return <section
    data-panel-instance={item.id}
    className={className}
    style={{ "--jiggle-phase": jigglePhase(item.id) } as CSSProperties}
    {...engine.itemProps(item.id)}
    {...(editing ? {
      tabIndex: 0,
      "aria-label": name,
      "aria-describedby": keyboardHintId,
      onKeyDown,
    } : {})}
  >
    {content}
    {editing && <button
      type="button"
      className="workspace-panel-remove"
      data-arrange-control=""
      aria-label={tr("workspace.panel.removeValue", { value: name })}
      onClick={() => actions.remove(item.id)}
    >
      <Icon icon={MinusIcon} size="sm" />
    </button>}
    {sized && <button
      type="button"
      className="workspace-panel-size"
      data-arrange-control=""
      aria-label={tr("workspace.panel.sizeValue", { value: definition.title, size: sizeLabel })}
      onClick={() => actions.cycleSize(item.id)}
    >
      <span key={item.size}>{sizeLabel}</span>
    </button>}
  </section>;
});

export interface WorkspacePanelProps {
  /** Ask the layer host to dismiss the Workspace (it keeps the frame mounted through the exit). */
  onClose: () => void;
  /** Presentation-only exit state owned by the layer host. */
  closing?: boolean;
  /** Layer-stack role: `covered` while a package window sits on top. */
  stackPhase?: SheetStackPhase;
  /** Mounted only because a swipe from Chat is pulling it in (inert until released). */
  peeking?: boolean;
  /** Where focus returns when the Workspace finally closes. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

export default function WorkspacePanel({ onClose, closing = false, stackPhase, peeking = false, restoreFocusRef }: WorkspacePanelProps) {
  const projectId = useStore(workspaceProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const capabilities = useResolvedCapabilities();
  const widgets = useWidgetCatalog();
  const widgetLayout = useWidgetLayout();
  const keyboardHintId = useId();
  // The registries hand out fresh objects on every read: keep unchanged
  // definitions (and the list) identical, so memoized items skip their renders.
  const catalogRef = useRef<readonly PanelItemDefinition[]>([]);
  const catalog = stablePanelCatalog(catalogRef.current, panelItemCatalog(capabilities, widgets));
  catalogRef.current = catalog;
  const definitions = useMemo(() => new Map(catalog.map((item) => [item.id, item])), [catalog]);
  const relevanceVersion = useSyncExternalStore(subscribeProjectRelevance, projectRelevanceVersion);
  const railLaunchers = useMemo(() => {
    const placements = getCapabilityPlacements();
    if (Object.keys(placements).length === 0) return [];
    return capabilities.filter(({ descriptor, tier }) => descriptor.id !== "session" && tier !== "technical").map(({ descriptor }) => descriptor.id);
  }, [capabilities]);
  // Until the project's composition is known its kind is unknown: show no
  // default widgets rather than another kind's (nothing is persisted here).
  const kindWidgets = useMemo(() => {
    const plan = projectRailPlanContext(projectId);
    if (plan === null) return [];
    return defaultPanelWidgetIds(projectKinds(plan.composition, { personal: plan.personal })).filter((id) => {
      const definition = definitions.get(`widget:${id}`);
      return definition !== undefined
        && isProjectContributionRelevant(definition.sourcePackage, getWidget(id)?.projectAffinity);
    });
  }, [definitions, projectId, relevanceVersion]);
  const kindWidgetsKey = kindWidgets.join("|");
  const railLaunchersKey = railLaunchers.join("|");
  const defaults = useMemo<PanelDefaults>(
    () => ({ launchers: railLaunchers, widgets: kindWidgets }),
    [railLaunchersKey, kindWidgetsKey],
  );
  const [editing, setEditing] = useState(false);
  // Once editing has been turned on or off, the header controls that replace
  // the other mode's settle in (the layer's first render rides its own entrance).
  const [modeSwitched, setModeSwitched] = useState(false);
  const [gallery, setGallery] = useState<GalleryState>("closed");
  const [layout, setLayout] = useState(() => storedLayout(projectId, catalog, defaults));
  const [announcement, setAnnouncement] = useState("");
  // Where a held item would land, spoken as it moves (rendered with the hole).
  const [dragMessage, setDragMessage] = useState("");
  const [historySize, setHistorySize] = useState(0);
  const [visitAdds, setVisitAdds] = useState<ReadonlySet<string>>(NOTHING_FRESH);
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(NOTHING_FRESH);
  const [sheet, setSheet] = useState<HTMLElement | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const history = useRef<HistoryEntry[]>([]);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  const galleryPage = useRef<HTMLElement | null>(null);
  const grid = useRef<HTMLDivElement | null>(null);
  const hostRef = useCallback((node: HTMLElement | null) => {
    if (node) setSheet(node.closest<HTMLElement>(".workspace-panel-sheet"));
  }, []);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const covered = editing && gallery === "open";

  const clearHistory = () => {
    history.current = [];
    setHistorySize(0);
  };
  const leaveEditing = () => {
    clearHistory();
    setGallery("closed");
    setVisitAdds(NOTHING_FRESH);
    setFreshIds(NOTHING_FRESH);
    setEditing(false);
  };

  useEffect(() => {
    setLayout(storedLayout(projectId, catalog, defaults));
    leaveEditing();
  }, [projectId]);
  // The project's kind (composition) and its rail arrangement can arrive after
  // the panel opened — a fresh device (the native app gets a new origin, so an
  // empty cache, on every connection) reads them from the server only then. An
  // uncustomized panel picks up that kind's widgets and those rail launchers;
  // a saved layout wins. Packages register their launchers and widgets after
  // the shell starts, and the layer can mount early as an idle underlay.
  // Re-read the saved layout as the catalog fills in, so a stored item shows up
  // without a project switch.
  const catalogKey = useMemo(() => catalog.map((item) => item.id).join("|"), [catalog]);
  useEffect(() => {
    if (!editing) setLayout(storedLayout(projectId, catalog, defaults));
  }, [kindWidgetsKey, railLaunchersKey, catalogKey]);
  useEffect(() => {
    const onHydrated = (event: Event) => {
      if (projectPresentationEventProjectId(event) !== projectId || !projectPresentationEventHasKey(event, "workspacePanel")) return;
      setLayout(storedLayout(projectId, catalog, defaults));
    };
    window.addEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, onHydrated);
    return () => window.removeEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, onHydrated);
  }, [catalog, defaults, projectId]);

  // The host owns presence: asking it to close starts the exit at once and it
  // unmounts the layer when the motion ends. A follow-up that is not a package
  // window (switching to Chat, Edit workspace) waits for that exit so the new
  // state arrives as the Workspace leaves, never underneath a half-drawn one.
  // It is deliberately not cancelled by unmount: the layer is gone by then.
  const requestPanelClose = (afterClose?: () => void) => {
    if (closing) return;
    onClose();
    if (afterClose) scheduleSurfaceExit(afterClose, "--motion-stack");
  };

  // Swipe toward the inline end to leave for Chat (from the edge, or anywhere
  // under the Swipe navigation setting), the layer following the finger. Not
  // while editing: that mode ends with Done, Escape or a tap on an empty spot,
  // as a Home Screen's does. The Add page has its own swipe, back to editing.
  const swipeZone = swipeZoneInHost(useUiSettings().swipeNavigation);
  useEdgeSwipeBack({
    enabled: swipeZone !== null && !editing && stackPhase !== "covered" && !closing && !peeking,
    ...(swipeZone ? { zone: swipeZone } : {}),
    canStart: () => sheet?.dataset.arrangeDragging !== "true",
    layer: () => document.querySelector<HTMLElement>(".sheet-backdrop[data-stack] > .workspace-panel-sheet"),
    onBack: () => requestPanelClose(),
  });

  /** Save a layout. While editing, `record` keeps the previous one for Undo. */
  const commit = (next: WorkspacePanelLayout, message?: string, record: boolean | string = true) => {
    const previous = layoutRef.current;
    if (next === previous) return;
    if (editingRef.current && record !== false) {
      const key = typeof record === "string" ? record : null;
      const now = Date.now();
      const last = history.current[history.current.length - 1];
      if (key !== null && last?.key === key && now - last.at < HISTORY_COALESCE_MS) last.at = now;
      else history.current = [...history.current.slice(1 - HISTORY_LIMIT), { layout: previous, key, at: now }];
      setHistorySize(history.current.length);
    }
    layoutRef.current = next;
    setLayout(next);
    persist(projectId, next);
    if (message) setAnnouncement(message);
  };
  const latest = useRef({ commit, definitions, widgetLayout, open: (_definitionId: string) => {} });

  const defaultLayout = useMemo(
    () => createWorkspacePanelLayout(catalog, defaults.launchers, defaults.widgets),
    [catalog, defaults],
  );

  const open = (definitionId: string) => {
    const definition = definitions.get(definitionId);
    if (editing || !definition?.capabilityId) return;
    const capability = capabilities.find(({ descriptor }) => descriptor.id === definition.capabilityId)?.descriptor;
    if (!capability) return;
    const capabilityId = definition.capabilityId;
    if (capabilityId === "workspace-edit") {
      requestPanelClose(() => toggleCapability(capabilityId, capability.open));
      return;
    }
    // A package window opens ABOVE the Workspace: this layer stays mounted
    // underneath, so Back from the window is a true pop back to this screen.
    capability.open();
    // Anything that did not present a window (e.g. switching to Chat) leaves
    // the Workspace instead.
    if (!packageLayerPresented(getState())) requestPanelClose();
  };
  latest.current = { commit, definitions, widgetLayout, open };

  // ---- the arrangement ---------------------------------------------------
  // What the grid draws: items this device can render; outside editing, a
  // widget with nothing to show (a session widget with no chat open) is left
  // out entirely rather than drawn empty. Editing shows it, dormant, so it can
  // still be moved or removed.
  const shown = useMemo(() => layout.items.flatMap((item) => {
    const definition = definitions.get(item.definitionId);
    if (!definition) return [];
    const widget = definition.widgetId ? getWidget(definition.widgetId) : undefined;
    const config = widget ? widgetLayout.widgets[widgetInstance(widgetLayout, widget.id)]?.config ?? item.config : item.config;
    const available = panelWidgetAvailable(definition, widget, false, { projectId, sessionId, config });
    if (!available && !editing) return [];
    return [{ item, definition, widget, config, available }];
  }), [definitions, editing, layout, projectId, sessionId, widgetLayout]);
  const byId = useMemo(() => new Map(shown.map((entry) => [entry.item.id, entry])), [shown]);
  const arrangeItems = useMemo<ArrangeItem[]>(
    () => shown.map(({ item }) => ({ id: item.id, shape: item.type === "launcher" ? "tile" : "row" })),
    [shown],
  );
  const nameOf = (id: string): string => {
    const item = layoutRef.current.items.find((entry) => entry.id === id);
    const definition = item ? latest.current.definitions.get(item.definitionId) : undefined;
    return item && definition ? itemName(item, definition) : "";
  };

  const startEditing = (animate = true) => {
    if (editingRef.current) return;
    if (animate) engine.animateNextLayout();
    setModeSwitched(true);
    editingRef.current = true;
    setEditing(true);
  };
  const finishEditing = () => {
    if (!editingRef.current) return;
    engine.animateNextLayout();
    setModeSwitched(true);
    editingRef.current = false;
    leaveEditing();
    tapFeedback();
    // Focus stays on the screen: on the Edit button that turns it back on.
    requestAnimationFrame(() => editButtonRef.current?.focus({ preventScroll: true }));
  };

  const { engine, order, draggingId } = useArrange({
    items: arrangeItems,
    enabled: editing && gallery === "closed" && !closing,
    scroller: () => grid.current?.closest<HTMLElement>(".sheet-body") ?? null,
    ghostHost: () => sheet,
    // Holding an item outside editing turns editing on and lifts it at once.
    activate: () => {
      if (editingRef.current || closing || peeking || stackPhase === "covered") return false;
      flushSync(() => startEditing(false));
      return true;
    },
    onCommit: (next, id) => latest.current.commit(
      permutePanelItems(layoutRef.current, next),
      tr("workspace.panel.movedValue", { value: nameOf(id), position: next.indexOf(id) + 1, count: next.length }),
    ),
    onMove: (id, index, count) => setDragMessage(
      tr("workspace.panel.movedValue", { value: nameOf(id), position: index + 1, count }),
    ),
  });
  const listRef = useCallback((element: HTMLDivElement | null) => {
    grid.current = element;
    engine.listRef(element);
  }, [engine]);

  // One stable object, so memoized items skip renders while a drag moves the hole.
  const actions = useMemo<ItemActions>(() => ({
    open(definitionId) { latest.current.open(definitionId); },
    remove(id) {
      const element = [...grid.current?.querySelectorAll<HTMLElement>("[data-arrange-id]") ?? []]
        .find((node) => node.dataset.arrangeId === id) ?? null;
      if (element?.dataset.leaving) return;
      const name = nameOf(id);
      playRemoval(element, () => {
        engine.animateNextLayout();
        latest.current.commit(removePanelItem(layoutRef.current, id), tr("workspace.panel.removedValue", { value: name }));
        hapticFeedback("tap");
      });
    },
    cycleSize(id) {
      const current = layoutRef.current;
      const item = current.items.find((entry) => entry.id === id);
      const definition = item ? latest.current.definitions.get(item.definitionId) : undefined;
      if (!item || !definition || definition.supportedSizes.length < 2) return;
      const at = Math.max(0, definition.supportedSizes.indexOf(item.size));
      const size = definition.supportedSizes[(at + 1) % definition.supportedSizes.length]!;
      // The widget grows or shrinks; what sits below glides with it.
      engine.animateNextLayout();
      latest.current.commit(
        updatePanelItem(current, id, { size }),
        tr("workspace.panel.sizeChangedValue", { value: definition.title, size: tr(PANEL_SIZE_LABELS[size]) }),
      );
      selectionFeedback();
    },
    setLabel(id, label) {
      const current = layoutRef.current;
      const item = current.items.find((entry) => entry.id === id);
      if (!item) return;
      latest.current.commit(updatePanelItem(current, id, { config: { ...item.config, label } }), undefined, `label:${id}`);
    },
    updateConfig(id, next) {
      const item = layoutRef.current.items.find((entry) => entry.id === id);
      const definition = item ? latest.current.definitions.get(item.definitionId) : undefined;
      const widgetId = definition?.widgetId;
      const placements = latest.current.widgetLayout;
      if (widgetId && Object.keys(placements.widgets).some((key) => widgetDefinitionId(placements, key) === widgetId)) {
        const instanceId = widgetInstance(placements, widgetId);
        updateWidgetLayout((current) => setWidgetConfig(current, instanceId, next));
      }
      latest.current.commit(updatePanelItem(layoutRef.current, id, { config: next }));
    },
  }), [engine]);

  const undo = () => {
    const entry = history.current.pop();
    if (!entry) return;
    setHistorySize(history.current.length);
    engine.animateNextLayout();
    commit(entry.layout, tr("workspace.panel.undone"), false);
    tapFeedback();
  };
  const reset = async () => {
    const confirmed = await confirmAlert(tr("workspace.panel.resetConfirm"), {
      title: tr("workspace.panel.resetConfirmTitle"),
      confirmLabel: tr("workspace.panel.resetAction"),
      destructive: true,
    });
    if (!confirmed) return;
    engine.animateNextLayout();
    commit(defaultLayout, tr("workspace.panel.resetDone"));
    successFeedback();
  };

  // ---- the Add page ------------------------------------------------------
  const openGallery = () => {
    setVisitAdds(NOTHING_FRESH);
    setFreshIds(NOTHING_FRESH);
    setGallery("open");
  };
  const closeGallery = () => {
    if (gallery !== "open") return;
    setGallery("closing");
    // What arrived during the visit is marked once the grid shows again.
    const present = new Set(layoutRef.current.items.map((item) => item.id));
    setFreshIds(new Set([...visitAdds].filter((id) => present.has(id))));
  };
  useEffect(() => {
    if (gallery !== "closing") return;
    // The grid is live again as soon as the page starts to leave (it is
    // revealed underneath), so focus can return to Add at once.
    addButtonRef.current?.focus({ preventScroll: true });
    return scheduleSurfaceExit(() => setGallery("closed"), "--motion-stack");
  }, [gallery]);
  useEffect(() => {
    if (freshIds.size === 0) return;
    const timer = window.setTimeout(() => setFreshIds(NOTHING_FRESH), FRESH_MARK_MS);
    return () => window.clearTimeout(timer);
  }, [freshIds]);
  // Back from the Add page: bring the first newcomer into view.
  useEffect(() => {
    if (covered || freshIds.size === 0) return;
    const element = [...grid.current?.querySelectorAll<HTMLElement>("[data-arrange-id]") ?? []]
      .find((node) => freshIds.has(node.dataset.arrangeId ?? ""));
    element?.scrollIntoView?.({ block: "nearest", behavior: motionIsReduced() ? "auto" : "smooth" });
  }, [covered, freshIds]);
  const addFromGallery = (definition: PanelItemDefinition) => {
    const { layout: next, id } = insertPanelItem(layoutRef.current, definition);
    if (!id) return;
    commit(next, tr("workspace.panel.addedValue", { value: definition.title }));
    setVisitAdds((current) => new Set([...current, id]));
    successFeedback();
  };
  const removeFromGallery = (definition: PanelItemDefinition) => {
    const item = layoutRef.current.items.find((entry) => entry.definitionId === definition.id);
    if (!item) return;
    commit(removePanelItem(layoutRef.current, item.id), tr("workspace.panel.removedValue", { value: definition.title }));
    setVisitAdds((current) => new Set([...current].filter((id) => id !== item.id)));
    tapFeedback();
  };
  // An edge swipe pops the Add page back to the grid, the grid following.
  useEdgeSwipeBack({
    enabled: swipeZone !== null && gallery === "open" && stackPhase !== "covered" && !closing && !peeking,
    ...(swipeZone ? { zone: swipeZone } : {}),
    layer: () => galleryPage.current,
    under: () => sheet,
    // The grid's head and body play the settle-back; the sheet only carries the values.
    underMotion: () => sheet?.querySelector<HTMLElement>(":scope > .sheet-head") ?? null,
    onBack: closeGallery,
  });

  // ---- the empty spots ---------------------------------------------------
  // Holding an empty spot turns editing on, as on a Home Screen; while
  // editing, a tap on one is Done.
  const hold = useRef<{ pointerId: number; x: number; y: number; timer: number } | null>(null);
  const endHold = () => {
    if (!hold.current) return;
    window.clearTimeout(hold.current.timer);
    hold.current = null;
  };
  useEffect(() => endHold, []);
  const emptySpot = (target: EventTarget | null): boolean => {
    const element = target as Element | null;
    return typeof element?.closest === "function"
      && !element.closest("[data-arrange-id], button, a, input, textarea, select, [contenteditable], .workspace-panel-empty");
  };
  const onCanvasPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (editing || hold.current || !emptySpot(event.target) || (event.pointerType === "mouse" && event.button !== 0)) return;
    const pointerId = event.pointerId;
    hold.current = {
      pointerId,
      x: event.clientX,
      y: event.clientY,
      timer: window.setTimeout(() => {
        hold.current = null;
        if (closing || peeking || stackPhase === "covered") return;
        startEditing();
        hapticFeedback("tap");
      }, ARRANGE_ACTIVATE_MS),
    };
  };
  const onCanvasPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const pending = hold.current;
    if (pending && event.pointerId === pending.pointerId
      && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > HOLD_SLOP_PX) endHold();
  };
  const onCanvasClick = (event: MouseEvent<HTMLDivElement>) => {
    if (editing && gallery === "closed" && emptySpot(event.target)) finishEditing();
  };

  const suggested = useMemo(() => kindWidgets.map((id) => `widget:${id}`), [kindWidgets]);
  const galleryShown = editing && gallery !== "closed";
  const canUndo = historySize > 0;
  const canReset = layoutSignature(layout) !== layoutSignature(defaultLayout);

  return <Sheet
    title={editing ? tr("workspace.panel.editTitle") : tr("workspace.panel.title")}
    size="tall"
    className={`mobile-tools-sheet workspace-panel-sheet${editing ? " is-editing" : ""}${modeSwitched ? " is-mode-switched" : ""}${galleryShown ? gallery === "open" ? " is-gallery-open" : " is-gallery-closing" : ""}`}
    closing={closing}
    peeking={peeking}
    // Escape steps back one level: the Add page, then editing, then the Workspace.
    onClose={() => {
      if (editing && gallery === "open") closeGallery();
      else if (editing) finishEditing();
      else requestPanelClose();
    }}
    // A full-screen destination: Back leads (where the swipe goes). Editing
    // trades it for Add and Done, the way a Home Screen in jiggle mode does.
    dismiss={editing ? "none" : "back"}
    {...(stackPhase ? { stackPhase } : {})}
    {...(restoreFocusRef ? { restoreFocusRef } : {})}
    {...(editing ? {
      headerTrailing: <div className="workspace-edit-bar" inert={covered || undefined}>
        <button type="button" className="workspace-edit-add" ref={addButtonRef} aria-label={tr("workspace.panel.addTitle")} onClick={openGallery}>
          <Icon icon={PlusIcon} size="lg" />
        </button>
        <button type="button" className="workspace-edit-done" onClick={finishEditing}>{tr("common.done")}</button>
      </div>,
    } : {})}
  >
    <span ref={hostRef} hidden />
    <div
      className="workspace-panel-canvas"
      inert={covered || undefined}
      onPointerDown={onCanvasPointerDown}
      onPointerMove={onCanvasPointerMove}
      onPointerUp={endHold}
      onPointerCancel={endHold}
      onClick={onCanvasClick}
    >
      <span className="sr-only" id={keyboardHintId}>{tr("workspace.panel.keyboardHint")}</span>
      <span className="sr-only" role="status" aria-live="polite">{dragMessage}</span>
      <div
        className="workspace-panel-items"
        ref={listRef}
        aria-label={editing ? tr("workspace.panel.arrangementLabel") : tr("workspace.panel.title")}
        data-arranging={draggingId ? "" : undefined}
      >
        {order.map((id) => {
          const entry = byId.get(id);
          if (!entry) return null;
          return <PanelItem
            key={id}
            item={entry.item}
            definition={entry.definition}
            widget={entry.widget}
            config={entry.config}
            available={entry.available}
            editing={editing}
            hole={draggingId === id}
            fresh={freshIds.has(id)}
            engine={engine}
            actions={actions}
            projectId={projectId}
            sessionId={sessionId}
            keyboardHintId={keyboardHintId}
          />;
        })}
      </div>

      {shown.length === 0 && <div className="workspace-panel-empty">
        <span className="workspace-panel-empty-icon" aria-hidden="true"><Icon icon={LayersIcon} size="xl" /></span>
        <strong>{tr("workspace.panel.emptyTitle")}</strong>
        <p>{tr("workspace.panel.emptyDetail")}</p>
        <Button variant="primary" iconStart={PlusIcon} onClick={() => { startEditing(); openGallery(); }}>
          {tr("workspace.panel.addTitle")}
        </Button>
      </div>}

      {/* The way in for anyone who does not long-press, and the way back to
          the default once in. Both sit after the last item. */}
      {shown.length > 0 && <div className="workspace-panel-foot">
        {editing ? (
          <Button variant="ghost" size="sm" iconStart={RefreshIcon} disabled={!canReset} onClick={() => { void reset(); }}>
            {tr("workspace.panel.reset")}
          </Button>
        ) : <>
          <button type="button" className="workspace-panel-edit-entry" ref={editButtonRef} onClick={() => { startEditing(); hapticFeedback("tap"); }}>
            <Icon icon={EditIcon} size="sm" />
            <span>{tr("common.edit")}</span>
          </button>
          <small className="workspace-panel-edit-tip">{tr("workspace.panel.holdToEdit")}</small>
        </>}
      </div>}
    </div>

    {/* Floating over the bottom edge while editing: the hint until there is
        something to undo, then Undo. One place, so neither shifts the grid. */}
    {editing && !covered && sheet && shown.length > 0 && createPortal(
      <div className="workspace-edit-dock">
        {canUndo ? (
          <button type="button" className="workspace-edit-undo" onClick={undo}>
            <Icon icon={UndoIcon} size="sm" />
            <span>{tr("workspace.panel.undo")}</span>
          </button>
        ) : <p className="workspace-edit-hint">{tr("workspace.panel.arrangeHint")}</p>}
      </div>,
      sheet,
    )}

    {galleryShown && sheet && <>
      {createPortal(<div className="workspace-gallery-veil" aria-hidden="true" />, sheet)}
      <WorkspaceGallery
        host={sheet}
        catalog={catalog}
        layout={layout}
        suggested={suggested}
        addedCount={visitAdds.size}
        closing={gallery === "closing"}
        onAdd={addFromGallery}
        onRemove={removeFromGallery}
        onClose={closeGallery}
        pageRef={(element) => { galleryPage.current = element; }}
      />
    </>}

    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
  </Sheet>;
}
