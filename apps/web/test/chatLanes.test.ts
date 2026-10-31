import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import { sessionsInLane, newSessionLaneDraftId, lanePurposeOf } from "../src/workbench/lanes.ts";

const sessions = [
  { id: "ord" },
  { id: "play", purpose: "playground" },
  { id: "child", parentId: "play" },
  { id: "grand", parentId: "child" },
  { id: "noted", parentId: "ord", purpose: "notes" },
];

test("lane membership follows a session's own purpose or its nearest ancestor", () => {
  assert.deepEqual(sessionsInLane(sessions, "playground").map((session) => session.id), ["play", "child", "grand"]);
  assert.deepEqual(sessionsInLane(sessions, undefined).map((session) => session.id), ["ord"]);
  assert.deepEqual(sessionsInLane(sessions, "notes").map((session) => session.id), ["noted"]);
  assert.deepEqual(sessionsInLane(sessions, undefined, new Set(["playground"])).map((session) => session.id), ["ord"]);
});

test("a purpose whose owning package is gone never falls back into the Conversation lane", () => {
  // Disabling Creative Studio unregisters its profile, so "creative-studio"
  // leaves the available set. Its chats (and their delegated children) must
  // vanish from every list, not reappear as ordinary chats.
  const studio = [
    { id: "ord" },
    { id: "video", purpose: "creative-studio" },
    { id: "builder", parentId: "video" },
    { id: "plain", purpose: "notes" },
  ];
  const available = new Set<string>(); // package disabled: no purposes at all
  assert.deepEqual(sessionsInLane(studio, undefined, available).map((session) => session.id), ["ord"]);
  assert.deepEqual(sessionsInLane(studio, "creative-studio", available).map((session) => session.id), []);
  // A registered purpose lane keeps listing its own chats (children included).
  assert.deepEqual(sessionsInLane(studio, "notes", new Set(["notes"])).map((session) => session.id), ["plain"]);
});

test("sessions a package lists in its own UI stay out of the ordinary lists, children included", async () => {
  const claimed = new Set(["playground"]);
  assert.deepEqual(sessionsInLane(sessions, undefined, new Set(["notes"]), claimed).map((session) => session.id), ["ord"]);
  assert.deepEqual(sessionsInLane(sessions, "playground", new Set(["playground"]), claimed).map((session) => session.id), ["play", "child", "grand"], "the owning lane still lists them");
  const { claimSessionListing, claimedListingPurposes } = await import("../src/sessionListing.ts");
  const first = claimSessionListing("agent");
  const second = claimSessionListing("agent");
  first();
  first();
  assert.ok(claimedListingPurposes().has("agent"), "one release never drops another registration's claim");
  second();
  assert.equal(claimedListingPurposes().has("agent"), false);
});

test("ordinary new-chat drafts keep the historical key; purpose lanes get their own", () => {
  assert.equal(newSessionLaneDraftId(undefined), undefined);
  assert.equal(newSessionLaneDraftId(""), undefined);
  assert.equal(newSessionLaneDraftId("playground"), "lane:playground");
});

test("composer and session creation pass the active lane purpose", async () => {
  const [composer, init, sidebar, list] = await Promise.all([
    readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/init.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/sidebar/SessionList.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(composer, /const lanePurpose = activeLanePurpose\(\)/);
  assert.match(composer, /startIsolatedSession\([\s\S]*purpose: lanePurpose/);
  assert.match(composer, /createSession\([\s\S]*purpose: lanePurpose/);
  assert.match(composer, /newSessionLaneDraftId\(lanePurpose\)/);
  assert.match(init, /purpose\?: string/);
  assert.match(init, /purpose: input\.purpose/);
  assert.match(init, /purpose: opts\.purpose/);
  assert.match(sidebar, /useLaneSessions\(/);
  assert.match(list, /useLaneSessions\(sessions\)/);
});

test("choosing a session routes its lane and unsent drafts stay separated", async () => {
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

  const store = await import("../src/store.ts");
  const { registerWorkbenchProfile } = await import("../src/workbench/profiles.ts");
  const { getActiveProfileId, rememberWorkbenchProfileSession, setWorkbenchProject } = await import("../src/workbench/store.ts");
  const { switchWorkbenchNavigation, laneSession } = await import("../src/workbench/profileNavigation.ts");
  const off = registerWorkbenchProfile({
    id: "lane-playground",
    label: "Playground",
    description: "",
    order: 1,
    defaultLayout: { surfaces: [{ surface: "session", region: "primary", active: true }] },
    presentation: { navigation: "primary" },
    sessionPurpose: "playground",
  });
  try {
    store.activateProject("p-lane");
    setWorkbenchProject("p-lane");
    const row = (id: string, extra: Record<string, unknown> = {}) => ({
      id, projectId: "p-lane", title: id, status: "idle" as const, createdAt: 1, updatedAt: 1, ...extra,
    });
    store.setSessions("p-lane", [
      row("ord"),
      row("play", { purpose: "playground" }),
      row("child", { parentId: "play" }),
    ]);
    store.activateSession("ord");
    assert.equal(getActiveProfileId(), "conversation");
    assert.equal(switchWorkbenchNavigation({ profileId: "lane-playground" }), true);
    assert.equal(getActiveProfileId(), "lane-playground");
    assert.notEqual(store.getState().activeSessionId, "ord");

    store.activateSession("play");
    assert.equal(getActiveProfileId(), "lane-playground");
    assert.equal(store.getState().activeSessionId, "play");
    store.activateSession("child");
    assert.equal(getActiveProfileId(), "lane-playground");
    store.activateSession("ord");
    assert.equal(getActiveProfileId(), "conversation");
    assert.equal(store.getState().activeSessionId, "ord");

    rememberWorkbenchProfileSession("lane-playground", null);
    rememberWorkbenchProfileSession("conversation", "play");
    assert.equal(laneSession("conversation"), null, "handoffs cannot target a stale foreign-lane chat");
    rememberWorkbenchProfileSession("conversation", null);
    store.startNewSession("p-lane", { draft: "ordinary hello" });
    assert.equal(switchWorkbenchNavigation({ profileId: "lane-playground" }), true);
    store.startNewSession("p-lane", { draft: "play hello" });
    assert.equal(switchWorkbenchNavigation("chat"), true);
    store.startNewSession("p-lane");
    assert.equal(store.getState().newSessionIntent?.draft, "ordinary hello");
    assert.equal(switchWorkbenchNavigation({ profileId: "lane-playground" }), true);
    store.startNewSession("p-lane");
    assert.equal(store.getState().newSessionIntent?.draft, "play hello");
  } finally {
    off();
  }
});

test("a marker purpose that names no lane keeps the session in its parent's lane", () => {
  // Workflow marks its run parent and every node child with `purpose:
  // "workflow"` for the navigator badge, without declaring a workbench lane.
  // That marker must not strand the run outside every list.
  const rows = [
    { id: "chat" },
    { id: "run", parentId: "chat", purpose: "workflow" },
    { id: "node", parentId: "run", purpose: "workflow" },
    { id: "solo", purpose: "workflow" },
  ];
  const namesALane = (purpose: string) => purpose !== "workflow";
  assert.deepEqual(lanePurposeOf(rows[1]!, new Map(rows.map((row) => [row.id, row])), namesALane), "");
  assert.deepEqual(
    sessionsInLane(rows, undefined, new Set(["playground"]), undefined, namesALane).map((session) => session.id),
    ["chat", "run", "node", "solo"],
  );
  assert.deepEqual(
    lanePurposeOf(
      { id: "studio-child", parentId: "studio", purpose: "workflow" },
      new Map([[ "studio", { id: "studio", purpose: "playground" } ]]),
      namesALane,
    ),
    "playground",
    "a marker child stays beside the package chat that started it",
  );
});

test("a marker purpose is still hidden when its workbench lane is unavailable", () => {
  // The default predicate treats every purpose as a lane: a package-lane chat
  // whose package is gone must stay out of the Conversation list.
  const rows = [{ id: "ord" }, { id: "video", purpose: "creative-studio" }, { id: "node", parentId: "video" }];
  assert.deepEqual(sessionsInLane(rows, undefined, new Set()).map((session) => session.id), ["ord"]);
});

test("a claimed listing purpose still leaves the ordinary list when it names no lane", () => {
  // Schedule claims the `agent` purpose as listed in its own UI without
  // declaring a workbench profile. The claim must keep filtering those chats
  // out of Conversation, while an unclaimed workflow marker must not.
  const rows = [
    { id: "ord" },
    { id: "agent", purpose: "agent" },
    { id: "run", parentId: "ord", purpose: "workflow" },
  ];
  const claimed = new Set(["agent"]);
  const routable = (purpose: string) => claimed.has(purpose) || purpose !== "workflow";
  assert.deepEqual(
    sessionsInLane(rows, undefined, new Set(), claimed, routable).map((session) => session.id),
    ["ord", "run"],
  );
});

test("a people-first conversation lists beside ordinary chats, never in a package lane", () => {
  const rows = [{ id: "ord" }, { id: "talk", purpose: "conversation" }, { id: "play", purpose: "playground" }];
  assert.deepEqual(sessionsInLane(rows, undefined, new Set(["playground"])).map((session) => session.id), ["ord", "talk"]);
  assert.deepEqual(sessionsInLane(rows, "playground", new Set(["playground"])).map((session) => session.id), ["play"]);
});
