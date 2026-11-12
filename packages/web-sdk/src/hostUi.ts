// Host UI for module scope. A package whose feature files import their
// building blocks at the top (instead of reading `host.ui` inside each render)
// binds them once to its configured host. Every component and glyph resolves
// from that host when it renders, so a test or a host swap never leaves a
// stale reference behind, and the package never imports the shell itself.
import { createElement, type ComponentType } from "react";
import type { WebIconComponent, WebIconName, WebIconSet, WebPackageHost } from "./index.ts";

type HostComponents = WebPackageHost["ui"]["components"];
export type BoundHostComponents = { readonly [K in keyof HostComponents]-?: NonNullable<HostComponents[K]> };

export interface BoundHostUi {
  components: BoundHostComponents;
  iconSet: WebIconSet;
  confirm: NonNullable<WebPackageHost["ui"]["confirm"]>;
  tabIds: NonNullable<WebPackageHost["ui"]["tabIds"]>;
}

function unavailable(owner: string, what: string): Error {
  return new Error(`${owner}: host.ui.${what} is unavailable`);
}

function lazyRecord<T extends object>(resolve: (name: string) => ComponentType<object> | undefined, label: (name: string) => string, owner: string): T {
  const cache = new Map<string, ComponentType<object>>();
  return new Proxy({} as T, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      let part = cache.get(key);
      if (!part) {
        const Part = (props: object) => {
          const Impl = resolve(key);
          if (!Impl) throw unavailable(owner, label(key));
          return createElement(Impl, props);
        };
        Part.displayName = `HostUi(${key})`;
        part = Part;
        cache.set(key, part);
      }
      return part;
    },
  });
}

/** Bind host UI parts for module-scope imports. `getHost` is read on every
 *  render and call; `owner` names the package in errors. */
export function bindHostUi(getHost: () => WebPackageHost | null, owner = "Package"): BoundHostUi {
  const ui = () => getHost()?.ui;
  return {
    components: lazyRecord<BoundHostComponents>(
      (name) => ui()?.components?.[name as keyof HostComponents] as ComponentType<object> | undefined,
      (name) => `components.${name}`,
      owner,
    ),
    iconSet: lazyRecord<WebIconSet>(
      (name) => ui()?.iconSet?.[name as WebIconName] as WebIconComponent | undefined as ComponentType<object> | undefined,
      (name) => `iconSet.${name}`,
      owner,
    ),
    confirm: (message, options) => {
      const confirm = ui()?.confirm;
      if (!confirm) return Promise.reject(unavailable(owner, "confirm"));
      return confirm(message, options);
    },
    tabIds: {
      tab: (idBase, id) => {
        const ids = ui()?.tabIds;
        if (!ids) throw unavailable(owner, "tabIds");
        return ids.tab(idBase, id);
      },
      panel: (idBase, id) => {
        const ids = ui()?.tabIds;
        if (!ids) throw unavailable(owner, "tabIds");
        return ids.panel(idBase, id);
      },
    },
  };
}
