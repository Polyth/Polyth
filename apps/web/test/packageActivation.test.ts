import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./tsxHooks.mjs", import.meta.url);

const { createPackageActivation } = await import("../src/packages/activation.ts");
const { registerWidget, listWidgets } = await import("../src/widgets/catalog.ts");
const { listSlots, registerSlot } = await import("../src/slots.ts");
const { listSurfaces, registerSurface } = await import("../src/surfaces.ts");
const { getCapability, registerCapability } = await import("../src/capabilities.ts");
const { listSettingsItems, registerSettingsItems } = await import("../src/settings/registry.ts");
const { webPackageHost } = await import("../src/packages/webHost.ts");

test("activation scope disposes host contributions even if the package forgets an unregister", () => {
  const activation = createPackageActivation("alpha", webPackageHost);
  activation.host.widgets.register("alpha", {
    id: "alpha.forgotten",
    title: "Forgotten",
    description: "Should still be disposed",
    render: () => null,
  });
  activation.host.slots.register({
    slot: "app.nav",
    id: "alpha.forgotten-slot",
    render: () => null,
  });
  activation.host.surfaces.register({
    id: "alpha.surface",
    title: "Alpha",
    order: 90,
    component: () => null,
    presentation: {
      kind: "workspace",
      defaultRatio: 0.4,
      minWidth: 320,
      preferredMaxWidth: 720,
      keepAlive: false,
      escape: "close",
    },
  });
  activation.host.capabilities.register({
    id: "alpha.cap",
    label: "Alpha",
    plainDescription: "Alpha",
    keywords: ["alpha"],
    standardTier: "more",
    standardRank: 40,
    open: () => {},
    available: () => true,
  });
  assert.equal(listWidgets().some((widget) => widget.id === "alpha.forgotten"), true);
  assert.equal(listSlots("app.nav").some((item) => item.id === "alpha.forgotten-slot"), true);
  assert.equal(listSurfaces().some((surface) => surface.id === "alpha.surface"), true);
  assert.equal(getCapability("alpha.cap")?.id, "alpha.cap");
  activation.dispose();
  assert.equal(listWidgets().some((widget) => widget.id === "alpha.forgotten"), false);
  assert.equal(listSlots("app.nav").some((item) => item.id === "alpha.forgotten-slot"), false);
  assert.equal(listSurfaces().some((surface) => surface.id === "alpha.surface"), false);
  assert.equal(getCapability("alpha.cap"), null);
});

test("activation exposes the host-owned Canvas insertion seam without layout access", () => {
  const calls: Array<{ id: string; config: unknown }> = [];
  const fakeHost = {
    ...webPackageHost,
    widgets: {
      ...webPackageHost.widgets,
      addToCanvas: (id: string, options?: { config?: unknown }) => {
        calls.push({ id, config: options?.config });
        return { instanceId: `${id}#2`, duplicated: true };
      },
    },
  };
  const activation = createPackageActivation("usage", fakeHost);
  const result = activation.host.widgets.addToCanvas?.("usage.throughput", {
    config: { range: "24h", groupBy: "provider" },
  });
  assert.deepEqual(result, { instanceId: "usage.throughput#2", duplicated: true });
  assert.deepEqual(calls, [{
    id: "usage.throughput",
    config: { range: "24h", groupBy: "provider" },
  }]);
  activation.dispose();
  assert.equal(activation.host.widgets.addToCanvas?.("usage.throughput"), null);
});

test("disposed scoped host cannot resurrect a widget", () => {
  const activation = createPackageActivation("beta", webPackageHost);
  activation.dispose();
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    activation.host.widgets.register("beta", {
      id: "beta.resurrected",
      title: "No",
      description: "No",
      render: () => null,
    });
  } finally {
    console.warn = original;
  }
  assert.equal(listWidgets().some((widget) => widget.id === "beta.resurrected"), false);
  assert.equal(warnings.length > 0, true);
});

test("widget plugin id stays semantic while owner is host-bound", () => {
  const activation = createPackageActivation("dictation", webPackageHost);
  try {
    activation.host.widgets.registerPlugin({
      id: "voice",
      name: "Voice",
      widgets: [{
        id: "voice.activation-mic",
        title: "Mic",
        description: "Mic",
        kind: "mini-widget",
        defaultSlot: "composer.leading",
        supportedSlots: ["composer.leading"],
        render: () => null,
      }],
    });
    activation.host.settings.registerPage({
      id: "voice",
      packageId: "ignored",
      label: "Voice",
      group: "Workspace",
      component: () => null,
    });
    const widget = listWidgets().find((item) => item.id === "voice.activation-mic");
    assert.equal(widget?.pluginId, "voice");
    assert.equal(widget?.ownerPackageId, "dictation");
    const page = listSlots("settings.pages").find((item) => item.id === "voice");
    assert.equal(page?.meta?.packageId, "dictation");
    assert.equal(page?.ownerPackageId, "dictation");
  } finally {
    activation.dispose();
  }
});

test("cross-owner widget collisions throw for direct and plugin registration", () => {
  const core = registerWidget({
    id: "core.collision-chat",
    pluginId: "session",
    title: "Chat",
    description: "Core",
    render: () => null,
  });
  const alpha = createPackageActivation("pkg-a", webPackageHost);
  try {
    assert.throws(
      () => alpha.host.widgets.register("pkg-a", {
        id: "core.collision-chat",
        title: "Stolen",
        description: "Stolen",
        render: () => null,
      }),
      /owned by "host"/,
    );
    const owned = alpha.host.widgets.register("marketing", {
      id: "marketing.board",
      title: "Board",
      description: "Board",
      render: () => null,
    });
    const beta = createPackageActivation("pkg-b", webPackageHost);
    try {
      assert.throws(
        () => beta.host.widgets.registerPlugin({
          id: "other-group",
          name: "Other",
          widgets: [{
            id: "marketing.board",
            title: "Other board",
            description: "Other",
            defaultSlot: "workspace.main",
            supportedSlots: ["workspace.main"],
            render: () => null,
          }],
        }),
        /owned by "pkg-a"/,
      );
    } finally {
      beta.dispose();
    }
    owned();
  } finally {
    alpha.dispose();
    core();
  }
});

test("same-owner widget replacement is identity-safe", () => {
  const first = registerWidget({
    id: "pkg.same",
    pluginId: "pkg",
    ownerPackageId: "pkg",
    title: "First",
    description: "First",
    render: () => null,
  });
  const second = registerWidget({
    id: "pkg.same",
    pluginId: "pkg",
    ownerPackageId: "pkg",
    title: "Second",
    description: "Second",
    render: () => null,
  });
  assert.equal(listWidgets().find((widget) => widget.id === "pkg.same")?.title, "Second");
  first();
  assert.equal(listWidgets().find((widget) => widget.id === "pkg.same")?.title, "Second");
  second();
  assert.equal(listWidgets().some((widget) => widget.id === "pkg.same"), false);
});

test("settings search items reject cross-owner collisions and ignore stale unregister", () => {
  const before = listSettingsItems().length;
  const core = registerSettingsItems([
    { id: "collision.core", pageId: "general", label: "Core", focusTarget: "x" },
  ]);
  assert.throws(
    () => registerSettingsItems([
      { id: "collision.core", pageId: "general", label: "Pkg", focusTarget: "x", ownerPackageId: "pkg-a" },
    ]),
    /owned by "host"/,
  );
  const first = registerSettingsItems([
    { id: "collision.pkg", pageId: "chat", label: "First", focusTarget: "y", ownerPackageId: "pkg-a" },
  ]);
  const second = registerSettingsItems([
    { id: "collision.pkg", pageId: "chat", label: "Second", focusTarget: "y", ownerPackageId: "pkg-a" },
  ]);
  assert.equal(listSettingsItems().find((item) => item.id === "collision.pkg")?.label, "Second");
  first();
  assert.equal(listSettingsItems().find((item) => item.id === "collision.pkg")?.label, "Second");
  second();
  core();
  assert.equal(listSettingsItems().length, before);
});

test("surface and capability cross-owner collisions throw; same-owner replace is identity-safe", () => {
  const surfaceA = registerSurface({
    id: "collision.surface",
    ownerPackageId: "pkg-a",
    title: "A",
    order: 1,
    component: () => null,
  });
  assert.throws(
    () => registerSurface({
      id: "collision.surface",
      ownerPackageId: "pkg-b",
      title: "B",
      order: 2,
      component: () => null,
    }),
    /owned by "pkg-a"/,
  );
  const surfaceA2 = registerSurface({
    id: "collision.surface",
    ownerPackageId: "pkg-a",
    title: "A2",
    order: 3,
    component: () => null,
  });
  surfaceA();
  assert.equal(listSurfaces().find((surface) => surface.id === "collision.surface")?.title, "A2");
  surfaceA2();

  const capA = registerCapability({
    id: "collision.cap",
    ownerPackageId: "pkg-a",
    label: "A",
    plainDescription: "A",
    keywords: ["a"],
    standardTier: "more",
    standardRank: 1,
    open: () => {},
    available: () => true,
  });
  assert.throws(
    () => registerCapability({
      id: "collision.cap",
      ownerPackageId: "pkg-b",
      label: "B",
      plainDescription: "B",
      keywords: ["b"],
      standardTier: "more",
      standardRank: 1,
      open: () => {},
      available: () => true,
    }),
    /owned by "pkg-a"/,
  );
  capA();
});

test("slot contributions with different ids coexist; duplicate ids are owner-checked", () => {
  const a = registerSlot("app.nav", "alpha.one", () => null, 0, undefined, "alpha");
  const b = registerSlot("app.nav", "beta.one", () => null, 0, undefined, "beta");
  try {
    assert.deepEqual(
      listSlots("app.nav").filter((item) => item.id.endsWith(".one")).map((item) => item.id).sort(),
      ["alpha.one", "beta.one"],
    );
    assert.throws(
      () => registerSlot("app.nav", "alpha.one", () => null, 0, undefined, "beta"),
      /owned by "alpha"/,
    );
  } finally {
    a();
    b();
  }
});

