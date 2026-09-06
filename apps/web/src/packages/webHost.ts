import type {
  CapabilityDefinition,
  SettingsPageDefinition,
  SettingsSearchItem,
  SurfaceDefinition,
  WebPackageHost,
  WebStoreSnapshot,
  WidgetDefinition,
  WidgetPlugin,
} from "@polyth/web-sdk";
import { Icon } from "../icons.tsx";
import Dialog from "../components/a11y/Dialog.tsx";
import { friendlyError } from "../settings.ts";
import {
  getState,
  openSettingsPage,
  openWorkspacePane,
  closeWorkspacePane,
  setActiveView,
  setOverlay,
  setRailPlugin,
  subscribeStore,
} from "../store.ts";
import { registerSlot } from "../slots.ts";
import { registerCapability, type CapabilityDescriptor } from "../capabilities.ts";
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

const snapshot = (): WebStoreSnapshot => {
  const state = getState();
  return {
    activeProjectId: state.activeProjectId,
    activeSessionId: state.activeSessionId,
    activeView: state.activeView,
    overlay: state.overlay,
    railPlugin: state.railPlugin,
    settings: { ...state.settings },
  };
};

export const webPackageHost: WebPackageHost = {
  slots: {
    register: ({ slot, id, render, order, meta, ownerPackageId }) =>
      registerSlot(slot, id, render, order, meta, ownerPackageId),
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
  navigation: {
    setActiveView: (view) => setActiveView(view as never),
    openSettingsPage,
    openWorkspacePane,
    closeWorkspacePane,
    openRailSurface: setRailPlugin,
    setOverlay: (overlay) => setOverlay(overlay as never),
  },
  ui: {
    icons: Icon,
    Dialog,
  },
  errors: {
    friendly: friendlyError,
  },
};
