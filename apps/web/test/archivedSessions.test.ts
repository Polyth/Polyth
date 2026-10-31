// Archived sessions view: pure filter/merge/group rules, and the mounted
// surface (paged archive read, transcript hits, archive-date filter, restore).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { SessionProjection, SessionSummaryQuery } from "@polyth/contracts";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
Object.defineProperty(globalThis, "HTMLElement", {
  value: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
  configurable: true,
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { api } = await import("@polyth/session/web-api");
const store = await import("../src/store.ts");
const archived = await import("../src/archivedSessions.ts");
const { default: ArchivedSessionsDialog } = await import("../src/components/ArchivedSessionsDialog.tsx");

const DAY = 24 * 60 * 60_000;
const NOW = Date.now();
const session = (id: string, ageDays: number, extra: Partial<SessionProjection> = {}): SessionProjection => ({
  id,
  projectId: "p1",
  title: id,
  status: "archived",
  createdAt: NOW - ageDays * DAY - DAY,
  updatedAt: NOW - ageDays * DAY,
  ...extra,
});

test("archive-date presets bound by the archive time, not the creation time", () => {
  const entry = (ageDays: number) => ({ session: session("s", ageDays), messageHits: 0 });
  const any = archived.ARCHIVED_ANY_BRANCH;
  assert.equal(archived.matchesArchivedFilters(entry(3), { preset: "week", branch: any }, NOW), true);
  assert.equal(archived.matchesArchivedFilters(entry(9), { preset: "week", branch: any }, NOW), false);
  assert.equal(archived.matchesArchivedFilters(entry(29), { preset: "month", branch: any }, NOW), true);
  assert.equal(archived.matchesArchivedFilters(entry(29), { preset: "older", branch: any }, NOW), false);
  assert.equal(archived.matchesArchivedFilters(entry(31), { preset: "older", branch: any }, NOW), true);
  assert.equal(archived.matchesArchivedFilters(entry(0), { preset: "today", branch: any }, NOW), true);
});

test("branch filter keys the project checkout separately from named branches", () => {
  const main = { session: session("a", 1), messageHits: 0 };
  const feature = { session: session("b", 1, { branch: "feat/x" }), messageHits: 0 };
  const filters = { preset: "any" as const, branch: archived.ARCHIVED_MAIN_BRANCH };
  assert.equal(archived.matchesArchivedFilters(main, filters, NOW), true);
  assert.equal(archived.matchesArchivedFilters(feature, filters, NOW), false);
  assert.deepEqual(archived.archivedBranchOptions([main, feature, { session: session("c", 2, { branch: "feat/x" }), messageHits: 0 }]),
    ["feat/x", archived.ARCHIVED_MAIN_BRANCH]);
});

test("transcript hits enrich rows, add archive-only matches and ignore live or foreign sessions", () => {
  const rows = [session("s1", 1), session("s2", 5)];
  const hit = (sessionId: string, status: string, projectId = "p1") => ({
    sessionId, projectId, title: `hit ${sessionId}`, status, updatedAt: NOW - 2 * DAY, messageHits: 2,
    matches: [{ field: "message" as const, snippet: "needle here", ranges: [[0, 6]] as Array<[number, number]>, seq: 9, role: "user" as const }],
  });
  const entries = archived.mergeArchivedEntries(rows, [hit("s2", "archived"), hit("s3", "archived"), hit("s4", "idle"), hit("s5", "archived", "p2")], "p1");
  assert.deepEqual(entries.map((entry) => entry.session.id), ["s1", "s3", "s2"]);
  assert.equal(entries.find((entry) => entry.session.id === "s2")?.match?.seq, 9);
  assert.equal(entries.find((entry) => entry.session.id === "s3")?.session.title, "hit s3");
});

test("recency presets stop paging once the oldest loaded row predates the window", () => {
  assert.equal(archived.archivedPagingSatisfied([session("a", 1), session("b", 3)], "week", NOW), false);
  assert.equal(archived.archivedPagingSatisfied([session("a", 1), session("b", 8)], "week", NOW), true);
  assert.equal(archived.archivedPagingSatisfied([session("a", 1), session("b", 80)], "older", NOW), false);
  assert.equal(archived.archivedPagingSatisfied([session("a", 1), session("b", 80)], "any", NOW), false);
});

test("rows group under one heading per archive day, preserving order", () => {
  const groups = archived.groupArchivedByDay([session("a", 0), session("b", 0), session("c", 4)]
    .map((row) => ({ session: row, messageHits: 0 })));
  assert.deepEqual(groups.map((group) => group.entries.map((entry) => entry.session.id)), [["a", "b"], ["c"]]);
});

// ---- mounted surface --------------------------------------------------------

const ARCHIVE = [
  session("s-recent", 1, { title: "Refactor login form", branch: "feat/login" }),
  session("s-mid", 12, { title: "Fix flaky deploy" }),
  session("s-old", 60, { title: "Old billing notes", branch: "feat/billing" }),
];
let summaryCalls: SessionSummaryQuery[] = [];
let searchCalls: string[] = [];
let bulkCalls: Array<{ op: string; ids: string[] }> = [];
const original = {
  list: api.listSessionSummaries,
  search: api.searchSessions,
  bulk: api.bulkSessions,
  sessions: api.listSessions,
};

before(() => {
  api.listSessionSummaries = (async (query: SessionSummaryQuery) => {
    summaryCalls.push(query);
    const needle = query.query?.toLowerCase();
    const rows = ARCHIVE.filter((row) => query.archived !== true || row.status === "archived")
      .filter((row) => !needle || row.title.toLowerCase().includes(needle));
    return { sessions: rows.slice(0, query.limit ?? 50), complete: true, revision: 1 };
  }) as typeof api.listSessionSummaries;
  api.searchSessions = (async (q: string) => {
    searchCalls.push(q);
    return q === "invoice"
      ? [{
          sessionId: "s-old", projectId: "p1", title: "Old billing notes", status: "archived", updatedAt: ARCHIVE[2]!.updatedAt, messageHits: 3,
          matches: [{ field: "message", snippet: "the invoice total", ranges: [[4, 11]], seq: 12, role: "assistant" }],
        }]
      : [];
  }) as typeof api.searchSessions;
  api.bulkSessions = (async (op: "archive" | "restore", ids: string[]) => {
    bulkCalls.push({ op, ids });
    return { succeeded: ids, failed: [] };
  }) as typeof api.bulkSessions;
  api.listSessions = (async () => []) as unknown as typeof api.listSessions;
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [{ id: "p1", name: "Polyth", path: "/repos/polyth", createdAt: 1 }]);
});

after(() => {
  api.listSessionSummaries = original.list;
  api.searchSessions = original.search;
  api.bulkSessions = original.bulk;
  api.listSessions = original.sessions;
});

async function mount() {
  store.openArchivedSessions("p1");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(ArchivedSessionsDialog)); });
  await settle(10);
  return {
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
      store.setOverlay(null);
    },
  };
}
const settle = async (ms: number) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const titles = () => [...document.querySelectorAll(".archived-sessions-title")].map((node) => node.textContent);
const input = () => document.querySelector<HTMLInputElement>(".archived-sessions-input")!;
async function type(value: string) {
  await act(async () => {
    const el = input();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await settle(200);
}
const click = async (element: Element) => {
  await act(async () => { (element as HTMLElement).click(); });
  await settle(10);
};

test("opens on the project's archive, newest archived first, grouped by day", async () => {
  summaryCalls = [];
  const view = await mount();
  assert.deepEqual(summaryCalls[0], { projectId: "p1", archived: true, limit: 50, cursor: undefined, revision: undefined });
  assert.deepEqual(titles(), ["Refactor login form", "Fix flaky deploy", "Old billing notes"]);
  assert.equal(document.querySelectorAll(".archived-sessions-day").length, 3);
  assert.ok(document.querySelector(".archived-sessions-project")?.textContent === "Polyth");
  await view.unmount();
});

test("date presets narrow the loaded archive and the empty state offers a reset", async () => {
  const view = await mount();
  const chip = (label: string) => [...document.querySelectorAll(".archived-sessions-chip")]
    .find((node) => node.textContent === label)!;
  await click(chip("Past week"));
  assert.deepEqual(titles(), ["Refactor login form"]);
  await click(chip("Older"));
  assert.deepEqual(titles(), ["Old billing notes"]);
  await click(chip("Today"));
  assert.deepEqual(titles(), []);
  const reset = [...document.querySelectorAll(".archived-sessions-empty button")].find((node) => node.textContent === "Clear filters");
  assert.ok(reset, "filtered-out archive offers Clear filters");
  await click(reset!);
  assert.equal(titles().length, 3);
  await view.unmount();
});

test("search queries titles server-side and finds archived chats by their messages", async () => {
  summaryCalls = [];
  searchCalls = [];
  const view = await mount();
  await type("invoice");
  assert.ok(summaryCalls.some((call) => call.query === "invoice"), "title/branch search goes to the server");
  assert.deepEqual(searchCalls, ["invoice"]);
  assert.deepEqual(titles(), ["Old billing notes"]);
  assert.equal(document.querySelector(".archived-sessions-snippet .archived-sessions-mark")?.textContent, "invoice");
  await view.unmount();
});

test("restore sends the canonical bulk restore and drops the row from the archive", async () => {
  bulkCalls = [];
  const view = await mount();
  const restore = document.querySelector('[aria-label="Restore “Fix flaky deploy”"]');
  assert.ok(restore);
  await click(restore!);
  assert.deepEqual(bulkCalls, [{ op: "restore", ids: ["s-mid"] }]);
  assert.deepEqual(titles(), ["Refactor login form", "Old billing notes"]);
  await view.unmount();
});

test("restore hides the row before the server answers and a failure puts it back in place", async () => {
  const bulk = api.bulkSessions;
  let release!: () => void;
  api.bulkSessions = (async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    throw Object.assign(new Error("restore refused"), { code: "conflict" });
  }) as typeof api.bulkSessions;
  const view = await mount();
  try {
    const before = titles();
    await act(async () => { (document.querySelector('[aria-label="Restore “Fix flaky deploy”"]') as HTMLElement).click(); });
    assert.deepEqual(titles(), before.filter((title) => title !== "Fix flaky deploy"), "row left immediately");
    await act(async () => { release(); });
    await settle(10);
    assert.deepEqual(titles(), before, "rejected restore returns the row in its original position");
  } finally {
    api.bulkSessions = bulk;
    await view.unmount();
  }
});

test("selection restores several sessions at once from the footer bar", async () => {
  bulkCalls = [];
  const view = await mount();
  await click(document.querySelector(".archived-sessions-select-all")!);
  assert.ok(document.querySelector(".archived-sessions-selection-count")?.textContent?.startsWith("3"));
  const restore = [...document.querySelectorAll(".archived-sessions-selection button")].find((node) => node.textContent?.includes("Restore"));
  await click(restore!);
  assert.equal(bulkCalls.length, 1);
  assert.deepEqual([...bulkCalls[0]!.ids].sort(), ["s-mid", "s-old", "s-recent"]);
  await view.unmount();
});
