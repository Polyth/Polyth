import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, { window: dom, localStorage: dom.localStorage });

const {
  getGitPrefs,
  getGitRemoteSelection,
  getGitViewState,
  setGitPrefs,
  setGitRemoteSelection,
  setGitViewState,
} = await import("../widgets/gitPrefs.ts");

test("Git preferences and review state remain isolated per repository scope", () => {
  const app = "project\0session\0app";
  const api = "project\0session\0api";
  setGitPrefs({ layout: "split", wrap: true }, app);
  setGitViewState(app, { selected: { path: "src/app.ts", staged: false }, closedGroups: ["unstaged"] });

  assert.equal(getGitPrefs(app).layout, "split");
  assert.equal(getGitPrefs(api).layout, "unified");
  assert.deepEqual(getGitViewState(app), { selected: { path: "src/app.ts", staged: false }, closedGroups: ["unstaged"] });
  assert.deepEqual(getGitViewState(api), { closedGroups: [] });

  setGitPrefs({ layout: "unified" }, api);
  setGitViewState(api, { selected: { path: "src/api.ts", staged: true }, closedGroups: [] });
  assert.equal(getGitPrefs(app).layout, "split");
  assert.equal(getGitViewState(app).selected?.path, "src/app.ts");

  setGitRemoteSelection("project", "session", "origin", "repo/with space");
  assert.equal(getGitRemoteSelection("project", "session", "repo/with space"), "origin");
  assert.ok([...Object.keys(localStorage)].some((key) => key.includes('"git-remote"') && key.endsWith(":repo%2Fwith%20space")));
});
