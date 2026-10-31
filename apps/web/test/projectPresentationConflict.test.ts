import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { ProjectPresentationSettingsDto } from "@polyth/contracts";

test("stale project layout save merges a local widget edit with remote capability order", async () => {
  const dom = new Window({ url: "http://127.0.0.1:4400/" });
  const values = new Map<string, string>();
  Object.assign(globalThis, {
    window: dom as unknown as Window & typeof globalThis,
    CustomEvent: dom.CustomEvent,
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  });
  const { api } = await import("@polyth/session/web-api");
  const sync = await import("../src/projectPresentationSync.ts");
  const originalGet = api.projectPresentationSettings;
  const originalSave = api.projectPresentationSettingsSave;
  let server: ProjectPresentationSettingsDto = {
    revision: 1,
    updatedAt: 1,
    settings: {
      widgetLayout: { source: "server" },
      capabilityLayout: { source: "old" },
      workbenchLayout: { activeProfile: "remote", profiles: {} },
    },
  };
  const expectedRevisions: Array<number | undefined> = [];
  let blockNextSave = false;
  let releaseSave: (() => void) | undefined;
  api.projectPresentationSettings = async (projectId) => projectId === "p1"
    ? structuredClone(server)
    : { revision: 0, updatedAt: 0, settings: {} };
  api.projectPresentationSettingsSave = async (_projectId, settings, opts) => {
    expectedRevisions.push(opts?.expectedRevision);
    if (blockNextSave) {
      blockNextSave = false;
      await new Promise<void>((resolve) => { releaseSave = resolve; });
    }
    if (opts?.expectedRevision !== server.revision) {
      throw Object.assign(new Error("stale layout"), { code: "conflict" });
    }
    server = { revision: server.revision + 1, updatedAt: Date.now(), settings };
    return structuredClone(server);
  };
  try {
    sync.initProjectPresentationSync(() => () => undefined, () => "p1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(JSON.parse(values.get("polyth.widgetLayout.p1")!), { source: "server" });
    values.set("polyth.widgetLayout.p1", JSON.stringify({ source: "local-edit" }));
    sync.markProjectPresentationChanged("p1", "widgetLayout");
    server = {
      revision: 2,
      updatedAt: 2,
      settings: {
        widgetLayout: { source: "server" },
        capabilityLayout: { source: "remote-edit" },
      },
    };
    sync.flushProjectPresentationSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(JSON.parse(values.get("polyth.widgetLayout.p1")!), { source: "local-edit" });
    assert.deepEqual(JSON.parse(values.get("polyth.capabilityLayout.v1.p1")!), { source: "remote-edit" });
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.deepEqual(expectedRevisions, [1, 2]);
    assert.deepEqual(server.settings.widgetLayout, { source: "local-edit" });
    assert.deepEqual(server.settings.capabilityLayout, { source: "remote-edit" });
    assert.equal(server.settings.workbenchLayout, undefined);

    // Switching projects while a save is in flight must flush the newer edit
    // once the first write completes, without a concurrent stale PUT.
    values.set("polyth.widgetLayout.p1", JSON.stringify({ source: "first-edit" }));
    sync.markProjectPresentationChanged("p1", "widgetLayout");
    blockNextSave = true;
    sync.flushProjectPresentationSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(releaseSave);
    values.set("polyth.widgetLayout.p1", JSON.stringify({ source: "last-edit" }));
    sync.markProjectPresentationChanged("p1", "widgetLayout");
    sync.initProjectPresentationSync(() => () => undefined, () => "p2");
    releaseSave!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(server.settings.widgetLayout, { source: "last-edit" });
    assert.deepEqual(expectedRevisions, [1, 2, 3, 4]);
  } finally {
    api.projectPresentationSettings = originalGet;
    api.projectPresentationSettingsSave = originalSave;
  }
});

test("a server record that restarts its revision converges instead of conflicting forever", async () => {
  const dom = new Window({ url: "http://127.0.0.1:4400/" });
  const values = new Map<string, string>();
  Object.assign(globalThis, {
    window: dom as unknown as Window & typeof globalThis,
    CustomEvent: dom.CustomEvent,
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  });
  const { api } = await import("@polyth/session/web-api");
  const sync = await import("../src/projectPresentationSync.ts");
  const originalGet = api.projectPresentationSettings;
  const originalSave = api.projectPresentationSettingsSave;
  const projectId = "reset1";
  const expectedRevisions: Array<number | undefined> = [];
  let server: ProjectPresentationSettingsDto = {
    revision: 3,
    updatedAt: 3,
    settings: { widgetLayout: { source: "server" } },
  };
  api.projectPresentationSettings = async () => structuredClone(server);
  api.projectPresentationSettingsSave = async (_projectId, settings, opts) => {
    expectedRevisions.push(opts?.expectedRevision);
    if (opts?.expectedRevision !== server.revision) {
      throw Object.assign(new Error("stale layout"), { code: "conflict" });
    }
    server = { revision: server.revision + 1, updatedAt: Date.now(), settings };
    return structuredClone(server);
  };
  try {
    sync.initProjectPresentationSync(() => () => undefined, () => projectId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The server record is reset/restored while this browser keeps its revision.
    server = { revision: 0, updatedAt: 0, settings: {} };
    values.set(`polyth.widgetLayout.${projectId}`, JSON.stringify({ source: "local-edit" }));
    sync.markProjectPresentationChanged(projectId, "widgetLayout");
    sync.flushProjectPresentationSync();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.deepEqual(expectedRevisions, [3, 0]);
    assert.equal(server.revision, 1);
    assert.deepEqual(server.settings.widgetLayout, { source: "local-edit" });
  } finally {
    api.projectPresentationSettings = originalGet;
    api.projectPresentationSettingsSave = originalSave;
  }
});
