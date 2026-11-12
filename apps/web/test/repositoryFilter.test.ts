// Repository chips of a multi-repository Project: the pure rules
// (repositoryFilter.ts), the desktop session list and phone navigator that draw
// them, and the New chat that starts under the chosen chip.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project, SessionProjection } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  Event: dom.Event,
  getComputedStyle: (elt: Element, pseudo?: string | null) =>
    (dom as unknown as { getComputedStyle(el: Element, pseudo?: string | null): CSSStyleDeclaration })
      .getComputedStyle(elt, pseudo),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
Object.defineProperty(globalThis, "HTMLElement", {
  value: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
  configurable: true,
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  value: (callback: FrameRequestCallback) => { callback(0); return 0; },
  configurable: true,
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { value: () => {}, configurable: true });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = Date.now();
const repositories = [
  { id: "web", alias: "web", path: "/work/multi/web" },
  { id: "api", alias: "api", path: "/work/multi" },
  { id: "docs", alias: "docs", path: "/work/multi/docs" },
];
const multi: Project = { id: "multi", path: "/work/multi", name: "Multi", createdAt: 1, repositories, primaryRepositoryId: "api" };
const single: Project = { id: "single", path: "/work/single", name: "Single", createdAt: 2, repositories: [{ id: "primary", alias: "single", path: "/work/single" }] };
const subset = (...ids: string[]) => ({ mode: "subset" as const, repositories: ids.map((repositoryId) => ({ repositoryId, path: `/checkouts/${repositoryId}` })) });
const row = (id: string, extra: Partial<SessionProjection> = {}, projectId = "multi"): SessionProjection => ({
  id, projectId, title: id, status: "idle", createdAt: now, updatedAt: now, lastTurnAt: now, ...extra,
});
const multiSessions: SessionProjection[] = [
  row("api-only", { workspace: subset("api") }),
  // A summary row: its scope arrives as ids only.
  row("api-web", { summary: true, repositoryScope: { repositoryIds: ["api", "web"] } }),
  row("web-only", { workspace: subset("web") }),
  row("whole-mode", { workspace: { mode: "all", repositories: subset("api", "web", "docs").repositories } }),
  row("covering", { workspace: subset("docs", "web", "api") }),
  row("no-workspace"),
  row("api-child", { parentId: "api-only", workspace: subset("web") }),
  row("api-pinned", { workspace: subset("api"), pinned: { position: 0 } }),
];

const summaryRequests: URLSearchParams[] = [];
(globalThis as { fetch?: unknown }).fetch = async (url: string) => {
  const u = new URL(String(url), "http://localhost:3000");
  if (u.pathname === "/api/sessions/summaries") summaryRequests.push(u.searchParams);
  const body: unknown = u.pathname === "/api/sessions/summaries"
    ? { sessions: [], complete: true, revision: 0 }
    : u.pathname === "/api/sessions"
      ? (u.searchParams.get("projectId") === "multi" ? multiSessions : [])
      : u.pathname === "/api/worktrees"
        ? [{ path: `/work/${u.searchParams.get("projectId")}`, branch: "main", head: "a", isMain: true }]
        : [];
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const store = await import("../src/store.ts");
const { getRepositoryFilter, setRepositoryFilter, REPOSITORY_FILTER_KEY } = await import("../src/sidebarPrefs.ts");
const {
  activeRepositoryFilter, filterRepositoriesOf, newChatOptions, repositoryMarkParts, sessionMatchesRepositoryFilter, sessionRepositoryMark,
} = await import("../src/repositoryFilter.ts");
const { default: SessionList } = await import("../src/components/sidebar/SessionList.tsx");
const { default: MobileNavigator } = await import("../src/components/mobile/MobileNavigator.tsx");

const MouseEventCtor = (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
const click = (el: Element) => el.dispatchEvent(new MouseEventCtor("click", { bubbles: true }));
const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);

const publish = (projects: Project[]) => {
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, projects);
};

test("chips: none for one repository, primary first and a fixed tone per position", () => {
  assert.deepEqual(filterRepositoriesOf(single), []);
  assert.deepEqual(filterRepositoriesOf({ ...multi, repositories: undefined }), []);
  // A private room keeps its short list without chips.
  assert.deepEqual(filterRepositoriesOf({ ...multi, parentProjectId: "multi" }), []);
  const chips = filterRepositoriesOf(multi);
  assert.deepEqual(ids(chips), ["api", "web", "docs"]);
  assert.deepEqual(chips.map((chip) => chip.tone), [5, 2, 6]);
  assert.deepEqual(filterRepositoriesOf(multi), chips, "deterministic");
});

test("filter: subsets only, a covering subset is the whole project, children follow their parent", () => {
  const byId = new Map(multiSessions.map((session) => [session.id, session]));
  const projectIds = ids(filterRepositoriesOf(multi));
  const under = (repositoryId: string) =>
    ids(multiSessions.filter((session) => sessionMatchesRepositoryFilter(session, repositoryId, projectIds, byId)));
  assert.deepEqual(under("api"), ["api-only", "api-web", "api-child", "api-pinned"]);
  assert.deepEqual(under("web"), ["api-web", "web-only"]);
  assert.deepEqual(under("docs"), []);
  // A child whose parent is not loaded answers for itself.
  assert.equal(sessionMatchesRepositoryFilter(row("orphan", { parentId: "missing", workspace: subset("web") }), "web", projectIds, byId), true);
});

test("row mark: chip order, none for whole-project rows, removed registrations dropped", () => {
  const chips = filterRepositoriesOf(multi);
  assert.deepEqual(ids(sessionRepositoryMark(row("x", { workspace: subset("web", "api") }), chips) ?? []), ["api", "web"]);
  assert.equal(sessionRepositoryMark(row("x", { workspace: { mode: "all", repositories: [] } }), chips), undefined);
  assert.equal(sessionRepositoryMark(row("x"), chips), undefined);
  assert.equal(sessionRepositoryMark(row("x", { workspace: subset("api", "web", "docs") }), chips), undefined);
  assert.equal(sessionRepositoryMark(row("x", { workspace: subset("gone") }), chips), undefined);
  assert.equal(sessionRepositoryMark(row("x", { workspace: subset("api") }), filterRepositoriesOf(single)), undefined);
});

test("row mark under a chip: nothing for that repository alone, else only the others after a plus", () => {
  const chips = filterRepositoriesOf(multi);
  const [api, web, docs] = chips;
  assert.deepEqual(repositoryMarkParts([api!, web!], undefined), { shown: [api, web], plus: false }, "All draws the whole scope");
  assert.deepEqual(repositoryMarkParts([web!], "web"), { shown: [], plus: false }, "a scope of the chip alone draws nothing");
  assert.deepEqual(repositoryMarkParts([api!, web!], "web"), { shown: [api], plus: true }, "a wider scope draws the others");
  assert.deepEqual(repositoryMarkParts([api!, web!, docs!], "web"), { shown: [api, docs], plus: true });
  // A child listed by its parent's chip may not include the chip itself.
  assert.deepEqual(repositoryMarkParts([web!], "api"), { shown: [web], plus: false }, "no plus when the chip is not in the scope");
});

test("a chip whose repository is no longer registered reads as All", () => {
  assert.equal(activeRepositoryFilter(multi, "web"), "web");
  assert.equal(activeRepositoryFilter(multi, "gone"), undefined);
  assert.equal(activeRepositoryFilter(multi, undefined), undefined);
  assert.equal(activeRepositoryFilter({ ...multi, repositories: repositories.slice(0, 1) }, "web"), undefined);
});

test("desktop list: no chips for one repository; chips filter rows, pinned and nested children, and reach the server", async () => {
  publish([multi, single]);
  store.activateProject("multi");
  store.setSessions("multi", multiSessions);
  store.setSessions("single", [row("single-chat", { workspace: subset("primary") }, "single")]);
  setRepositoryFilter("multi", undefined);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const titles = () => [...container.querySelectorAll(".session-row .session-title-text")].map((node) => node.textContent);
  try {
    await act(async () => { root.render(createElement(SessionList, { projectId: "single" })); });
    assert.equal(container.querySelector(".repository-filter"), null, "a one-repository project shows no chip row");
    assert.equal(container.querySelector(".session-repository-mark"), null, "and no row marks");

    summaryRequests.length = 0;
    await act(async () => { root.render(createElement(SessionList, { projectId: "multi" })); });
    const toolbar = container.querySelector(".repository-filter")!;
    assert.ok(toolbar, "a multi-repository project shows its chips");
    assert.equal(toolbar.getAttribute("role"), "toolbar");
    const chips = () => [...toolbar.querySelectorAll<HTMLButtonElement>(".repository-filter-chip")];
    assert.deepEqual(chips().map((chip) => chip.textContent), ["All", "api", "web", "docs"]);
    assert.deepEqual(chips().map((chip) => chip.getAttribute("aria-pressed")), ["true", "false", "false", "false"]);
    assert.deepEqual(chips().map((chip) => chip.tabIndex), [0, -1, -1, -1], "one tab stop");
    assert.ok(chips()[1]!.querySelector('.repository-dot'), "a repository chip carries its dot");
    assert.equal(chips()[1]!.getAttribute("data-repository-tone"), "5");
    // All lists every chat; subset rows carry a mark with an accessible name.
    for (const title of ["api-only", "api-web", "web-only", "whole-mode", "covering", "no-workspace", "api-pinned"]) {
      assert.ok(titles().includes(title), `${title} under All`);
    }
    const markOf = (title: string) => [...container.querySelectorAll(".session-row")]
      .find((element) => element.querySelector(".session-title-text")?.textContent === title)
      ?.querySelector(".session-repository-mark") ?? undefined;
    assert.equal(markOf("api-web")?.getAttribute("aria-label"), "Repositories: api, web");
    assert.equal(markOf("api-web")?.querySelector(".repository-mark-text")?.textContent, "api+web");
    assert.equal(markOf("api-only")?.getAttribute("aria-label"), "Repository: api");
    assert.equal(markOf("whole-mode"), undefined, "whole-project rows carry no mark");
    assert.equal(markOf("covering"), undefined, "a subset covering every repository is the whole project");
    assert.equal(markOf("no-workspace"), undefined);
    assert.ok(summaryRequests.every((params) => !params.has("repositoryId")), "All sends no repository filter");

    await act(async () => { click(chips()[1]!); });
    assert.equal(getRepositoryFilter("multi"), "api");
    assert.match(localStorage.getItem(REPOSITORY_FILTER_KEY) ?? "", /"multi":"api"/);
    assert.deepEqual(chips().map((chip) => chip.getAttribute("aria-pressed")), ["false", "true", "false", "false"]);
    assert.deepEqual(titles().sort(), ["api-only", "api-pinned", "api-web"], "only api chats; the pinned one keeps its section");
    assert.ok(container.querySelector(".session-pinned")?.textContent?.includes("api-pinned"));
    const parent = [...container.querySelectorAll(".session-row")]
      .find((element) => element.querySelector(".session-title-text")?.textContent === "api-only")!;
    assert.ok(parent.querySelector(".session-subagent-toggle"), "the web-scoped child stays nested under its api parent");
    const rowOf = (title: string) => [...container.querySelectorAll(".session-row")]
      .find((element) => element.querySelector(".session-title-text")?.textContent === title)!;
    assert.equal(markOf("api-only"), undefined, "under its own chip an api-only row draws no mark");
    const described = rowOf("api-only").querySelector("[aria-describedby]")?.getAttribute("aria-describedby")?.split(" ") ?? [];
    assert.ok(described.some((id) => container.querySelector(`[id="${id}"]`)?.textContent === "Repository: api"),
      "its description still names the scope");
    const wider = markOf("api-web")!;
    assert.ok(wider.querySelector(".repository-mark-plus"), "a wider scope draws a plus");
    assert.deepEqual([...wider.querySelectorAll(".repository-dot")].map((dot) => dot.getAttribute("data-repository-tone")), ["2"],
      "then only the other repositories (web)");
    assert.equal(wider.querySelector(".repository-mark-text")?.textContent, "web", "with the others' aliases");
    assert.equal(wider.getAttribute("aria-label"), "Repositories: api, web", "its accessible name is the full scope");
    assert.ok(summaryRequests.some((params) => params.get("repositoryId") === "api" && params.get("projectId") === "multi"),
      "the server applies the chip to the project's pages");

    await act(async () => { click(chips()[2]!); });
    assert.deepEqual(titles().sort(), ["api-web", "web-only"], "a child follows its parent, not its own scope");

    await act(async () => { click(chips()[0]!); });
    assert.equal(getRepositoryFilter("multi"), undefined, "All clears the preference");
    assert.ok(titles().includes("whole-mode"));
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    setRepositoryFilter("multi", undefined);
  }
});

test("a removed repository registration resets the chip to All", async () => {
  publish([multi]);
  store.setSessions("multi", multiSessions);
  setRepositoryFilter("multi", "docs");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    publish([{ ...multi, repositories: repositories.filter((repository) => repository.id !== "docs") }]);
    await act(async () => { root.render(createElement(SessionList, { projectId: "multi" })); });
    const pressed = container.querySelector('.repository-filter-chip[aria-pressed="true"]');
    assert.equal(pressed?.textContent, "All");
    assert.equal(getRepositoryFilter("multi"), undefined, "the stale entry is cleared");
    assert.ok([...container.querySelectorAll(".session-title-text")].some((node) => node.textContent === "whole-mode"));
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    setRepositoryFilter("multi", undefined);
  }
});

test("New chat starts under the chosen chip, keeps a restored draft's own scope, and All is the whole project", () => {
  publish([multi, single]);
  store.activateProject("multi");
  setRepositoryFilter("multi", "web");
  try {
    assert.deepEqual(newChatOptions(single), {}, "a one-repository project's New chat is unchanged");
    assert.deepEqual(newChatOptions(multi), { repositoryFilter: { ids: ["web"] } });

    store.startFreshSession("multi", newChatOptions(multi));
    assert.deepEqual(store.getState().newSessionIntent?.repositoryIds, ["web"]);

    // Back to All: an empty unsent chat follows the chip again.
    setRepositoryFilter("multi", undefined);
    store.startFreshSession("multi", newChatOptions(multi));
    assert.equal(store.getState().newSessionIntent?.repositoryIds, undefined);

    // A draft with its own scope is restored with it, whatever the chip says.
    store.startNewSession("multi", { draft: "about the docs", repositoryIds: ["docs"] });
    setRepositoryFilter("multi", "web");
    store.startFreshSession("multi", newChatOptions(multi));
    assert.equal(store.getState().newSessionIntent?.draft, "about the docs");
    assert.deepEqual(store.getState().newSessionIntent?.repositoryIds, ["docs"]);

    // A draft without a scope of its own takes the chip.
    store.startNewSession("multi", { draft: "anywhere" });
    store.setNewSessionRepositories("multi", undefined);
    store.startFreshSession("multi", newChatOptions(multi));
    assert.equal(store.getState().newSessionIntent?.draft, "anywhere");
    assert.deepEqual(store.getState().newSessionIntent?.repositoryIds, ["web"]);
  } finally {
    setRepositoryFilter("multi", undefined);
    store.startNewSession("multi", { draft: "" });
  }
});

test("the phone navigator shows the chips and narrows the project's chats", async () => {
  publish([multi, single]);
  store.activateProject("multi");
  store.setSessions("multi", multiSessions);
  store.setSessions("single", [row("single-chat", {}, "single")]);
  setRepositoryFilter("multi", undefined);
  localStorage.setItem("polyth.sidebar.expandedProjects", '["multi","single"]');
  localStorage.setItem("polyth.sidebar.showAllProjects", '["multi","single"]');
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const section = (id: string) => container.querySelector(`[data-project-id="${id}"]`)!;
  const titles = (id: string) => [...section(id).querySelectorAll(".mobile-nav-session-title")].map((node) => node.textContent);
  try {
    store.setSidebarOpen(true);
    await act(async () => { root.render(createElement(MobileNavigator)); });
    assert.equal(section("single").querySelector(".repository-filter"), null, "no chips for one repository");
    const toolbar = section("multi").querySelector(".repository-filter")!;
    assert.ok(toolbar, "chips under an expanded multi-repository project");
    assert.equal(toolbar.getAttribute("data-variant"), "phone");
    assert.ok(titles("multi").includes("whole-mode"));
    const apiWeb = [...section("multi").querySelectorAll(".mobile-nav-session-row, .mobile-nav-session-main")]
      .find((element) => element.getAttribute("aria-label")?.startsWith("api-web,"));
    assert.match(apiWeb?.getAttribute("aria-label") ?? "", /Repositories: api, web/, "the row names its repositories");

    assert.ok(!toolbar.previousElementSibling?.closest(".mobile-nav-session-row"), "the chips come before the chats");
    assert.ok(toolbar.nextElementSibling?.classList.contains("mobile-nav-pinned"),
      "directly above the project's chats (here the pinned caption), below its leading groups");

    await act(async () => { click(toolbar.querySelectorAll(".repository-filter-chip")[1]!); });
    assert.equal(getRepositoryFilter("multi"), "api");
    assert.deepEqual(titles("multi").sort(), ["api-only", "api-pinned", "api-web"]);
    const phoneRow = (title: string) => [...section("multi").querySelectorAll(".mobile-nav-session-row, .mobile-nav-session-main")]
      .find((element) => element.getAttribute("aria-label")?.startsWith(`${title},`))!;
    const phoneMark = (title: string) => phoneRow(title).closest(".mobile-nav-session-row")?.querySelector(".session-repository-mark") ?? null;
    assert.equal(phoneMark("api-only"), null, "under its own chip an api-only row draws no mark");
    assert.match(phoneRow("api-only").getAttribute("aria-label") ?? "", /Repository: api/, "its name keeps the scope");
    assert.ok(phoneMark("api-web")?.querySelector(".repository-mark-plus"), "a wider scope draws a plus and the others");
    assert.equal(phoneMark("api-web")?.querySelectorAll(".repository-dot").length, 1);
    assert.equal(phoneMark("api-web")?.querySelector(".repository-mark-text")?.textContent, "web");
    assert.equal(phoneMark("api-web")?.getAttribute("aria-label"), "Repositories: api, web");
    assert.deepEqual(titles("single"), ["single-chat"], "another project is untouched");
  } finally {
    await act(async () => { root.unmount(); store.setSidebarOpen(false); });
    container.remove();
    setRepositoryFilter("multi", undefined);
    localStorage.removeItem("polyth.sidebar.expandedProjects");
    localStorage.removeItem("polyth.sidebar.showAllProjects");
  }
});
