import ProjectFolderDialog from "../components/ProjectFolderDialog.tsx";
import { setDragResource } from "../dnd.ts";
import ResourceLink from "../components/ResourceLink.tsx";
import { openResource } from "../resources/navigation.ts";
import type {
  CapabilityDefinition,
  PageDefinition,
  SettingsPageDefinition,
  SettingsSearchItem,
  ProjectSettingsContribution,
  SurfaceDefinition,
  WebPackageHost,
  WebStoreSnapshot,
  WidgetDefinition,
  WidgetPlugin,
} from "@polyth/web-sdk";
import { resourceKey } from "@polyth/web-sdk";
import { withDefaultSurfaceContent } from "@polyth/web-sdk/surface-content";
import type { JsonObject } from "@polyth/contracts";
import { describeToolActivity } from "../execution.ts";
import { Icon } from "../icons.tsx";
import { getLocale, tr } from "../i18n/index.ts";
import { highlight, langOf } from "../highlight.ts";
import { MarkdownDoc } from "../markdown.tsx";
import { registerMarkdownFence } from "../markdown/fenceRenderers.ts";
import { requestComposerDictation, requestComposerInsert, requestComposerSubmit } from "../composerInsert.ts";
import { openSession } from "../init.ts";
import { requestConversationReveal } from "../conversationReveal.ts";
import { scopedDraftCacheKey } from "../draftRecord.ts";
import {
  Button,
  Checkbox,
  ComposerNoticeRow,
  EmptyState,
  IconButton,
  Menu,
  Select,
  Tabs,
  Textarea,
  TextInput,
  WorkspaceSurfaceHeader,
} from "../components/ui/index.ts";
import Dialog from "../components/a11y/Dialog.tsx";
import SlotHost from "../components/slots/SlotHost.ts";
import { friendlyError } from "../settings.ts";
import { registerUiPreference } from "../settingsSync.ts";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import {
  closePage,
  closeWorkspacePane,
  getState,
  openPage,
  openSettingsPage,
  openWorkspacePane,
  setActiveView,
  setOverlay,
  setRailPlugin,
  setUiError,
  startNewSession,
  subscribeSessionEvents,
  subscribeStore,
  upsertSession,
  workspaceProjectId,
} from "../store.ts";
import { listSlots, registerSlot } from "../slots.ts";
import { notifications } from "../notify/store.ts";
import { claimSessionListing } from "../sessionListing.ts";
import { registerGrouping } from "../sidebarPrefs.ts";
import { capabilityRailState, placeCapability, subscribeCapabilityPlacement, unplaceCapability } from "../railPlacement.ts";
import type { CapabilityTier } from "../capabilityLayout.ts";
import { notifyCapabilities, registerCapability, type CapabilityDescriptor } from "../capabilities.ts";
import { registerSurface, type RailSurface } from "../surfaces.ts";
import { getPage, registerPage } from "../pages.ts";
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
import { registerProjectSettings, listProjectSettings, subscribeProjectSettings, openProjectSettings } from "../projectSettings.ts";
import {
  clearDraftExecutionConfig,
  readDraftExecutionConfig,
  subscribeDraftExecutionConfig,
  updateDraftExecutionConfig,
} from "../executionDraft.ts";
import { installDefaultHandoffTargets, listHandoffTargets, registerHandoffTarget } from "../handoffTargets.ts";
import {
  composerActiveMode,
  listComposerAddMenuItems,
  listComposerModes,
  listComposerPasteHandlers,
  listComposerSessionCreatedHooks,
  registerComposerAddMenuItem,
  registerComposerMode,
  registerComposerPasteHandler,
  registerComposerSessionCreatedHook,
  requestComposerMode,
  subscribeComposerContributions,
} from "../composer/contributions.ts";
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
  CONVERSATION_PROFILE_ID,
  getWorkbenchProfile,
  listWorkbenchProfileSummaries,
  profileSummary,
  registerWorkbenchProfile,
} from "../workbench/profiles.ts";
import {
  activateWorkbenchNavigationProfile,
  laneSession,
  getWorkbenchNavigationProfileId,
  sendToConversation,
} from "../workbench/profileNavigation.ts";

installDefaultHandoffTargets();
let previousStoreState: ReturnType<typeof getState> | null = null;
let previousSnapshot: WebStoreSnapshot | null = null;
let previousWorkbenchProfileId: string | null = null;
const snapshot = (): WebStoreSnapshot => {
  const state = getState();
  const workbenchProfile = getWorkbenchNavigationProfileId();
  if (state === previousStoreState && previousSnapshot && previousWorkbenchProfileId === workbenchProfile) return previousSnapshot;
  const next: WebStoreSnapshot = {
    activeProjectId: workspaceProjectId(state),
    activeSessionId: state.activeSessionId,
    activeView: state.activeView,
    overlay: state.overlay,
    railPlugin: state.railPlugin,
    workbenchProfile,
    settings: { ...state.settings },
    activePage: state.activePage && getPage(state.activePage.pageId)
      ? { pageId: state.activePage.pageId, resource: state.activePage.resource }
      : null,
  };
  previousStoreState = state;
  previousWorkbenchProfileId = workbenchProfile;
  previousSnapshot = next;
  return next;
};

function publicWorkbenchProfileSummary() {
  const definition = getWorkbenchProfile(getWorkbenchNavigationProfileId())
    ?? getWorkbenchProfile(CONVERSATION_PROFILE_ID)!;
  return profileSummary(definition);
}

function publicWorkbenchSnapshot() {
  return { ...workbenchSnapshot(), activeProfile: getWorkbenchNavigationProfileId() };
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
      registerSurface(withDefaultSurfaceContent(definition) as unknown as RailSurface),
  },
  pages: {
    register: (definition: PageDefinition) => {
      const off = registerPage(definition);
      return () => {
        off();
        // A disabled package takes its open page with it: Chat comes back.
        if (getState().activePage?.pageId === definition.id && !getPage(definition.id)) closePage();
      };
    },
  },
  capabilities: {
    register: (definition: CapabilityDefinition) =>
      registerCapability(definition as CapabilityDescriptor),
    notify: notifyCapabilities,
    placement: (id: string) => capabilityRailState(id),
    place: (id: string, tier: CapabilityTier) => {
      if (tier === "technical") unplaceCapability(id);
      else placeCapability(id, { tier });
    },
    subscribePlacement: subscribeCapabilityPlacement,
  },
  settings: {
    registerPage: (definition: SettingsPageDefinition) =>
      installSettingsPage({ ...definition, packageId: definition.packageId ?? "host" }),
    registerItems: (items: SettingsSearchItem[]) =>
      registerSettingsItems(items),
  },
  preferences: {
    register: registerUiPreference,
  },
  onboarding: {
    registerTour: (tour) => registerPackageOnboarding(tour),
  },
  markdown: {
    registerFence: registerMarkdownFence,
  },
  projectSettings: {
    open: openProjectSettings,
    register: (contribution: ProjectSettingsContribution) =>
      registerProjectSettings(contribution, contribution.ownerPackageId),
    list: (projectId) => listProjectSettings(projectId),
    subscribe: (listener) => subscribeProjectSettings(listener),
  },
  projectContext: {
    register: (contribution) => registerProjectContext(contribution),
  },
  reducers: {
    register: registerWebReducer,
  },
  store: {
    getSnapshot: snapshot,
    subscribe: (listener) => {
      const offStore = subscribeStore(listener);
      const offWorkbench = subscribeWorkbench(listener);
      return () => { offStore(); offWorkbench(); };
    },
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
    get: (sessionId) => getState().sessions.find((session) => session.id === sessionId),
    events: (sessionId) => getState().events[sessionId] ?? [],
    subscribe: subscribeStore,
    subscribeEvents: subscribeSessionEvents,
    claimListing: claimSessionListing,
    registerGrouping: (grouping) => registerGrouping(grouping),
  },
  execution: {
    describe: (tool, input) => describeToolActivity(tool, input as JsonObject),
  },
  conversation: {
    insert: (text) => {
      requestComposerInsert(text);
      closePage();
      setActiveView("session");
    },
    startNewSession: (projectId, seed) => {
      startNewSession(projectId, seed);
    },
    openSession,
    revealEvent: async (sessionId, eventSeq, options) => {
      const scope = scopedDraftCacheKey(sessionId);
      if (options?.signal?.aborted) return false;
      if (getState().activeSessionId !== sessionId) await openSession(sessionId);
      return requestConversationReveal(sessionId, eventSeq, {
        ...options,
        current: () => getState().activeSessionId === sessionId && scopedDraftCacheKey(sessionId) === scope,
      });
    },
    send: sendToConversation,
    dictate: requestComposerDictation,
    submitDraft: requestComposerSubmit,
  },
  navigation: {
    setActiveView: (view) => setActiveView(view as never),
    openSettingsPage,
    openWorkspacePane,
    closeWorkspacePane,
    openPage: (pageId, resource, options) => openPage(pageId, resource ?? null, options ?? {}),
    closePage,
    openRailSurface: setRailPlugin,
    setOverlay: (overlay) => setOverlay(overlay as never),
    openResource,
    revealResource: (ref) => openResource(ref),
  },
  workbench: {
    profiles: {
      register: registerWorkbenchProfile,
      list: listWorkbenchProfileSummaries,
    },
    activateProfile: activateWorkbenchNavigationProfile,
    getProfileSession: (profileId) => laneSession(profileId),
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
    drag: (transfer, resource, options) => setDragResource(transfer, resource, options?.selection, options?.context),
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
    components: {
      FolderPicker: ProjectFolderDialog,
      ResourceLink,
      WorkspaceSurfaceHeader,
      ComposerNoticeRow,
      Button: Button as unknown as WebPackageHost["ui"]["components"]["Button"],
      IconButton: IconButton as unknown as WebPackageHost["ui"]["components"]["IconButton"],
      Menu: Menu as unknown as WebPackageHost["ui"]["components"]["Menu"],
      Tabs: Tabs as unknown as WebPackageHost["ui"]["components"]["Tabs"],
      TextInput: TextInput as unknown as WebPackageHost["ui"]["components"]["TextInput"],
      Textarea: Textarea as unknown as WebPackageHost["ui"]["components"]["Textarea"],
      Checkbox: Checkbox as unknown as WebPackageHost["ui"]["components"]["Checkbox"],
      Select: Select as unknown as WebPackageHost["ui"]["components"]["Select"],
      EmptyState: EmptyState as unknown as WebPackageHost["ui"]["components"]["EmptyState"],
      MarkdownDoc: MarkdownDoc as unknown as WebPackageHost["ui"]["components"]["MarkdownDoc"],
    },
    syntax: { highlight, languageForPath: langOf },
    locale: { get: getLocale, translate: (key, values) => tr(key as Parameters<typeof tr>[0], values) },
  },
  errors: {
    friendly: friendlyError,
    show: (message, action, options) => setUiError(message, action ?? null, undefined, options?.kind),
  },
  notifications,
  handoffTargets: {
    register: registerHandoffTarget,
    list: listHandoffTargets,
  },
  composer: {
    registerAddMenuItem: registerComposerAddMenuItem,
    registerPasteHandler: registerComposerPasteHandler,
    registerSessionCreatedHook: registerComposerSessionCreatedHook,
    listAddMenuItems: listComposerAddMenuItems,
    listPasteHandlers: listComposerPasteHandlers,
    listSessionCreatedHooks: listComposerSessionCreatedHooks,
    registerMode: registerComposerMode,
    listModes: listComposerModes,
    setMode: requestComposerMode,
    activeMode: composerActiveMode,
    subscribe: subscribeComposerContributions,
  },
};
