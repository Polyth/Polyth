import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readlinkSync, writeFileSync, existsSync, rmSync, mkdirSync, symlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { materializeCompositeWorkspace } from "../src/compositeWorkspace.ts";

function storage(root: string) {
  return { root, packageDir: (id: string) => join(root, "packages", id), path: (relative: string) => {
    if (relative.includes("..")) throw Object.assign(new Error("escape"), { code: "invalid-path" });
    return join(root, relative);
  } };
}

test("composite workspace creates sanitized collision-safe links and cleans only owned links", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-terminal-composite-"));
  const app = join(root, "app"); const api = join(root, "api"); mkdirSync(app); mkdirSync(api);
  const space = join(root, "space"); mkdirSync(space);
  const composite = await materializeCompositeWorkspace({ storage: storage(space), workspace: { projectId: "p", sessionId: "s", repositories: [{ repositoryId: "a", alias: "same/name", path: app, state: "ready" }, { repositoryId: "b", alias: "same/name", path: api, state: "ready" }] }, projectId: "p", sessionId: "s", ownerId: "terminal-1", revision: 3 });
  const links = composite.repositoryIds.map((_, index) => index === 0 ? "same-name" : "same-name-b");
  assert.equal(readlinkSync(join(composite.root, links[0]!)), app);
  assert.equal(readlinkSync(join(composite.root, links[1]!)), api);
  writeFileSync(join(composite.root, "user-file"), "keep");
  await composite.cleanup();
  assert.equal(existsSync(join(composite.root, "user-file")), true);
  rmSync(root, { recursive: true, force: true });
});

test("composite workspace rejects missing or non-directory repository roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-terminal-composite-"));
  await assert.rejects(() => materializeCompositeWorkspace({ storage: storage(root), workspace: { projectId: "p", sessionId: null, repositories: [{ repositoryId: "missing", alias: "Missing", path: join(root, "gone"), state: "ready" }] }, projectId: "p" }), { code: "not-found" });
  rmSync(root, { recursive: true, force: true });
});

test("composite cleanup ignores manifest traversal and mismatched symlink ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-terminal-composite-"));
  const app = join(root, "app"); mkdirSync(app);
  const space = join(root, "space"); mkdirSync(space);
  const composite = await materializeCompositeWorkspace({ storage: storage(space), workspace: { projectId: "p", sessionId: "s", repositories: [{ repositoryId: "a", alias: "app", path: app, state: "ready" }] }, projectId: "p", sessionId: "s", ownerId: "terminal-1", revision: 1 });
  const outside = join(space, "outside-link");
  symlinkSync(app, outside, "dir");
  writeFileSync(join(composite.root, ".polyth-terminal-workspace.json"), JSON.stringify({ version: 1, links: { "../outside-link": app, app: join(root, "another-target") } }));
  await composite.cleanup();
  assert.equal(existsSync(outside), true, "manifest traversal must not remove a sibling link");
  assert.equal(existsSync(join(composite.root, "app")), false, "trusted ownership removes the unchanged owned link despite manifest tampering");
  rmSync(root, { recursive: true, force: true });
});

test("composite cleanup refuses a replaced root directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-terminal-composite-"));
  const app = join(root, "app"); mkdirSync(app);
  const space = join(root, "space"); mkdirSync(space);
  const composite = await materializeCompositeWorkspace({ storage: storage(space), workspace: { projectId: "p", sessionId: "s", repositories: [{ repositoryId: "a", alias: "app", path: app, state: "ready" }] }, projectId: "p", sessionId: "s", ownerId: "terminal-1", revision: 2 });
  const moved = `${composite.root}-moved`;
  const foreign = join(root, "foreign"); mkdirSync(foreign); writeFileSync(join(foreign, "keep"), "owned by someone else");
  renameSync(composite.root, moved);
  symlinkSync(foreign, composite.root, "dir");
  await composite.cleanup();
  assert.equal(readlinkSync(composite.root), foreign);
  assert.equal(existsSync(join(foreign, "keep")), true);
  assert.equal(existsSync(join(moved, "app")), true);
  rmSync(root, { recursive: true, force: true });
});
