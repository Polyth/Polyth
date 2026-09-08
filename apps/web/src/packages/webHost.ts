import type {
  CapabilityDefinition,
  OpenResourceOptions,
  ResourceRef,
  SettingsPageDefinition,
  SettingsSearchItem,
  SurfaceDefinition,
  WebPackageHost,
  WebStoreSnapshot,
  WidgetDefinition,
  WidgetPlugin,
} from "@polyth/web-sdk";
import { resourceKey } from "@polyth/web-sdk";
import { Icon } from "../icons.tsx";
import Dialog from "../components/a11y/Dialog.tsx";
import SlotHost from "../components/slots/SlotHost.ts";
import { friendlyError } from "../settings.ts";
import {
  closeWorkspacePane,
  getState,
  openEditorFile,
  openSettingsPage,
  openWorkspacePane,
  setActiveView,
  setOverlay,
  setRailPlugin,
  subscribeStore,
  upsertSession,
} from "../store.ts";
import { listSlots, registerSlot } from "../slots.ts";
import { notifyCapabilities, registerCapability, type CapabilityDescriptor } from "../capabilities.ts";
import { registerSurface, type RailSurface } from "../surfaces.ts";
import { registerSettingsItems } from "../settings/registry.ts";
import { installSettingsPage } from "./settingsPage.ts";
import {
  registerWidget,
  registerWidgetPlugin,
  type WidgetDef,
  type WidgetPlugin as HostWidgetPlugin,
} from "../widgets/catalog.ts";
import { registerWebReducer } from "./reducers.ts";
import { registerProjectContext } from "./projectContext.ts";
import {
  clearDraftExecutionConfig,
  readDraftExecutionConfig,
  subscribeDraftExecutionConfig,
  updateDraftExecutionConfig,
} from "../executionDraft.ts";
import { installDefaultHandoffTargets, listHandoffTargets, registerHandoffTarget } from "../handoffTargets.ts";
import {
  deleteDocument,
  isDocumentDirty,
  openDocument,
  peekDocument,
  subscribeDocuments,
} from "../resources/documents.ts";
import {
  describeResource,
  getResourceProvider,
  registerResourceProvider,
} from "../resources/providers.ts";
import {
  activateWorkbenchProfile,
  getActiveProfileId,
  getActiveProfileSummary,
  resetWorkbenchProfile,
  subscribeWorkbench,
  workbenchCloseSurface,
  workbenchMoveSurface,
  workbenchOpenSurface,
  workbenchSetPresentation,
  workbenchSnapshot,
  workbenchSwapSurfaces,
} from "../workbench/store.ts";
import {
  CONVERSATION_PROFILE,
  CONVERSATION_PROFILE_ID,
  listWorkbenchProfileSummaries,
  profileSummary,
  registerWorkbenchProfile,
} from "../workbench/profiles.ts";

installDefaultHandoffTargets();
/** WorkbenchHost is not live — ContextRail remains the presentation authority. */
const WORKBENCH_HOST_LIVE = false;

function publicWorkbenchProfileId(): string {
  return WORKBENCH_HOST_LIVE ? getActiveProfileId() : CONVERSATION_PROFILE_ID;
}

function publicWorkbenchProfileSummary() {
  return WORKBENCH_HOST_LIVE ? getActiveProfileSummary() : profileSummary(CONVERSATION_PROFILE);
}

function publicWorkbenchSnapshot() {
  const snap = workbenchSnapshot();
  if (WORKBENCH_HOST_LIVE) return snap;
  return { ...snap, activeProfile: CONVERSATION_PROFILE_ID };
}

const snapshot = (): WebStoreSnapshot => {
  const state = getState();
  return {
    activeProjectId: state.activeProjectId,
    activeSessionId: state.activeSessionId,
    activeView: state.activeView,
    overlay: state.overlay,
    railPlugin: state.railPlugin,
    workbenchProfile: publicWorkbenchProfileId(),
    settings: { ...state.settings },
  };
};

function openResource(ref: ResourceRef, options: OpenResourceOptions = {}): void {
  // View routing is deferred — files open through the legacy editor path until
  // ResourceView selection is wired end-to-end.
  if (ref.scheme === "file") {
    openEditorFile(ref.locator, options.selection ? {
      path: ref.locator,
      startLine: options.selection.startLine,
      endLine: options.selection.endLine,
      column: options.selection.column,
    } : undefined);
    return;
  }
  openWorkspacePane(ref.scheme, `${ref.scheme}:${ref.locator}`);
}

export const webPackageHost: WebPackageHost = {
  slots: {
    register: ({ slot, id, render, order, meta, ownerPackageId }) =>
      registerSlot(slot, id, render, order, meta, ownerPackageId),
    list: (slot) => listSlots(slot).map(({ id, order, meta }) => ({ id, order, ...(meta ? { meta } : {}) })),
  },
  widgets: {
    register: (pluginId: string, definition: WidgetDefinition) =>
      registerWidget({
        ...definition,
        pluginId,
        ...(definition.ownerPackageId ? { ownerPackageId: definition.ownerPackageId } : {}),
      } as unknown as WidgetDef),
    registerPlugin: (plugin: WidgetPlugin) =>
      registerWidgetPlugin({
        ...plugin,
        ...(plugin.ownerPackageId ? { ownerPackageId: plugin.ownerPackageId } : {}),
        widgets: plugin.widgets?.map((widget) => ({
          ...widget,
          ...(widget.ownerPackageId ? { ownerPackageId: widget.ownerPackageId } : {}),
        })),
      } as unknown as HostWidgetPlugin),
  },
  surfaces: {
    register: (definition: SurfaceDefinition) =>
      registerSurface(definition as unknown as RailSurface),
  },
  capabilities: {
    register: (definition: CapabilityDefinition) =>
      registerCapability(definition as CapabilityDescriptor),
    notify: notifyCapabilities,
  },
  settings: {
    registerPage: (definition: SettingsPageDefinition) =>
      installSettingsPage({ ...definition, packageId: definition.packageId ?? "host" }),
    registerItems: (items: SettingsSearchItem[]) =>
      registerSettingsItems(items),
  },
  projectContext: {
    register: (contribution) => registerProjectContext(contribution),
  },
  reducers: {
    register: registerWebReducer,
  },
  store: {
    getSnapshot: snapshot,
    subscribe: subscribeStore,
    select: (selector) => selector(snapshot()),
  },
  executionDraft: {
    get: readDraftExecutionConfig,
    update: updateDraftExecutionConfig,
    clear: clearDraftExecutionConfig,
    subscribe: subscribeDraftExecutionConfig,
  },
  sessions: {
    upsert: upsertSession,
  },
  navigation: {
    setActiveView: (view) => setActiveView(view as never),
    openSettingsPage,
    openWorkspacePane,
    closeWorkspacePane,
    openRailSurface: setRailPlugin,
    setOverlay: (overlay) => setOverlay(overlay as never),
    openResource,
    revealResource: (ref) => openResource(ref),
    closeResource: (ref) => { deleteDocument(ref); },
  },
  workbench: {
    profiles: {
      register: registerWorkbenchProfile,
      list: listWorkbenchProfileSummaries,
    },
    activateProfile: (profileId) => WORKBENCH_HOST_LIVE ? activateWorkbenchProfile(profileId) : false,
    getActiveProfile: publicWorkbenchProfileSummary,
    getSnapshot: publicWorkbenchSnapshot,
    subscribe: subscribeWorkbench,
    openSurface: workbenchOpenSurface,
    closeSurface: (surfaceId) => { workbenchCloseSurface(surfaceId); },
    moveSurface: workbenchMoveSurface,
    swapSurfaces: workbenchSwapSurfaces,
    setPresentation: workbenchSetPresentation,
    resetProfileLayout: resetWorkbenchProfile,
  },
  resources: {
    registerProvider: registerResourceProvider,
    getProvider: getResourceProvider,
    describe: describeResource,
    key: resourceKey,
    notifyMoved: (from, to) => { peekDocument(from)?.moveTo(to); },
    notifyRemoved: (ref) => { deleteDocument(ref); },
    documents: {
      open: openDocument,
      isDirty: isDocumentDirty,
      subscribe: subscribeDocuments,
    },
  },
  ui: {
    icons: Icon,
    Dialog,
    Slot: SlotHost,
  },
  errors: {
    friendly: friendlyError,
  },
  handoffTargets: {
    register: registerHandoffTarget,
    list: listHandoffTargets,
  },
};
