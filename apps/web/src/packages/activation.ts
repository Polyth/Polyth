import type { Unregister, WebPackageHost } from "@polyth/web-sdk";
import { registerProjectContext } from "./projectContext.ts";

function noopUnregister(): void {}

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
  const unregisters: Unregister[] = [];
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
      unregister();
    };
    unregisters.push(wrapped);
    return wrapped;
  };

  const reject = (api: string): Unregister => {
    console.warn(`[polyth] package "${ownerPackageId}" attempted ${api} after disposal`);
    return noopUnregister;
  };

  const scoped: WebPackageHost = {
    ...host,
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
      ...(host.widgets.addToCanvas ? {
        addToCanvas: (definitionId, options) => {
          if (disposed) {
            console.warn(`[polyth] package "${ownerPackageId}" attempted widgets.addToCanvas after disposal`);
            return null;
          }
          return host.widgets.addToCanvas!(definitionId, options);
        },
      } : {}),
    },
    surfaces: {
      register: (definition) => {
        if (disposed) return reject("surfaces.register");
        return track(host.surfaces.register({ ...definition, ownerPackageId }));
      },
    },
    capabilities: {
      register: (definition) => {
        if (disposed) return reject("capabilities.register");
        return track(host.capabilities.register({ ...definition, ownerPackageId }));
      },
      notify: () => host.capabilities.notify(),
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
  };

  return {
    host: scoped,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (let index = unregisters.length - 1; index >= 0; index--) {
        unregisters[index]!();
      }
      unregisters.length = 0;
    },
  };
}
