import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { SessionProjection } from "@polyth/contracts";
import { heroRecentIsNarrowed, heroRecentPageSize, heroRecentProjectIds, heroRecentSummaryQuery, isAutomatedSession, selectHeroRecentSessions } from "../src/heroRecent.ts";
import {
  defaultHeroWidgetPrefs,
  getHeroWidgetPrefs,
  HERO_CHROME_DEFAULTS,
  HERO_RECENT_DEFAULTS,
  isDefaultHeroRecentPrefs,
  isDefaultHeroWidgetPrefs,
  normalizeHeroChromePrefs,
  normalizeHeroRecentPrefs,
  replaceHeroWidgetPrefs,
  setHeroChromePrefs,
  setHeroRecentPrefs,
  setHeroWidgetPrefs,
  type HeroRecentPrefs,
} from "../src/heroWidgetPrefs.ts";

const NOW = 1_800_000_000_000;

function session(id: string, patch: Partial<SessionProjection> = {}): SessionProjection {
  return {
    id,
    projectId: "p1",
    title: id,
    status: "idle",
    createdAt: NOW - 10_000,
    updatedAt: NOW - 10_000,
    ...patch,
  } as SessionProjection;
}

const prefs = (patch: Partial<HeroRecentPrefs> = {}): HeroRecentPrefs => ({ ...HERO_RECENT_DEFAULTS, ...patch });
const ids = (rows: readonly SessionProjection[]) => rows.map((row) => row.id);

const SESSIONS = [
  session("old", { lastTurnAt: NOW - 9_000 }),
  session("new", { lastTurnAt: NOW - 1_000 }),
  session("mid", { lastTurnAt: NOW - 5_000, attention: { unread: 2 } as SessionProjection["attention"] }),
  session("working", { lastTurnAt: NOW - 6_000, status: "working" }),
  session("child", { lastTurnAt: NOW - 500, parentId: "new" }),
  session("archived", { lastTurnAt: NOW - 100, status: "archived" }),
  session("other", { lastTurnAt: NOW - 200, projectId: "p2" }),
  session("third", { lastTurnAt: NOW - 300, projectId: "p3" }),
];

test("defaults keep the original list: this project, newest three, no archived or subagent rows", () => {
  assert.deepEqual(ids(selectHeroRecentSessions(SESSIONS, prefs(), "p1", NOW)), ["new", "mid", "working"]);
  assert.equal(heroRecentIsNarrowed(prefs()), false);
});

test("count, subagent and status filters narrow the list", () => {
  assert.deepEqual(ids(selectHeroRecentSessions(SESSIONS, prefs({ limit: 5 }), "p1", NOW)), ["new", "mid", "working", "old"]);
  assert.deepEqual(ids(selectHeroRecentSessions(SESSIONS, prefs({ subagents: true }), "p1", NOW)), ["child", "new", "mid"]);
  assert.deepEqual(ids(selectHeroRecentSessions(SESSIONS, prefs({ filter: "unread" }), "p1", NOW)), ["mid"]);
  assert.deepEqual(ids(selectHeroRecentSessions(SESSIONS, prefs({ filter: "active" }), "p1", NOW)), ["working"]);
  assert.equal(heroRecentIsNarrowed(prefs({ filter: "unread" })), true);
});

test("project scope spans the current project, every project, or a chosen set", () => {
  assert.deepEqual(ids(selectHeroRecentSessions(SESSIONS, prefs({ scope: "all" }), "p1", NOW)), ["other", "third", "new"]);
  assert.deepEqual(
    ids(selectHeroRecentSessions(SESSIONS, prefs({ scope: "selected", projectIds: ["p3"] }), "p1", NOW)),
    ["third"],
  );
  assert.deepEqual(selectHeroRecentSessions(SESSIONS, prefs({ scope: "selected", projectIds: [] }), "p1", NOW), []);
  assert.equal(heroRecentIsNarrowed(prefs({ scope: "selected" })), true);
  assert.equal(heroRecentProjectIds(prefs({ scope: "all" }), "p1"), null);
  assert.deepEqual([...heroRecentProjectIds(prefs(), null)!], []);
});

test("automated sessions are left out by default and shown on request", () => {
  const rows = [
    ...SESSIONS,
    session("agent-run", { lastTurnAt: NOW - 400, origin: { source: "agents", wake: "schedule", label: "Watcher" } }),
    session("legacy-agent", { lastTurnAt: NOW - 410, purpose: "agent" }),
    session("incident", { lastTurnAt: NOW - 420, origin: { source: "monitoring", wake: "alert", label: "Monitoring" } }),
    session("agent-child", { lastTurnAt: NOW - 430, parentId: "legacy-agent" }),
  ];
  const claimed = new Set(["agent"]);
  // Hidden by default; an unclaimed legacy purpose is plain metadata, so
  // only the live claim makes those rows automation.
  assert.deepEqual(ids(selectHeroRecentSessions(rows, prefs(), "p1", NOW)), ["legacy-agent", "new", "mid"]);
  assert.deepEqual(ids(selectHeroRecentSessions(rows, prefs(), "p1", NOW, 3, claimed)), ["new", "mid", "working"]);
  // Shown when asked; a parentless legacy agent session needs the claim.
  assert.deepEqual(
    ids(selectHeroRecentSessions(rows, prefs({ automated: true }), "p1", NOW)),
    ["agent-run", "legacy-agent", "incident"],
  );
  assert.deepEqual(
    ids(selectHeroRecentSessions(rows, prefs({ automated: true }), "p1", NOW, 6, claimed)),
    ["agent-run", "legacy-agent", "incident", "new", "mid", "working"],
  );
  // A child is automation through its parent, and still a subagent row.
  assert.deepEqual(
    ids(selectHeroRecentSessions(rows, prefs({ automated: true, subagents: true }), "p1", NOW, 7, claimed)),
    ["agent-run", "legacy-agent", "incident", "agent-child", "child", "new", "mid"],
  );
  assert.deepEqual(
    ids(selectHeroRecentSessions(rows, prefs({ subagents: true }), "p1", NOW)),
    ["legacy-agent", "agent-child", "child"],
  );
});

test("isAutomatedSession reads origin, a claimed purpose, or an automated parent", () => {
  const rows = [
    session("agent-run", { origin: { source: "agents", wake: "heartbeat", label: "Watcher" } }),
    session("legacy", { purpose: "agent" }),
    session("ordinary", { purpose: "playground" }),
    session("child-of-legacy", { parentId: "legacy" }),
    session("grandchild", { parentId: "child-of-legacy" }),
    session("loop-a", { parentId: "loop-b" }),
    session("loop-b", { parentId: "loop-a" }),
  ];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const claimed = new Set(["agent"]);
  assert.equal(isAutomatedSession(rows[0]!, byId, claimed), true);
  assert.equal(isAutomatedSession(rows[1]!, byId, claimed), true);
  assert.equal(isAutomatedSession(rows[1]!, byId), false, "an unclaimed purpose is ordinary metadata");
  assert.equal(isAutomatedSession(rows[2]!, byId, claimed), false);
  assert.equal(isAutomatedSession(rows[3]!, byId, claimed), true, "a child follows its parent");
  assert.equal(isAutomatedSession(rows[4]!, byId, claimed), true, "so does a grandchild");
  assert.equal(isAutomatedSession(rows[5]!, byId, claimed), false, "a parent cycle terminates");
});

test("the automation preference normalizes like the subagent one", () => {
  assert.deepEqual(normalizeHeroRecentPrefs({ automated: "yes" }), HERO_RECENT_DEFAULTS);
  assert.deepEqual(normalizeHeroRecentPrefs({ automated: true }), { ...HERO_RECENT_DEFAULTS, automated: true });
  assert.deepEqual(normalizeHeroRecentPrefs({ limit: 5 }), { ...HERO_RECENT_DEFAULTS, limit: 5 }, "an older payload keeps it off");
  assert.equal(HERO_RECENT_DEFAULTS.automated, false);
  assert.equal(isDefaultHeroRecentPrefs(prefs({ automated: true })), false);
  setHeroRecentPrefs({ automated: true });
  assert.equal(getHeroWidgetPrefs().recent.automated, true);
  replaceHeroWidgetPrefs({ order: ["starters", "recent"], hidden: [], recent: { limit: 5 } });
  assert.equal(getHeroWidgetPrefs().recent.automated, false);
});

test("preferences normalize untrusted values and survive older synced payloads", () => {
  assert.deepEqual(
    normalizeHeroRecentPrefs({ limit: 99, filter: "bogus", subagents: "yes", scope: "selected", projectIds: ["a", "a", 3, ""], size: "xl" }),
    { ...HERO_RECENT_DEFAULTS, scope: "selected", projectIds: ["a"] },
  );
  assert.deepEqual(normalizeHeroRecentPrefs(undefined), HERO_RECENT_DEFAULTS);

  setHeroRecentPrefs({ limit: 8, size: "lg" });
  assert.equal(getHeroWidgetPrefs().recent.limit, 8);
  assert.equal(isDefaultHeroRecentPrefs(getHeroWidgetPrefs().recent), false);
  // A client that predates Recent settings syncs only order/hidden.
  replaceHeroWidgetPrefs({ order: ["recent", "starters"], hidden: [] });
  assert.deepEqual(getHeroWidgetPrefs().order, ["recent", "starters", "apps"], "a newer widget joins at the end");
  assert.equal(getHeroWidgetPrefs().recent.size, "lg");
  replaceHeroWidgetPrefs({ order: ["starters", "recent"], hidden: [], recent: { limit: 5 } });
  assert.deepEqual(getHeroWidgetPrefs().recent, { ...HERO_RECENT_DEFAULTS, limit: 5 });
  assert.equal(isDefaultHeroRecentPrefs(prefs({ projectIds: ["p9"] })), true, "ids only matter for Selected");
});

test("the Recent list has no heading or chrome; its options live in the screen's Customize panel", async () => {
  const surface = await readFile(new URL("../src/components/workspace/builtinSurfaces.tsx", import.meta.url), "utf8");
  const customize = await readFile(new URL("../src/components/mobile/HeroCustomize.tsx", import.meta.url), "utf8");
  const body = surface.slice(surface.indexOf("function RecentSessions"), surface.indexOf("// UX-TIMELINE-LAYOUT-01"));
  assert.doesNotMatch(body, /hero-recent-head|<h3|SettingsButton|<button[^>]*hero-recent-settings/);
  assert.match(body, /selectHeroRecentSessions\(sessions, prefs, projectId,/);
  // Automation is decided from the live claimed listing purposes.
  assert.match(body, /useSyncExternalStore\(subscribeSessionListing, claimedListingPurposes, claimedListingPurposes\)/);
  assert.match(body, /hero-recent-row--automated/);
  assert.match(body, /hero-recent-status--automated/);
  assert.match(body, /className="hero-recent-origin"/);
  // Scrolls within its configured height and pages older sessions on demand.
  assert.match(body, /"--hero-recent-rows": prefs\.limit/);
  assert.match(body, /useSessionSummaryPages\(summaryQuery, pagingEnabled\)/);
  assert.match(body, /className="hero-recent-more"/);
  assert.match(body, /data-size=\{prefs\.size\}/);
  assert.match(customize, /<HeroRecentOptions prefs=\{prefs\.recent\}/);
  const settings = await readFile(new URL("../src/components/mobile/HeroRecentSettings.tsx", import.meta.url), "utf8");
  const subagentsRow = settings.indexOf("hero-recent-subagents");
  const automatedRow = settings.indexOf("hero-recent-automated");
  assert.ok(subagentsRow > 0 && automatedRow > subagentsRow, "the Agent sessions switch follows Subagent sessions");
  assert.match(settings, /checked=\{prefs\.automated\}/);
});

test("fixed screen pieces default on, normalize untrusted values and survive older synced payloads", () => {
  assert.deepEqual(normalizeHeroChromePrefs({ greeting: false, location: "no", isolation: 0 }), { ...HERO_CHROME_DEFAULTS, greeting: false });
  setHeroWidgetPrefs(defaultHeroWidgetPrefs());
  assert.equal(isDefaultHeroWidgetPrefs(getHeroWidgetPrefs()), true);
  setHeroChromePrefs({ location: false });
  assert.equal(isDefaultHeroWidgetPrefs(getHeroWidgetPrefs()), false);
  // A client that predates the Customize panel syncs no `chrome`.
  replaceHeroWidgetPrefs({ order: ["starters", "recent"], hidden: [] });
  assert.equal(getHeroWidgetPrefs().chrome.location, false);
  replaceHeroWidgetPrefs({ order: ["starters", "recent"], hidden: [], chrome: { greeting: false } });
  assert.deepEqual(getHeroWidgetPrefs().chrome, { ...HERO_CHROME_DEFAULTS, greeting: false });
  setHeroRecentPrefs({ scope: "selected", projectIds: ["p7"] });
  const reset = defaultHeroWidgetPrefs();
  assert.equal(isDefaultHeroWidgetPrefs(reset), true);
  assert.deepEqual(reset.recent.projectIds, ["p7"], "Reset keeps the chosen projects for a later Selected");
});

test("an explicit limit pages past the configured count without changing order", () => {
  assert.deepEqual(ids(selectHeroRecentSessions(SESSIONS, prefs(), "p1", NOW, 2)), ["new", "mid"]);
  assert.deepEqual(
    ids(selectHeroRecentSessions(SESSIONS, prefs(), "p1", NOW, Number.POSITIVE_INFINITY)),
    ["new", "mid", "working", "old"],
  );
});

test("the paging query narrows on the server only for exactly one project", () => {
  assert.deepEqual(heroRecentSummaryQuery(prefs(), "p1"), { archived: false, limit: 30, projectId: "p1" });
  assert.deepEqual(heroRecentSummaryQuery(prefs({ scope: "all" }), "p1"), { archived: false, limit: 30 });
  assert.deepEqual(heroRecentSummaryQuery(prefs({ scope: "selected", projectIds: ["p2"] }), "p1"), { archived: false, limit: 30, projectId: "p2" });
  assert.deepEqual(heroRecentSummaryQuery(prefs({ scope: "selected", projectIds: ["p2", "p3"] }), "p1"), { archived: false, limit: 30 });
  assert.ok(heroRecentPageSize(prefs({ limit: 3 })) >= 3);
  assert.equal(heroRecentPageSize(prefs({ limit: 12 })), 12);
});

test("a limit-waiting recent row uses the navigator's timer icon, not the emoji glyph", async () => {
  const surface = await readFile(new URL("../src/components/workspace/builtinSurfaces.tsx", import.meta.url), "utf8");
  const body = surface.slice(surface.indexOf("function RecentSessions"), surface.indexOf("// UX-TIMELINE-LAYOUT-01"));
  assert.match(body, /status\.kind === "rate-limited" \? \(\s*<span className="hero-recent-icon" aria-hidden><MobileStatusIcon kind="rate-limited" \/><\/span>/);
});
