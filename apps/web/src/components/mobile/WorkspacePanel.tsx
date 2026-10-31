import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { projectKinds } from "@polyth/contracts/project-composition";
import { useResolvedCapabilities } from "../../capabilities.ts";
import { toggleCapability } from "../../builtinCapabilities.ts";
import { getCapabilityPlacements } from "../../capabilityLayout.ts";
import { successFeedback, tapFeedback } from "../../haptics.ts";
import { scheduleSurfaceExit } from "../../motionPresence.ts";
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
import { getWidget, useWidgetCatalog } from "../../widgets/catalog.ts";
import {
  setWidgetConfig,
  updateWidgetLayout,
  useWidgetLayout,
  widgetDefinitionId,
} from "../../widgets/widgetLayout.ts";
import {
  createWorkspacePanelLayout,
  defaultPanelWidgetIds,
  insertPanelItem,
  panelItemCatalog,
  panelItemLabel,
  panelWidgetAvailable,
  parseWorkspacePanelLayout,
  removePanelItem,
  stablePanelCatalog,
  updatePanelItem,
  workspacePanelStorageKey,
  type PanelItemDefinition,
  type PanelItemInstance,
  type WorkspacePanelLayout,
} from "../../workspacePanel.ts";
import ViewErrorBoundary from "../ViewErrorBoundary.ts";
import { Button, ChevronRightIcon, Icon, LayersIcon, PlusIcon } from "../ui/index.ts";
import Sheet, { type SheetStackPhase } from "./Sheet.tsx";
import WorkspaceEditor from "./WorkspaceEditor.tsx";
import WorkspaceGallery from "./WorkspaceGallery.tsx";

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
/** How long newcomers from the Add page stay marked in the editor. */
const FRESH_MARK_MS = 2400;
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

function LayoutItem({ item }: { item: PanelItemInstance }) {
  if (item.type === "divider") return <div className="workspace-panel-divider" role="separator" />;
  if (item.type === "header") {
    return <h3 className="workspace-panel-heading">{panelItemLabel(item) || tr("workspace.panel.headingPlaceholder")}</h3>;
  }
  return <div className="workspace-panel-labeled-divider" role="separator">
    <i />
    <span>{panelItemLabel(item) || tr("workspace.panel.sectionPlaceholder")}</span>
    <i />
  </div>;
}

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
  // The registries hand out fresh objects on every read: keep unchanged
  // definitions (and the list) identical, so memoized rows skip their renders.
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
  // Once Edit has been switched, the content that replaces the other mode
  // fades in (the first render of the layer rides its own entrance instead).
  const [modeSwitched, setModeSwitched] = useState(false);
  const [gallery, setGallery] = useState<GalleryState>("closed");
  const [layout, setLayout] = useState(() => storedLayout(projectId, catalog, defaults));
  const [announcement, setAnnouncement] = useState("");
  const [historySize, setHistorySize] = useState(0);
  const [visitAdds, setVisitAdds] = useState<ReadonlySet<string>>(NOTHING_FRESH);
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(NOTHING_FRESH);
  const [sheet, setSheet] = useState<HTMLElement | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const history = useRef<HistoryEntry[]>([]);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const galleryPage = useRef<HTMLElement | null>(null);
  const hostRef = useCallback((node: HTMLElement | null) => {
    if (node) setSheet(node.closest<HTMLElement>(".workspace-panel-sheet"));
  }, []);

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
  // under the Swipe navigation setting), the layer following the finger —
  // while editing too. A reorder only starts from a still press or a grip, so
  // a moving finger is never one; once an item is lifted the drag owns the
  // touch. The Add page has its own swipe, back to the editor.
  const swipeZone = swipeZoneInHost(useUiSettings().swipeNavigation);
  useEdgeSwipeBack({
    enabled: swipeZone !== null && gallery === "closed" && stackPhase !== "covered" && !closing && !peeking,
    ...(swipeZone ? { zone: swipeZone } : {}),
    canStart: () => sheet?.dataset.arrangeDragging !== "true",
    layer: () => document.querySelector<HTMLElement>(".sheet-backdrop[data-stack] > .workspace-panel-sheet"),
    onBack: () => requestPanelClose(),
  });

  /** Save a layout. While editing, `record` keeps the previous one for Undo. */
  const commit = (next: WorkspacePanelLayout, message?: string, record: boolean | string = true) => {
    const previous = layoutRef.current;
    if (next === previous) return;
    if (editing && record !== false) {
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
  const undo = () => {
    const entry = history.current.pop();
    if (!entry) return;
    setHistorySize(history.current.length);
    commit(entry.layout, tr("workspace.panel.undone"), false);
    tapFeedback();
  };
  const defaultLayout = useMemo(
    () => createWorkspacePanelLayout(catalog, defaults.launchers, defaults.widgets),
    [catalog, defaults],
  );
  const reset = () => {
    commit(defaultLayout, tr("workspace.panel.resetDone"));
    successFeedback();
  };

  const open = (definition: PanelItemDefinition) => {
    if (editing || !definition.capabilityId) return;
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

  // ---- the Add page ------------------------------------------------------
  const openGallery = () => {
    setVisitAdds(NOTHING_FRESH);
    setFreshIds(NOTHING_FRESH);
    setGallery("open");
  };
  const closeGallery = () => {
    if (gallery !== "open") return;
    setGallery("closing");
    // What arrived during the visit is marked once the editor shows again.
    const present = new Set(layoutRef.current.items.map((item) => item.id));
    setFreshIds(new Set([...visitAdds].filter((id) => present.has(id))));
  };
  useEffect(() => {
    if (gallery !== "closing") return;
    // The editor is live again as soon as the page starts to leave (it is
    // revealed underneath), so focus can return to Add at once.
    addButtonRef.current?.focus({ preventScroll: true });
    return scheduleSurfaceExit(() => setGallery("closed"), "--motion-stack");
  }, [gallery]);
  useEffect(() => {
    if (freshIds.size === 0) return;
    const timer = window.setTimeout(() => setFreshIds(NOTHING_FRESH), FRESH_MARK_MS);
    return () => window.clearTimeout(timer);
  }, [freshIds]);
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
  // An edge swipe pops the Add page back to the editor, the editor following.
  useEdgeSwipeBack({
    enabled: swipeZone !== null && gallery === "open" && stackPhase !== "covered" && !closing && !peeking,
    ...(swipeZone ? { zone: swipeZone } : {}),
    layer: () => galleryPage.current,
    under: () => sheet,
    // The editor's head and body play the settle-back; the sheet only carries the values.
    underMotion: () => sheet?.querySelector<HTMLElement>(":scope > .sheet-head") ?? null,
    onBack: closeGallery,
  });

  const startEditing = () => {
    setModeSwitched(true);
    setEditing(true);
  };
  const finishEditing = () => {
    setModeSwitched(true);
    leaveEditing();
  };
  const suggested = useMemo(() => kindWidgets.map((id) => `widget:${id}`), [kindWidgets]);
  const galleryShown = editing && gallery !== "closed";

  return <Sheet
    title={editing ? tr("workspace.panel.editTitle") : tr("workspace.panel.title")}
    size="tall"
    className={`mobile-tools-sheet workspace-panel-sheet${editing ? " is-editing" : ""}${modeSwitched ? " is-mode-switched" : ""}${galleryShown ? gallery === "open" ? " is-gallery-open" : " is-gallery-closing" : ""}`}
    closing={closing}
    peeking={peeking}
    // Escape (and the hidden Back behind the Add page) steps back one level.
    onClose={() => { if (editing && gallery === "open") closeGallery(); else requestPanelClose(); }}
    // A full-screen destination: Back leads (where the swipe goes), and
    // editing is a mode the switch turns on and off rather than a place.
    dismiss="back"
    {...(stackPhase ? { stackPhase } : {})}
    {...(restoreFocusRef ? { restoreFocusRef } : {})}
    action={{ kind: "switch", label: tr("common.edit"), pressed: editing, onClick: editing ? finishEditing : startEditing }}
  >
    <span ref={hostRef} hidden />
    {editing ? <WorkspaceEditor
      layout={layout}
      definitions={definitions}
      catalogSize={catalog.length}
      freshIds={freshIds}
      covered={editing && gallery === "open"}
      canUndo={historySize > 0}
      canReset={layoutSignature(layout) !== layoutSignature(defaultLayout)}
      host={sheet}
      addButtonRef={addButtonRef}
      onOpenGallery={openGallery}
      onCommit={commit}
      onUndo={undo}
      onReset={reset}
    /> : <>
      <div className="workspace-panel-items" aria-label={tr("workspace.panel.title")}>
        {layout.items.map((item) => {
          const definition = definitions.get(item.definitionId);
          if (!definition) return null;
          const widget = definition.widgetId ? getWidget(definition.widgetId) : undefined;
          const placement = definition.widgetId
            ? widgetLayout.widgets[Object.keys(widgetLayout.widgets).find((id) => widgetDefinitionId(widgetLayout, id) === definition.widgetId) ?? definition.widgetId]
            : undefined;
          const ItemIcon = definition.type === "launcher" ? railIconFor(definition.capabilityId ?? definition.sourcePackage) : widget ? widgetIconFor(widget) : null;
          const config = placement?.config ?? item.config;
          // A widget with nothing to show (a session widget with no active
          // session) is omitted entirely, not rendered as an empty state.
          if (!panelWidgetAvailable(definition, widget, false, { projectId, sessionId, config })) return null;
          const updateConfig = (next: typeof item.config) => {
            if (widget && placement) {
              const instanceId = Object.keys(widgetLayout.widgets).find((id) => widgetDefinitionId(widgetLayout, id) === widget.id) ?? widget.id;
              updateWidgetLayout((current) => setWidgetConfig(current, instanceId, next));
            }
            commit(updatePanelItem(layoutRef.current, item.id, { config: next }));
          };
          return <section
            key={item.id}
            data-panel-instance={item.id}
            className={`workspace-panel-item workspace-panel-item--${definition.type} workspace-panel-item--${item.size}`}
          >
            {definition.type === "launcher" ? <button className="workspace-panel-launcher" type="button" onClick={() => open(definition)}>
              {ItemIcon && <ItemIcon />}
              <span>{definition.title}</span>
            </button> : definition.type === "widget" && widget ? <>
              <button className="workspace-panel-widget-head" type="button" disabled={!definition.capabilityId} onClick={() => open(definition)}>
                {ItemIcon && <ItemIcon />}<strong>{definition.title}</strong>{definition.capabilityId && <ChevronRightIcon className="workspace-panel-disclosure" aria-hidden="true" />}
              </button>
              <div className="workspace-panel-widget-body">
                <ViewErrorBoundary inline resetKey={`${item.id}:${projectId ?? ""}:${sessionId ?? ""}`}>
                  {widget.render({ projectId, sessionId, editing: false, instanceId: item.id, config, updateConfig, panelSize: item.size })}
                </ViewErrorBoundary>
              </div>
            </> : <LayoutItem item={item} />}
          </section>;
        })}
      </div>
      {layout.items.length === 0 && <div className="workspace-panel-empty">
        <span className="workspace-panel-empty-icon" aria-hidden="true"><Icon icon={LayersIcon} size="xl" /></span>
        <strong>{tr("workspace.panel.emptyTitle")}</strong>
        <p>{tr("workspace.panel.emptyDetail")}</p>
        <Button variant="primary" iconStart={PlusIcon} onClick={() => { startEditing(); openGallery(); }}>
          {tr("workspace.panel.addTitle")}
        </Button>
      </div>}
    </>}

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
