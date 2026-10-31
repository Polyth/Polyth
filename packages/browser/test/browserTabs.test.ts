import test from "node:test";
import assert from "node:assert/strict";
import type { BrowserSessionDto } from "@polyth/contracts";
import { sessionBrowserTabs, selectBrowserTab, recalledBrowserTab, rememberBrowserTab } from "../widgets/browserTabs.ts";
import { setClientReliabilityContext, workspacePresentationKey } from "../../../apps/web/src/reliabilityContext.ts";

const presentationKey = (projectId: string, sessionId: string | null) => workspacePresentationKey("browser.tab", projectId, sessionId);

const tab = (id: string, projectId: string, sessionId?: string, status: BrowserSessionDto["status"] = "ready"): BrowserSessionDto => ({
  id, projectId, sessionId, status, url: "https://example.com/", title: id,
  viewport: { width: 1280, height: 800, deviceScaleFactor: 1 }, colorScheme: "no-preference", revision: 1, engine: "fake",
});

test("tabs remain in their canonical session, including a fresh unsaved chat", () => {
  const tabs = [tab("a", "p", "one"), tab("b", "p", "two"), tab("c", "foreign", "one"), tab("fresh", "p"), tab("closed", "p", "one", "closed"), tab("a2", "p", "one")];
  assert.deepEqual(sessionBrowserTabs(tabs, "p", "one").map((t) => t.id), ["a", "a2"]);
  assert.deepEqual(sessionBrowserTabs(tabs, "p", null).map((t) => t.id), ["fresh"]);
  assert.equal(selectBrowserTab(sessionBrowserTabs(tabs, "p", "one"), "b")?.id, "a");
  assert.equal(selectBrowserTab(sessionBrowserTabs(tabs, "p", "one"), "a2")?.id, "a2");
  assert.equal(selectBrowserTab([], "a"), null);
});

test("remembered tab selection is scoped and stale selection falls back safely", () => {
  const values = new Map<string, string>();
  Object.assign(globalThis, { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  try {
    setClientReliabilityContext({ connectionScope: "browser-origin", spaceId: "space-one" });
    rememberBrowserTab(presentationKey("p", "one"), "a2");
    rememberBrowserTab(presentationKey("p", "two"), "b");
    assert.equal(recalledBrowserTab(presentationKey("p", "one")), "a2");
    assert.equal(recalledBrowserTab(presentationKey("other", "one")), null);
    assert.equal(selectBrowserTab([tab("a", "p", "one")], recalledBrowserTab(presentationKey("p", "one")))?.id, "a");
    setClientReliabilityContext({ connectionScope: "browser-origin", spaceId: "valid-foreign-space" });
    assert.equal(recalledBrowserTab(presentationKey("p", "one")), null);
    rememberBrowserTab(presentationKey("p", "one"), "foreign-tab");
    values.set("polyth.activeAccount", "usr_reviewer");
    assert.equal(recalledBrowserTab(presentationKey("p", "one")), null);
    values.delete("polyth.activeAccount");
    setClientReliabilityContext({ connectionScope: "browser-origin", spaceId: "space-one" });
    assert.equal(recalledBrowserTab(presentationKey("p", "one")), "a2");
    rememberBrowserTab(presentationKey("p", "one"), null);
    assert.equal(recalledBrowserTab(presentationKey("p", "one")), null);
  } finally {
    setClientReliabilityContext({ connectionScope: "browser-origin", spaceId: "default" });
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
