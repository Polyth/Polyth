// Second windows (secondWindow.ts): roles from the URL, the addresses the URL
// sync keeps, and the presence rules windows use to find each other.
import { test } from "node:test";
import assert from "node:assert/strict";

const mem = new Map<string, string>();
const memStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
(globalThis as { sessionStorage?: unknown }).sessionStorage = memStorage;
(globalThis as { localStorage?: unknown }).localStorage = memStorage;

const win = await import("../src/secondWindow.ts");
const {
  applyWindowMessage, chatWindowSessions, expirePeers, leadMainWindow, parseWindowRole, parseWindowSurface,
  secondWindowName, secondWindowUrl, withWindowRole,
} = win;

type Presence = import("../src/secondWindow.ts").WindowPresence;
const presence = (patch: Partial<Presence> & { id: string }): Presence => ({
  role: "main", projectId: null, sessionId: null, pinned: false, focusedAt: 0, ...patch,
});

test("a URL names a chat or pane window; anything else is the main window", () => {
  assert.equal(parseWindowRole("?window=chat"), "chat");
  assert.equal(parseWindowRole("window=pane&surface=files"), "pane");
  assert.equal(parseWindowRole("?window=settings"), null);
  assert.equal(parseWindowRole(""), null);
  assert.equal(parseWindowSurface("?window=pane&surface=files"), "files");
  assert.equal(parseWindowSurface("?surface=../../etc"), null, "surface ids are bounded");
  assert.equal(win.windowRole(), "main", "a test document is a main window");
  assert.equal(win.isSecondaryWindow(), false);
});

test("second-window addresses keep the canonical chat URL and add the role", () => {
  assert.equal(secondWindowUrl("chat", "p 1", "s1"), "/p/p%201/s/s1?window=chat");
  assert.equal(secondWindowUrl("pane", "p1", null, "files"), "/p/p1?window=pane&surface=files");
  assert.equal(secondWindowUrl("chat", null, "s1"), "/?session=s1&window=chat");
  assert.equal(secondWindowUrl("pane", "p1", "s1", "../x"), "/p/p1/s/s1?window=pane", "an unsafe surface is dropped");
  assert.equal(secondWindowName("chat", "s1"), "polyth-chat-s1");
  assert.equal(secondWindowName("pane", "s1"), "polyth-pane", "one pane window, reused");
  // The URL sync of a second window keeps its role; a main window's is untouched.
  assert.equal(withWindowRole("/p/p1/s/s2", "pane", "git"), "/p/p1/s/s2?window=pane&surface=git");
  assert.equal(withWindowRole("/p/p1/s/s2", "chat", null), "/p/p1/s/s2?window=chat");
  assert.equal(withWindowRole("/p/p1", "main", null), "/p/p1");
});

test("presence: peers come and go, stale ones expire, and self is ignored", () => {
  let peers: ReturnType<typeof applyWindowMessage> = new Map();
  peers = applyWindowMessage(peers, { t: "presence", window: presence({ id: "self" }) }, 1, "self");
  assert.equal(peers.size, 0, "a window never lists itself");
  peers = applyWindowMessage(peers, { t: "presence", window: presence({ id: "chat-1", role: "chat", sessionId: "s1" }) }, 1, "self");
  peers = applyWindowMessage(peers, { t: "presence", window: presence({ id: "chat-2", role: "chat", sessionId: "s2" }) }, 30_000, "self");
  assert.deepEqual([...chatWindowSessions(peers)].sort(), ["s1", "s2"]);
  const expired = expirePeers(peers, 50_000, 40_000);
  assert.deepEqual([...expired.keys()], ["chat-2"], "a window not heard from for 40 s stops counting");
  assert.equal(expirePeers(expired, 50_000, 40_000), expired, "nothing to drop keeps identity");
  const gone = applyWindowMessage(expired, { t: "gone", id: "chat-2" }, 50_000, "self");
  assert.equal(gone.size, 0);
  assert.equal(applyWindowMessage(gone, { t: "gone", id: "unknown" }, 1, "self"), gone);
});

test("a pane window follows the main window focused last", () => {
  const peers = new Map([
    ["a", { presence: presence({ id: "a", sessionId: "s-a", focusedAt: 10 }), seenAt: 1 }],
    ["b", { presence: presence({ id: "b", sessionId: "s-b", focusedAt: 20 }), seenAt: 1 }],
    ["c", { presence: presence({ id: "c", role: "chat", sessionId: "s-c", focusedAt: 99 }), seenAt: 1 }],
  ]);
  assert.equal(leadMainWindow(peers)?.id, "b", "chat windows are never followed");
  assert.equal(leadMainWindow(new Map()), null);
  assert.equal(leadMainWindow(new Map(), presence({ id: "me", focusedAt: 1 }))?.id, "me");
});

test("presence updates announce only real changes", () => {
  let calls = 0;
  const stop = win.subscribeWindowPresence(() => { calls += 1; });
  win.updateWindowPresence({ projectId: "p1", sessionId: "s1" });
  win.updateWindowPresence({ projectId: "p1", sessionId: "s1" });
  assert.equal(calls, 1);
  assert.equal(win.getSelfPresence().sessionId, "s1");
  assert.equal(win.returnToMainWindow(), false, "a main window hands nothing back");
  stop();
});

test("a pane window opened for one resource has its own address, name and title", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assert.equal(win.parseWindowResource(`?window=pane&surface=page-apps&resource=${id}`), id);
  assert.equal(win.parseWindowResource("?window=pane&surface=page-apps&resource=a%20b"), null, "an id, never free text");
  assert.equal(win.parseWindowResource("?window=pane&surface=page-apps"), null);
  assert.equal(
    secondWindowUrl("pane", "p1", null, "page-apps", id),
    `${secondWindowUrl("pane", "p1", null, "page-apps")}&resource=${id}`,
  );
  assert.equal(secondWindowUrl("pane", "p1", null, "page-apps", "a b"), secondWindowUrl("pane", "p1", null, "page-apps"), "a bad resource is dropped");
  assert.equal(secondWindowUrl("chat", "p1", "s1", "page-apps", id), secondWindowUrl("chat", "p1", "s1"), "only a pane window carries one");
  assert.equal(secondWindowName("pane", null, "page-apps", id), `polyth-pane-page-apps-${id}`);
  assert.notEqual(secondWindowName("pane", null, "page-apps", id), secondWindowName("pane", null, "files"), "beside the code window, not in its place");
  assert.equal(withWindowRole("/p/p1", "pane", "page-apps", id), `/p/p1?window=pane&surface=page-apps&resource=${id}`);
  assert.equal(withWindowRole("/p/p1", "pane", "git", null), "/p/p1?window=pane&surface=git");

  win.setWindowRoleForTest("pane", "page-apps", id);
  try {
    assert.equal(win.windowResource(), id);
    win.setWindowContentTitle("  Budget\n2026  ");
    assert.equal(win.windowContentTitle(), "Budget 2026");
    win.setWindowContentTitle(null);
    assert.equal(win.windowContentTitle(), null);
    // Showing another surface makes it an ordinary pane window again.
    win.setWindowContentTitle("Budget");
    win.setWindowSurface("files");
    assert.equal(win.windowResource(), null);
    assert.equal(win.windowContentTitle(), null);
    win.setWindowRoleForTest("pane", "files");
    win.setWindowContentTitle("Budget");
    assert.equal(win.windowContentTitle(), null, "only a resource window is named by its content");
    win.setWindowRoleForTest("main", null, id);
    assert.equal(win.windowResource(), null, "the main window has no resource");
  } finally {
    win.setWindowRoleForTest("main");
  }
});
