import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { ProjectPresentationSettingsDto } from "@polyth/contracts";

test("project presentation state hydrates from the server and saves later edits", async () => {
  const dom = new Window({ url: "http://127.0.0.1:4400/" });
  const values = new Map<string, string>();
  Object.assign(globalThis, {
    window: dom as unknown as Window & typeof globalThis,
    CustomEvent: dom.CustomEvent,
    localStorage: {
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
      removeItem(key: string) { values.delete(key); },
    },
  });
  values.set("polyth.widgetLayout.p1", JSON.stringify({ version: 1, source: "local" }));

  const [{ api }, sync] = await Promise.all([
    import("@polyth/session/web-api"),
    import("../src/projectPresentationSync.ts"),
  ]);
  const originalGet = api.projectPresentationSettings;
  const originalPut = api.projectPresentationSettingsSave;
  const saved: Array<{ projectId: string; settings: Record<string, unknown> }> = [];
  let activeProjectId: string | null = "p1";
  const listeners = new Set<() => void>();
  let releaseP3: ((value: ProjectPresentationSettingsDto) => void) | undefined;
  let releaseP5: ((value: ProjectPresentationSettingsDto) => void) | undefined;
  api.projectPresentationSettings = async (projectId) => {
    if (projectId === "p3") {
      return new Promise<ProjectPresentationSettingsDto>((resolve) => { releaseP3 = resolve; });
    }
    if (projectId === "p5") {
      return new Promise<ProjectPresentationSettingsDto>((resolve) => { releaseP5 = resolve; });
    }
    return {
      revision: projectId === "p1" ? 4 : 7,
      updatedAt: 10,
      settings: projectId === "p1"
        ? {
            widgetLayout: { version: 1, source: "server" },
            workspacePanel: { version: 1, items: [] },
            workspacePane: { version: 2, openSurface: null },
            workbenchLayout: { version: 1, activeProfile: "conversation", profiles: {} },
            capabilityLayout: { version: 1, placements: {} },
            workspaceMode: "edit",
          }
        : { workspaceMode: "widgets" },
    };
  };
  api.projectPresentationSettingsSave = async (projectId, settings) => {
    saved.push({ projectId, settings });
    return { revision: saved.length + 7, updatedAt: 11, settings: {} };
  };
  try {
    sync.initProjectPresentationSync(
      (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      () => activeProjectId,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(JSON.parse(values.get("polyth.widgetLayout.p1")!), { version: 1, source: "server" });
    assert.deepEqual(JSON.parse(values.get("polyth.workspacePanel.v1.p1")!), { version: 1, items: [] });
    assert.deepEqual(JSON.parse(values.get("polyth.workspacePane.v2.p1")!), { version: 2, openSurface: null });
    assert.deepEqual(JSON.parse(values.get("polyth.workbenchLayout.v1.p1")!), { version: 1, activeProfile: "conversation", profiles: {} });
    assert.deepEqual(JSON.parse(values.get("polyth.capabilityLayout.v1.p1")!), { version: 1, placements: {} });
    assert.equal(values.get("polyth.workspaceMode.v1.p1"), "edit");

    values.set("polyth.workspaceMode.v1.p1", "chat");
    sync.markProjectPresentationChanged("p1", "workspaceMode");
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(saved.at(-1)?.projectId, "p1");
    assert.equal(saved.at(-1)?.settings.workspaceMode, "chat");
    assert.deepEqual(Object.keys(saved.at(-1)!.settings), [
      "widgetLayout", "workspacePanel", "workspacePane", "workbenchLayout", "capabilityLayout", "workspaceMode",
    ]);

    activeProjectId = "p2";
    for (const listener of listeners) listener();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(values.get("polyth.workspaceMode.v1.p2"), "widgets");
    assert.equal(values.get("polyth.workspaceMode.v1.p1"), "chat");

    // A project-local edit made after hydration starts must beat the late
    // server snapshot. New-project capability seeding exercises this path.
    activeProjectId = "p5";
    for (const listener of listeners) listener();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const seededCapabilityLayout = {
      version: 1,
      placements: { usage: { tier: "technical", rank: 15 } },
    };
    values.set("polyth.capabilityLayout.v1.p5", JSON.stringify(seededCapabilityLayout));
    sync.markProjectPresentationChanged("p5", "capabilityLayout");
    releaseP5!({ revision: 0, updatedAt: 12, settings: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      JSON.parse(values.get("polyth.capabilityLayout.v1.p5")!),
      seededCapabilityLayout,
    );

    // A late response from a project that is no longer active must not
    // overwrite the newly selected project's local records.
    activeProjectId = "p3";
    for (const listener of listeners) listener();
    await new Promise((resolve) => setTimeout(resolve, 0));
    activeProjectId = "p4";
    for (const listener of listeners) listener();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(values.get("polyth.workspaceMode.v1.p4"), "widgets");
    releaseP3!({ revision: 8, updatedAt: 12, settings: { workspaceMode: "edit" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(values.get("polyth.workspaceMode.v1.p4"), "widgets");
  } finally {
    api.projectPresentationSettings = originalGet;
    api.projectPresentationSettingsSave = originalPut;
  }
});
