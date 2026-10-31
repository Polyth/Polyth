import type {
  ComposerMode,
  ComposerSessionCreatedHook,
  Unregister,
  WebNotificationHandle,
  WebNotificationInput,
  WebNotificationPatch,
  WebPackageHost,
} from "@polyth/web-sdk";
import { listRegisteredCapabilities } from "../capabilities.ts";
import { registerProjectContext } from "./projectContext.ts";

function noopUnregister(): void {}

type HostNotifications = NonNullable<WebPackageHost["notifications"]>;

/**
 * A package's view of the shared notification stack. Its ids live in its own
 * namespace (`<package>:<id>`), so it can replace, update or dismiss only what
 * it showed — never the host's or another package's — and everything it left
 * on screen goes when the package is disposed. Handles report the package's
 * own id back.
 */
function scopeNotifications(
  ownerPackageId: string,
  notifications: HostNotifications,
  isDisposed: () => boolean,
): { api: HostNotifications; dispose(): void } {
  const live = new Set<string>();
  let anonymous = 0;
  const full = (id: string) => `${ownerPackageId}:${id}`;
  const forget = (id: string) => { live.delete(id); };
  const refused = (id: string): WebNotificationHandle => ({ id, update: () => {}, dismiss: () => {} });
  const update = (id: string, patch: WebNotificationPatch): boolean => {
    if (isDisposed() || !live.has(id)) return false;
    return notifications.update(full(id), patch);
  };
  const dismiss = (id: string): void => {
    if (!live.has(id)) return;
    forget(id);
    notifications.dismiss(full(id));
  };
  const api: HostNotifications = {
    show(input: WebNotificationInput): WebNotificationHandle {
      const id = input.id ?? `n${++anonymous}`;
      if (isDisposed()) {
        console.warn(`[polyth] package "${ownerPackageId}" attempted notifications.show after disposal`);
        return refused(id);
      }
      live.add(id);
      const onDismiss = input.onDismiss;
      notifications.show({
        ...input,
        id: full(id),
        onDismiss: (reason) => {
          forget(id);
          onDismiss?.(reason);
        },
      });
      return { id, update: (patch) => { update(id, patch); }, dismiss: () => dismiss(id) };
    },
    update,
    dismiss,
  };
  return {
    api,
    dispose() {
      for (const id of [...live]) dismiss(id);
    },
  };
}

/**
 * One activation-scoped host for a single owner package. Every registration
 * made through this host is tracked and disposed with the activation.
 * After dispose, later register attempts are ignored and do not mutate live
 * registries.
 */
export function createPackageActivation(
  ownerPackageId: string,
  host: WebPackageHost,
): {
  host: WebPackageHost;
  dispose(): void;
} {
  const unregisters = new Set<Unregister>();
  let disposed = false;

  const track = (unregister: Unregister): Unregister => {
    if (disposed) {
      unregister();
      return noopUnregister;
    }
    let live = true;
    const wrapped: Unregister = () => {
      if (!live) return;
      live = false;
      unregisters.delete(wrapped);
      unregister();
    };
    unregisters.add(wrapped);
    return wrapped;
  };

  const reject = (api: string): Unregister => {
    console.warn(`[polyth] package "${ownerPackageId}" attempted ${api} after disposal`);
    return noopUnregister;
  };

  const ownsCapability = (id: string): boolean =>
    listRegisteredCapabilities().some((capability) => capability.id === id && capability.ownerPackageId === ownerPackageId);

  const markdown = host.markdown;
  const pages = host.pages;
  const notifications = host.notifications
    ? scopeNotifications(ownerPackageId, host.notifications, () => disposed)
    : null;
  const scoped: WebPackageHost = {
    ...host,
    ...(notifications ? { notifications: notifications.api } : {}),
    slots: {
      list: host.slots.list,
      register: (registration) => {
        if (disposed) return reject("slots.register");
        return track(host.slots.register({
          ...registration,
          ownerPackageId,
          ...(registration.projectAffinity
            ? { meta: { ...(registration.meta ?? {}), projectAffinity: registration.projectAffinity } }
            : {}),
        }));
      },
    },
    widgets: {
      register: (pluginId, definition) => {
        if (disposed) return reject("widgets.register");
        return track(host.widgets.register(pluginId, { ...definition, ownerPackageId }));
      },
      registerPlugin: (plugin) => {
        if (disposed) return reject("widgets.registerPlugin");
        return track(host.widgets.registerPlugin({
          ...plugin,
          ownerPackageId,
          widgets: plugin.widgets?.map((widget) => ({ ...widget, ownerPackageId })),
        }));
      },
    },
    surfaces: {
      register: (definition) => {
        if (disposed) return reject("surfaces.register");
        return track(host.surfaces.register({ ...definition, ownerPackageId }));
      },
    },
    ...(pages
      ? {
          pages: {
            register: (definition) => {
              if (disposed) return reject("pages.register");
              return track(pages.register({ ...definition, ownerPackageId }));
            },
          },
        }
      : {}),
    capabilities: {
      register: (definition) => {
        if (disposed) return reject("capabilities.register");
        return track(host.capabilities.register({ ...definition, ownerPackageId }));
      },
      notify: () => host.capabilities.notify(),
      // A package places only the capabilities it registered itself.
      placement: (id) => ownsCapability(id) ? host.capabilities.placement?.(id) ?? null : null,
      place: (id, tier) => {
        if (!disposed && ownsCapability(id)) host.capabilities.place?.(id, tier);
      },
      subscribePlacement: (listener) => track(host.capabilities.subscribePlacement?.(listener) ?? (() => {})),
    },
    settings: {
      registerPage: (definition) => {
        if (disposed) return reject("settings.registerPage");
        return track(host.settings.registerPage({ ...definition, packageId: ownerPackageId }));
      },
      registerItems: (items) => {
        if (disposed) return reject("settings.registerItems");
        return track(host.settings.registerItems(
          items.map((item) => ({ ...item, ownerPackageId })),
        ));
      },
    },
    ...(markdown
      ? {
          markdown: {
            registerFence: (registration) => {
              if (disposed) return reject("markdown.registerFence");
              return track(markdown.registerFence({ ...registration, ownerPackageId }));
            },
          },
        }
      : {}),
    preferences: {
      register: (id, adapter) => {
        if (disposed) return reject("preferences.register");
        return track(host.preferences.register(id, adapter));
      },
    },
    ...(host.onboarding
      ? {
          onboarding: {
            registerTour: (tour) => {
              if (disposed) return reject("onboarding.registerTour");
              return track(host.onboarding!.registerTour(tour));
            },
          },
        }
      : {}),
    projectSettings: {
      list: host.projectSettings.list,
      subscribe: host.projectSettings.subscribe,
      register: (contribution) => {
        if (disposed) return reject("projectSettings.register");
        return track(host.projectSettings.register({ ...contribution, ownerPackageId }));
      },
    },
    projectContext: {
      register: (contribution) => {
        if (disposed) return reject("projectContext.register");
        return track(registerProjectContext(contribution, ownerPackageId));
      },
    },
    reducers: {
      register: (eventType, reducer) => {
        if (disposed) return reject("reducers.register");
        return track(host.reducers.register(eventType, reducer));
      },
    },
    sessions: {
      ...host.sessions,
      subscribeEvents: (listener) => {
        if (disposed) return reject("sessions.subscribeEvents");
        return track(host.sessions.subscribeEvents(listener));
      },
      ...(host.sessions?.claimListing ? {
        claimListing: (purpose: string) => {
          if (disposed) return reject("sessions.claimListing");
          return track(host.sessions.claimListing!(purpose));
        },
      } : {}),
      ...(host.sessions?.registerGrouping ? {
        registerGrouping: (grouping) => {
          if (disposed) return reject("sessions.registerGrouping");
          return track(host.sessions.registerGrouping!(grouping));
        },
      } : {}),
    },
    workbench: {
      ...host.workbench,
      profiles: {
        ...host.workbench.profiles,
        register: (definition) => {
          if (disposed) return reject("workbench.profiles.register");
          return track(host.workbench.profiles.register({ ...definition, ownerPackageId }));
        },
      },
    },
    resources: {
      ...host.resources,
      registerProvider: (provider) => {
        if (disposed) return reject("resources.registerProvider");
        return track(host.resources.registerProvider(provider));
      },
    },
    ...(host.composer
      ? {
          composer: {
            listAddMenuItems: host.composer.listAddMenuItems,
            listPasteHandlers: host.composer.listPasteHandlers,
            subscribe: (listener) => {
              if (disposed) return reject("composer.subscribe");
              return track(host.composer!.subscribe(listener));
            },
            registerAddMenuItem: (item) => {
              if (disposed) return reject("composer.registerAddMenuItem");
              return track(host.composer!.registerAddMenuItem(item));
            },
            registerPasteHandler: (handler) => {
              if (disposed) return reject("composer.registerPasteHandler");
              return track(host.composer!.registerPasteHandler(handler));
            },
            ...(host.composer.registerSessionCreatedHook
              ? {
                  registerSessionCreatedHook: (hook: ComposerSessionCreatedHook) => {
                    if (disposed) return reject("composer.registerSessionCreatedHook");
                    return track(host.composer!.registerSessionCreatedHook!(hook));
                  },
                }
              : {}),
            ...(host.composer.listSessionCreatedHooks
              ? { listSessionCreatedHooks: host.composer.listSessionCreatedHooks }
              : {}),
            ...(host.composer.registerMode
              ? {
                  registerMode: (mode: ComposerMode) => {
                    if (disposed) return reject("composer.registerMode");
                    return track(host.composer!.registerMode!(mode));
                  },
                }
              : {}),
            ...(host.composer.listModes ? { listModes: host.composer.listModes } : {}),
            ...(host.composer.setMode ? { setMode: host.composer.setMode } : {}),
            ...(host.composer.activeMode ? { activeMode: host.composer.activeMode } : {}),
          },
        }
      : {}),
  };

  return {
    host: scoped,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unregister of [...unregisters].reverse()) unregister();
      unregisters.clear();
      notifications?.dispose();
    },
  };
}
