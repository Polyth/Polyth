import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type {
  SettingsPageDefinition,
  WebPackageHost,
  WidgetDefinition,
  WidgetPlugin,
} from "@polyth/web-sdk";
import { createPackageActivation } from "../src/packages/activation.ts";
import {
  activateWebPackage,
  attachPackageStyles,
  loadWebPackageCatalog,
  type WebPackageAsset,
} from "../src/packages/webEntries.ts";

const sampleAsset = (over: Partial<WebPackageAsset> = {}): WebPackageAsset => ({
  id: "sample",
  module: "/packages/sample/entry.js",
  styles: [],
  ...over,
});

type RecordingHost = WebPackageHost & {
  widgetsList: Array<{ pluginId: string; id: string; ownerPackageId?: string }>;
  plugins: Array<{ id: string; ownerPackageId?: string }>;
  pages: Array<{ id: string; packageId?: string }>;
  capabilityIds: string[];
  surfaceIds: string[];
  slotIds: string[];
  items: string[];
};

const createHost = (): RecordingHost => {
  const widgetsList: RecordingHost["widgetsList"] = [];
  const plugins: RecordingHost["plugins"] = [];
  const pages: RecordingHost["pages"] = [];
  const capabilityIds: string[] = [];
  const surfaceIds: string[] = [];
  const slotIds: string[] = [];
  const items: string[] = [];
  const host = {
    widgetsList,
    plugins,
    pages,
    capabilityIds,
    surfaceIds,
    slotIds,
    items,
    slots: {
      register: (registration: { id: string }) => {
        slotIds.push(registration.id);
        return () => {
          const index = slotIds.indexOf(registration.id);
          if (index >= 0) slotIds.splice(index, 1);
        };
      },
    },
    widgets: {
      register: (pluginId: string, definition: WidgetDefinition) => {
        const row = { pluginId, id: definition.id, ownerPackageId: definition.ownerPackageId };
        widgetsList.push(row);
        return () => {
          const index = widgetsList.indexOf(row);
          if (index >= 0) widgetsList.splice(index, 1);
        };
      },
      registerPlugin: (plugin: WidgetPlugin) => {
        const row = { id: plugin.id, ownerPackageId: plugin.ownerPackageId };
        plugins.push(row);
        return () => {
          const index = plugins.indexOf(row);
          if (index >= 0) plugins.splice(index, 1);
        };
      },
    },
    surfaces: {
      register: (definition: { id: string }) => {
        surfaceIds.push(definition.id);
        return () => {
          const index = surfaceIds.indexOf(definition.id);
          if (index >= 0) surfaceIds.splice(index, 1);
        };
      },
    },
    capabilities: {
      register: (definition: { id: string }) => {
        capabilityIds.push(definition.id);
        return () => {
          const index = capabilityIds.indexOf(definition.id);
          if (index >= 0) capabilityIds.splice(index, 1);
        };
      },
    },
    settings: {
      registerPage: (definition: SettingsPageDefinition) => {
        const row = { id: definition.id, packageId: definition.packageId };
        pages.push(row);
        return () => {
          const index = pages.indexOf(row);
          if (index >= 0) pages.splice(index, 1);
        };
      },
      registerItems: (list: Array<{ id: string }>) => {
        for (const item of list) items.push(item.id);
        return () => {
          for (const item of list) {
            const index = items.indexOf(item.id);
            if (index >= 0) items.splice(index, 1);
          }
        };
      },
    },
    projectContext: { register: () => () => {} },
    reducers: { register: () => () => {} },
    store: {
      getSnapshot: () => ({
        activeProjectId: null,
        activeSessionId: null,
        activeView: "session",
        overlay: null,
        railPlugin: null,
        workbenchProfile: "conversation",
        settings: {},
      }),
      subscribe: () => () => {},
      select: <T>(selector: (snapshot: never) => T) => selector({} as never),
    },
    navigation: {
      setActiveView: () => {},
      openSettingsPage: () => {},
      openWorkspacePane: () => false,
      closeWorkspacePane: () => {},
      openRailSurface: () => {},
      setOverlay: () => {},
      openResource: () => {},
      revealResource: () => {},
    },
    workbench: {
      profiles: { register: () => () => {}, list: () => [] },
      activateProfile: () => false,
      getActiveProfile: () => ({
        id: "conversation",
        label: "Conversation",
        description: "",
        order: 0,
        available: true,
        presentation: {},
      }),
      getSnapshot: () => ({
        activeProfile: "conversation",
        profiles: [],
        regions: {
          start: { surfaces: [], active: null, collapsed: false },
          primary: { surfaces: [], active: null, collapsed: false },
          end: { surfaces: [], active: null, collapsed: false },
          bottom: { surfaces: [], active: null, collapsed: false },
        },
        floating: [],
        fullscreen: null,
      }),
      subscribe: () => () => {},
      openSurface: () => false,
      closeSurface: () => {},
      moveSurface: () => false,
      swapSurfaces: () => false,
      setPresentation: () => false,
      resetProfileLayout: () => {},
    },
    resources: {
      registerProvider: () => () => {},
      getProvider: () => undefined,
      describe: () => null,
      key: () => "",
      notifyMoved: () => {},
      notifyRemoved: () => {},
      documents: {
        open: () => { throw new Error("documents.open unused in webEntries tests"); },
        isDirty: () => false,
        subscribe: () => () => {},
      },
    },
    ui: { icons: {}, Dialog: () => null },
    errors: { friendly: () => "" },
  };
  return host as unknown as RecordingHost;
};

const activate = (
  asset: WebPackageAsset,
  over: Partial<Parameters<typeof activateWebPackage>[1]> & {
    current?: { value: boolean };
  } = {},
) => {
  const host = createHost();
  const current = over.current ?? { value: true };
  return activateWebPackage(asset, {
    createActivation: (ownerPackageId) => createPackageActivation(ownerPackageId, host),
    isCurrent: () => current.value,
    ...over,
  }).then((handle) => ({ handle, host, current }));
};

test("catalog loading does not import modules or attach styles", async () => {
  const dom = new Window({ url: "http://localhost/" });
  let imported = 0;
  const catalog = await loadWebPackageCatalog({
    fetch: (async () => new Response(JSON.stringify({
      packages: [{
        id: "sample",
        module: "/packages/sample/entry.js",
        styles: ["/packages/sample/entry.css"],
      }],
    }))) as typeof fetch,
    importModule: async () => {
      imported++;
      return { default: () => () => () => {} };
    },
    document: dom.document as unknown as Document,
  });
  assert.deepEqual(catalog.map((item) => item.id), ["sample"]);
  assert.equal(imported, 0);
  assert.equal(dom.document.querySelectorAll("link[data-polyth-web-package-style]").length, 0);
});

test("catalog loading rejects executable URLs outside the generated package root", async () => {
  await assert.rejects(
    () => loadWebPackageCatalog({
      fetch: (async () => new Response(JSON.stringify({
        packages: [{ id: "bad", module: "https://evil.test/plugin.js", styles: [] }],
      }))) as typeof fetch,
    }),
    /manifest is invalid/,
  );
});

test("enabled activation imports once, runs factory and installer, and binds owner not semantic ids", async () => {
  const imported: string[] = [];
  let factories = 0;
  let installers = 0;
  const { handle, host } = await activate(sampleAsset(), {
    importModule: async (url) => {
      imported.push(url);
      return {
        default: (received: WebPackageHost) => {
          factories++;
          received.widgets.register("voice", {
            id: "voice.mic",
            title: "Mic",
            description: "Mic",
            render: () => null,
          });
          received.widgets.registerPlugin({
            id: "voice",
            name: "Voice",
            widgets: [],
          });
          received.settings.registerPage({
            id: "voice",
            packageId: "spoofed",
            label: "Voice",
            group: "Workspace",
            component: () => null,
          });
          received.capabilities.register({
            id: "voice",
            label: "Voice",
            plainDescription: "Talk",
            keywords: ["voice"],
            standardTier: "more",
            standardRank: 1,
            open: () => {},
            available: () => true,
          });
          return () => {
            installers++;
            return () => {};
          };
        },
      };
    },
  });
  assert.deepEqual(imported, ["/packages/sample/entry.js"]);
  assert.equal(factories, 1);
  assert.equal(installers, 1);
  assert.deepEqual(host.widgetsList, [{ pluginId: "voice", id: "voice.mic", ownerPackageId: "sample" }]);
  assert.deepEqual(host.plugins, [{ id: "voice", ownerPackageId: "sample" }]);
  assert.deepEqual(host.pages, [{ id: "voice", packageId: "sample" }]);
  assert.deepEqual(host.capabilityIds, ["voice"]);
  handle.dispose();
  assert.equal(host.widgetsList.length, 0);
  assert.equal(host.pages.length, 0);
  assert.equal(host.capabilityIds.length, 0);
});

test("activation attaches CSS before the factory publishes contributions", async () => {
  const dom = new Window({ url: "http://localhost/" });
  const order: string[] = [];
  await activate(sampleAsset({ styles: ["/packages/sample/entry.css"] }), {
    document: dom.document as unknown as Document,
    importModule: async () => ({
      default: (host: WebPackageHost) => {
        order.push("factory");
        assert.equal(
          (dom.document.querySelector("link[data-polyth-web-package-style]") as HTMLLinkElement | null)?.href,
          "http://localhost/packages/sample/entry.css",
        );
        host.widgets.register("sample", {
          id: "sample.panel",
          title: "Panel",
          description: "Panel",
          render: () => null,
        });
        order.push("widget");
        return () => () => {};
      },
    }),
  });
  assert.deepEqual(order, ["factory", "widget"]);
});

test("disable after CSS attach removes exactly that activation's styles", async () => {
  const dom = new Window({ url: "http://localhost/" });
  const first = attachPackageStyles(
    sampleAsset({ styles: ["/packages/sample/entry.css"] }),
    dom.document as unknown as Document,
  );
  const second = attachPackageStyles(
    { id: "other", module: "/packages/other/entry.js", styles: ["/packages/other/entry.css"] },
    dom.document as unknown as Document,
  );
  assert.equal(dom.document.querySelectorAll("link[data-polyth-web-package-style]").length, 2);
  first();
  const leftover = [...dom.document.querySelectorAll("link[data-polyth-web-package-style]")] as unknown as HTMLLinkElement[];
  assert.equal(leftover.length, 1);
  assert.match(leftover[0]!.href, /\/packages\/other\/entry\.css/);
  second();
  assert.equal(dom.document.querySelectorAll("link[data-polyth-web-package-style]").length, 0);
});

test("failed activation cleans styles and does not leave contributions", async () => {
  const dom = new Window({ url: "http://localhost/" });
  const host = createHost();
  await assert.rejects(() => activateWebPackage(
    sampleAsset({ styles: ["/packages/sample/entry.css"] }),
    {
      document: dom.document as unknown as Document,
      createActivation: (ownerPackageId) => createPackageActivation(ownerPackageId, host),
      isCurrent: () => true,
      importModule: async () => {
        throw new Error("boom");
      },
    },
  ), /boom/);
  assert.equal(dom.document.querySelectorAll("link[data-polyth-web-package-style]").length, 0);
  assert.equal(host.widgetsList.length, 0);
});

test("cancelled import never runs factory or installer", async () => {
  let resolveImport!: (value: unknown) => void;
  const pending = new Promise<unknown>((resolve) => { resolveImport = resolve; });
  let factories = 0;
  let installers = 0;
  const current = { value: true };
  const loading = activate(sampleAsset(), {
    current,
    importModule: () => pending,
  });
  current.value = false;
  resolveImport({
    default: () => {
      factories++;
      return () => {
        installers++;
        return () => {};
      };
    },
  });
  const { host } = await loading;
  assert.equal(factories, 0);
  assert.equal(installers, 0);
  assert.equal(host.widgetsList.length, 0);
});

test("factory throw after a registration leaves no contributions or styles", async () => {
  const dom = new Window({ url: "http://localhost/" });
  const host = createHost();
  await assert.rejects(() => activateWebPackage(
    sampleAsset({ styles: ["/packages/sample/entry.css"] }),
    {
      document: dom.document as unknown as Document,
      createActivation: (ownerPackageId) => createPackageActivation(ownerPackageId, host),
      isCurrent: () => true,
      importModule: async () => ({
        default: (received: WebPackageHost) => {
          received.widgets.register("sample", {
            id: "sample.leak",
            title: "Leak",
            description: "Leak",
            render: () => null,
          });
          throw new Error("factory failed");
        },
      }),
    },
  ), /factory failed/);
  assert.equal(host.widgetsList.length, 0);
  assert.equal(dom.document.querySelectorAll("link[data-polyth-web-package-style]").length, 0);
});
