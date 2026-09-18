import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { tr } from "../src/i18n/index.ts";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
  Element: (dom as unknown as { Element: typeof Element }).Element,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
  activateProject,
  activateSession,
  beginProjectListRequest,
  failProjectList,
  publishProjectList,
  upsertSession,
} = await import("../src/store.ts");
const { default: SurfaceMountLayer, resetVisitedSurfacesForTest } = await import(
  "../src/components/workbench/SurfaceMountLayer.tsx"
);
const { resetSurfaceMountsForTest, surfaceMountNode, adoptSurfaceNode } = await import(
  "../src/components/workbench/surfaceMounts.ts"
);

test("keep-alive workbench surfaces use the host project empty state, not feature copy", async () => {
  resetVisitedSurfacesForTest();
  resetSurfaceMountsForTest();
  activateProject(null);

  const surfaces = new Map([{
    id: "browser",
    title: "Browser",
    capabilityId: "browser",
    keepAlive: true,
    contextual: false,
    component: () => createElement("div", { className: "browser-body" }, "browser body"),
  }].map((surface) => [surface.id, surface]));

  const host = document.createElement("div");
  host.setAttribute("data-surface-slot", "browser");
  document.body.appendChild(host);
  adoptSurfaceNode("browser", host);

  const rootHost = document.createElement("div");
  document.body.appendChild(rootHost);
  const root = createRoot(rootHost);
  await act(async () => {
    root.render(createElement(SurfaceMountLayer, {
      placed: ["browser"],
      visible: new Set(["browser"]),
      surfaces,
    }));
  });

  try {
    assert.match(surfaceMountNode("browser").textContent ?? "", new RegExp(tr("workspace.workspacehost.loadingProjects")));
    assert.equal(surfaceMountNode("browser").querySelector(".browser-body"), null);

    await act(async () => {
      const ticket = beginProjectListRequest();
      failProjectList(ticket, "offline");
    });
    assert.match(surfaceMountNode("browser").textContent ?? "", new RegExp(tr("workspace.workspacehost.couldNotLoadProjects")));
    assert.match(surfaceMountNode("browser").textContent ?? "", /offline/);

    await act(async () => {
      const ticket = beginProjectListRequest();
      assert.equal(publishProjectList(ticket, [{
        id: "p1",
        path: "/work/p1",
        name: "One",
        createdAt: 1,
      }]), "published");
    });
    assert.match(surfaceMountNode("browser").textContent ?? "", new RegExp(tr("workspace.workspacehost.bringWorkIntoFocus")));

    await act(async () => { activateProject("p1"); });
    assert.match(surfaceMountNode("browser").textContent ?? "", /browser body/);
  } finally {
    await act(async () => {
      root.unmount();
      activateProject(null);
    });
    host.remove();
    rootHost.remove();
    resetVisitedSurfacesForTest();
    resetSurfaceMountsForTest();
  }
});

test("keep-alive surfaces follow the open session project when client project id is missing", async () => {
  resetVisitedSurfacesForTest();
  resetSurfaceMountsForTest();

  const surfaces = new Map([{
    id: "git",
    title: "Git",
    capabilityId: "git",
    keepAlive: true,
    contextual: false,
    component: () => createElement("div", { className: "git-body" }, "git body"),
  }].map((surface) => [surface.id, surface]));

  const host = document.createElement("div");
  host.setAttribute("data-surface-slot", "git");
  document.body.appendChild(host);
  adoptSurfaceNode("git", host);

  const rootHost = document.createElement("div");
  document.body.appendChild(rootHost);
  const root = createRoot(rootHost);
  await act(async () => {
    const ticket = beginProjectListRequest();
    assert.equal(publishProjectList(ticket, [{
      id: "p-chat",
      path: "/work/p-chat",
      name: "Chat project",
      createdAt: 1,
    }]), "published");
    upsertSession({
      id: "s-chat",
      projectId: "p-chat",
      title: "Open chat",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    });
    activateProject(null);
    activateSession("s-chat");
    root.render(createElement(SurfaceMountLayer, {
      placed: ["git"],
      visible: new Set(["git"]),
      surfaces,
    }));
  });

  try {
    assert.match(surfaceMountNode("git").textContent ?? "", /git body/);
    assert.equal(surfaceMountNode("git").querySelector(".hero"), null);
  } finally {
    await act(async () => {
      root.unmount();
      activateSession(null);
      activateProject(null);
    });
    host.remove();
    rootHost.remove();
    resetVisitedSurfacesForTest();
    resetSurfaceMountsForTest();
  }
});
