// Turning off a package that owns a chat lane must offer to clean up or hide
// its chats, and must do nothing when the package owns none. The page is
// driven through a real mount; the package's lane is registered the way an
// activation scope registers it (with the host-stamped `ownerPackageId`), so
// the test proves the generic path rather than a Creative Studio special case.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

const PACKAGES = [
  { id: "creative-studio", name: "Creative Studio", description: "Music videos", core: false, enabled: true, category: "workspace", hasSettings: false },
  { id: "second-studio", name: "Second Studio", description: "Another lane", core: false, enabled: true, category: "workspace", hasSettings: false },
  { id: "git", name: "Git", description: "Source control", core: false, enabled: true, category: "engineering", hasSettings: false },
];

const OWNED = [
  { id: "video-1", projectId: "p1", title: "Clip one", purpose: "creative-studio", status: "idle", createdAt: 1, updatedAt: 5 },
  { id: "video-child", projectId: "p1", parentId: "video-1", title: "Scene builder", status: "idle", createdAt: 1, updatedAt: 4 },
  { id: "second-1", projectId: "p1", title: "Second clip", purpose: "second-studio", status: "idle", createdAt: 1, updatedAt: 3 },
  { id: "ordinary", projectId: "p1", title: "Ordinary chat", status: "idle", createdAt: 1, updatedAt: 2 },
];

async function mountPage(options: { owned?: boolean; secondOwner?: boolean } = {}) {
  const owned = options.owned !== false;
  const secondOwner = options.secondOwner === true;
  const dom = new Window({ url: "http://localhost/" });
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  });
  const { registerWorkbenchProfile } = await import("../src/workbench/profiles.ts");
  const offProfile = registerWorkbenchProfile({
    id: "creative-studio",
    label: "Creative Studio",
    description: "",
    order: 10,
    defaultLayout: { surfaces: [{ surface: "session", region: "primary", active: true }] },
    presentation: { navigation: "primary" },
    sessionPurpose: "creative-studio",
    ownerPackageId: "creative-studio",
  });
  const offSecondProfile = secondOwner
    ? registerWorkbenchProfile({
      id: "second-studio",
      label: "Second Studio",
      description: "",
      order: 11,
      defaultLayout: { surfaces: [{ surface: "session", region: "primary", active: true }] },
      presentation: { navigation: "primary" },
      sessionPurpose: "second-studio",
      ownerPackageId: "second-studio",
    })
    : () => {};

  const state = PACKAGES.map((item) => ({ ...item }));
  const patches: Array<{ id: string; enabled: boolean }> = [];
  const archived: string[][] = [];
  const deleted: string[] = [];
  const sessions = !owned
    ? [{ ...OWNED[3]! }]
    : secondOwner
      ? OWNED
      : OWNED.slice(0, 2).concat([{ ...OWNED[3]! }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/packages-manifest.json")) return new Response(JSON.stringify({ packages: [] }));
    if (url.endsWith("/api/packages/residue")) return new Response(JSON.stringify({ residue: [] }));
    if (url.includes("/api/sessions/summaries")) {
      const archived = new URL(url, "http://localhost/").searchParams.get("archived") === "true";
      const rows = sessions.filter((session) => (session.status === "archived") === archived);
      return new Response(JSON.stringify({ sessions: rows, complete: true, revision: 1 }));
    }
    if (url.endsWith("/api/sessions/bulk") && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { op: string; ids: string[] };
      archived.push(body.ids);
      return new Response(JSON.stringify({ succeeded: body.ids, failed: [] }));
    }
    const remove = url.match(/\/api\/sessions\/([^/?]+)$/);
    if (remove && method === "DELETE") {
      deleted.push(decodeURIComponent(remove[1]!));
      return new Response(JSON.stringify({ ok: true }));
    }
    const patch = url.match(/\/api\/packages\/([^/?]+)$/);
    if (patch && method === "PATCH") {
      const id = decodeURIComponent(patch[1]!);
      const enabled = (JSON.parse(String(init?.body)) as { enabled: boolean }).enabled;
      patches.push({ id, enabled });
      state.find((entry) => entry.id === id)!.enabled = enabled;
      return new Response(JSON.stringify(state.find((entry) => entry.id === id)!));
    }
    assert.ok(!init?.method || method === "GET", `unexpected ${method} ${url}`);
    return new Response(JSON.stringify({ packages: state }));
  };

  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: PackagesPage } = await import("../src/components/settings/PackagesPage.tsx");
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root.render(createElement(PackagesPage)); });
  const settle = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const settleMore = async () => { for (let i = 0; i < 5; i += 1) await settle(); };
  const button = (text: string | RegExp) => [...dom.document.body.querySelectorAll("button")]
    .find((candidate) => typeof text === "string" ? candidate.textContent?.trim().startsWith(text) : text.test(candidate.textContent ?? ""));
  const click = async (element: object | null | undefined) => {
    assert.ok(element, "expected a clickable element");
    await act(async () => { (element as { click(): void }).click(); });
  };
  return {
    dom, container, patches, archived, deleted, settle, settleMore, button, click, act,
    async cleanup() {
      await act(async () => { root.unmount(); });
      offProfile();
      offSecondProfile();
      globalThis.fetch = originalFetch;
      await dom.happyDOM.close();
    },
  };
}

test("disabling a package that owns chats asks before touching them", async () => {
  const page = await mountPage();
  try {
    await page.settle();
    const toggle = page.container.querySelector('[data-package-id="creative-studio"] [role="switch"]');
    await page.click(toggle);
    await page.settleMore();
    // Nothing is disabled or archived until the person chooses.
    assert.deepEqual(page.patches, []);
    assert.deepEqual(page.archived, []);
    assert.deepEqual(page.deleted, []);
    assert.match(page.dom.document.body.textContent!, /Disable Creative Studio\?/);
    assert.match(page.dom.document.body.textContent!, /owns 2 chat/);
    // Cancel leaves the package enabled and the chats alone.
    await page.click(page.button("Cancel"));
    await page.settle();
    assert.deepEqual(page.patches, []);
    assert.equal(page.dom.document.body.querySelector(".package-sessions-dialog"), null);
  } finally {
    await page.cleanup();
  }
});

test("hide archives the package's chats and then disables it", async () => {
  const page = await mountPage();
  try {
    await page.settle();
    await page.click(page.container.querySelector('[data-package-id="creative-studio"] [role="switch"]'));
    await page.settle();
    await page.settleMore();
    await page.click(page.button("Hide chats"));
    await page.settle();
    assert.deepEqual(page.archived, [["video-1", "video-child"]], "the lane's chats and its delegated child are hidden");
    assert.deepEqual(page.deleted, []);
    assert.deepEqual(page.patches.filter((patch) => patch.id === "creative-studio"), [{ id: "creative-studio", enabled: false }]);
  } finally {
    await page.cleanup();
  }
});

test("clean up deletes the package's chats and then disables it", async () => {
  const page = await mountPage();
  try {
    await page.settle();
    await page.click(page.container.querySelector('[data-package-id="creative-studio"] [role="switch"]'));
    await page.settle();
    await page.settleMore();
    await page.click(page.button("Clean up chats"));
    await page.settle();
    assert.deepEqual(page.deleted, ["video-1", "video-child"]);
    assert.deepEqual(page.archived, []);
    assert.deepEqual(page.patches.filter((patch) => patch.id === "creative-studio"), [{ id: "creative-studio", enabled: false }]);
  } finally {
    await page.cleanup();
  }
});

test("a package with no chats of its own disables without a prompt", async () => {
  const page = await mountPage({ owned: false });
  try {
    await page.settle();
    await page.click(page.container.querySelector('[data-package-id="creative-studio"] [role="switch"]'));
    await page.settle();
    await page.settleMore();
    assert.equal(page.dom.document.body.querySelector(".package-sessions-dialog"), null);
    assert.deepEqual(page.patches.filter((patch) => patch.id === "creative-studio"), [{ id: "creative-studio", enabled: false }]);
    assert.deepEqual(page.archived, []);
  } finally {
    await page.cleanup();
  }
});

test("the host remembers a package's lane purpose after its profile unregisters", async () => {
  // This is the guarantee the whole flow rests on: an activation scope stamps
  // `ownerPackageId`, and the purpose stays attributable once the package is
  // off and its profile is gone.
  const { createPackageActivation } = await import("../src/packages/activation.ts");
  const { webPackageHost } = await import("../src/packages/webHost.ts");
  const { sessionPurposesOfPackage, ownerOfSessionPurpose, resetSessionPurposeOwnersForTest } = await import("../src/workbench/profiles.ts");
  resetSessionPurposeOwnersForTest();
  const activation = createPackageActivation("studio-pkg", webPackageHost);
  activation.host.workbench.profiles.register({
    id: "studio-pkg",
    label: "Studio",
    description: "",
    order: 90,
    defaultLayout: { surfaces: [] },
    sessionPurpose: "studio-pkg",
  });
  assert.deepEqual(sessionPurposesOfPackage("studio-pkg"), ["studio-pkg"]);
  assert.equal(ownerOfSessionPurpose("studio-pkg"), "studio-pkg");
  activation.dispose();
  assert.deepEqual(sessionPurposesOfPackage("studio-pkg"), ["studio-pkg"], "ownership outlives the profile");
  resetSessionPurposeOwnersForTest();
});

test("a bulk disable resolves every owning package, not just the first", async () => {
  // Two selected packages both own chats: resolving the first prompt must not
  // silently drop the rest of the batch.
  const page = await mountPage({ secondOwner: true });
  try {
    await page.settle();
    await page.click(page.container.querySelector(".packages-select-toggle"));
    await page.settle();
    for (const row of page.dom.document.body.querySelectorAll(".package-row input[type=checkbox]")) {
      await page.click(row);
    }
    await page.click(page.button(/^Disable \d/));
    await page.settleMore();
    assert.match(page.dom.document.body.textContent!, /Disable Creative Studio\?/);
    await page.click(page.button("Clean up chats"));
    await page.settleMore();
    assert.deepEqual(page.patches.map((patch) => patch.id).sort(), ["creative-studio", "git", "second-studio"]);
  } finally {
    await page.cleanup();
  }
});
