// A launch paints the navigator it last showed while the boot list is out; the
// server's answer then publishes over it, and remembered rows it no longer
// names leave — unless something newer named them or the person has them open.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { Project, SessionProjection } from "@polyth/contracts";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage as unknown as Storage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  location: dom.location,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
globalThis.fetch = async () => new Response("{}", { status: 404 });

const store = await import("../src/store.ts");
const boot = await import("../src/navigatorSnapshotBoot.ts");
const { encodeNavigatorSnapshot, writeNavigatorSnapshot, readNavigatorSnapshot } = await import("../src/navigatorSnapshot.ts");
const { clientAccountPersistenceScope } = await import("../src/reliabilityContext.ts");

const project = (id: string): Project => ({ id, path: `/work/${id}`, name: id, createdAt: 1 });
const row = (id: string, updatedAt: number, extra: Partial<SessionProjection> = {}): SessionProjection => ({
  id, projectId: "p1", title: `Chat ${id}`, status: "idle", createdAt: 1, updatedAt, summary: true, ...extra,
} as SessionProjection);

function remember(sessions: SessionProjection[], projects = [project("p1"), project("p2")], branch: { scope: string; label: string } | null = null): void {
  const encoded = encodeNavigatorSnapshot({ savedAt: 1, spaceId: "default", projects, projectId: "p1", sessions, branch });
  writeNavigatorSnapshot(clientAccountPersistenceScope(), encoded!);
}

test("a deep link the snapshot does not know waits for the server", async () => {
  remember([row("known", 1)]);
  store.beginProjectListRequest();
  window.history.replaceState(null, "", "/p/unknown-project");
  try {
    assert.equal(await boot.paintNavigatorSnapshot(), false);
    assert.equal(store.getState().projectRegistry.status, "loading");
  } finally {
    window.history.replaceState(null, "", "/");
  }
});

test("the remembered navigator paints under the boot request, and the answer replaces it", async () => {
  remember([row("kept", 40), row("ghost", 30), row("renamed", 20), row("open", 10)], undefined, { scope: "", label: "devel" });
  const ticket = store.beginProjectListRequest();
  assert.equal(store.getState().projectRegistry.status, "loading");
  // What a project activation would read the moment the list is adopted.
  const seenAtAdoption: Array<{ rows: number; label: string | null }> = [];
  const stop = store.subscribeStore(() => {
    if (store.getState().projectRegistry.status !== "ready" || seenAtAdoption.length > 0) return;
    seenAtAdoption.push({
      rows: store.getState().sessions.filter((session) => session.projectId === "p1").length,
      label: boot.rememberedBranchLabel("p1", ""),
    });
  });
  assert.equal(await boot.paintNavigatorSnapshot(), true);
  stop();
  assert.deepEqual(seenAtAdoption, [{ rows: 4, label: "devel" }], "rows and label are in place before the list is");
  const registry = store.getState().projectRegistry;
  assert.equal(registry.status, "ready");
  assert.deepEqual(registry.projects.map((entry) => entry.id), ["p1", "p2"]);
  assert.deepEqual(store.getState().sessions.map((session) => session.id).sort(), ["ghost", "kept", "open", "renamed"]);
  assert.equal(await boot.paintNavigatorSnapshot(), false, "one paint per document");

  // The socket named one row meanwhile: it is current, whatever the list says.
  store.upsertSessions([row("renamed", 21, { title: "Renamed live" })]);
  store.activateSession("open");
  assert.equal(store.publishProjectList(ticket, [project("p1")]), "published", "the boot answer still owns publication");
  const answered = store.getState().projectRegistry;
  assert.equal(answered.status === "ready" && answered.provisional, undefined);

  assert.equal(boot.rememberedBranchLabel("p1", "/work/p1/.worktrees/other"), null, "another checkout does not borrow it");
  assert.equal(boot.rememberedBranchLabel("p1", ""), "devel", "the primary checkout's label shows before git answers");
  assert.equal(boot.rememberedBranchLabel("p1", ""), "devel", "every read of that checkout before git answers sees it");
  boot.forgetRememberedBranch("p1", "");
  assert.equal(boot.rememberedBranchLabel("p1", ""), null, "once git answered, the read owns the label");

  boot.retireProvisionalRows("p2", new Set());
  assert.equal(store.getState().sessions.length, 4, "another project's answer retires nothing here");
  boot.retireProvisionalRows("p1", new Set(["kept"]));
  const ids = store.getState().sessions.map((session) => session.id).sort();
  assert.deepEqual(ids, ["kept", "open", "renamed"], "only the row nothing named since, and not the open chat, retires");
  store.activateSession(null);
  for (const id of ids) store.removeSession(id);
});

test("what the navigator shows is saved only after the server answered, on leaving the page at once", async () => {
  boot.resetNavigatorSnapshotBootForTest();
  localStorage.clear();
  let owner: { projectId: string; scope: string } | null = null;
  boot.watchNavigatorSnapshot(() => owner);
  const ticket = store.beginProjectListRequest();
  store.publishProjectList(ticket, [project("saved-project")]);
  store.activateProject("saved-project");
  store.upsertSessions([row("fresh", 50, { projectId: "saved-project", summary: undefined, draft: "secret" } as Partial<SessionProjection>)]);
  window.dispatchEvent(new Event("pagehide"));
  assert.equal(await readNavigatorSnapshot(clientAccountPersistenceScope()), null, "no answer yet: nothing is saved");

  boot.markProjectListAnswered();
  store.upsertSessions([row("fresh", 51, { projectId: "saved-project" })]);
  store.setGitBranch("feature/x");
  window.dispatchEvent(new Event("pagehide"));
  assert.equal((await readNavigatorSnapshot(clientAccountPersistenceScope()))?.branch, null,
    "a label no git read vouched for is not kept");
  owner = { projectId: "saved-project", scope: "" };
  store.setGitBranch("feature/y");
  store.setGitBranch("feature/x");
  window.dispatchEvent(new Event("pagehide"));
  const saved = await readNavigatorSnapshot(clientAccountPersistenceScope());
  assert.ok(saved);
  assert.deepEqual(saved.projects.map((entry) => entry.id), ["saved-project"]);
  assert.equal(saved.projectId, "saved-project");
  assert.deepEqual(saved.sessions.map((session) => session.id), ["fresh"]);
  assert.equal("draft" in saved.sessions[0]!, false);
  assert.deepEqual(saved.branch, { scope: "", label: "feature/x" });
});
