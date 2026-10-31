import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentRevision, EditorLanguageWorkspace } from "../src/languageService.ts";
import registerEditorPackage from "../src/serverEntry.ts";
import type { EditorRenameTarget } from "../src/languageTypes.ts";

async function fixture(): Promise<{ root: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "polyth-editor-language-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", baseUrl: ".", paths: { "@/*": ["src/*"] } },
  }), "utf8");
  await writeFile(join(root, "src", "defs.ts"), "export const answer = 42;\n", "utf8");
  await writeFile(join(root, "src", "main.ts"), "import { answer } from '@/defs.js';\nexport const value = answer;\n", "utf8");
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("TypeScript definitions and references resolve across files", async () => {
  const item = await fixture();
  try {
    const workspace = await EditorLanguageWorkspace.open({
      spaceId: "space-a", projectId: "project-a", sessionId: "session-a", repositoryId: "web", root: item.root,
    });
    const definitions = await workspace.definitions("src/main.ts", { line: 1, character: 21 });
    assert.equal(definitions.definitions?.[0]?.path, "src/defs.ts");
    assert.equal(definitions.definitions?.[0]?.repositoryId, "web");
    const references = await workspace.references("src/defs.ts", { line: 0, character: 13 });
    assert.ok(references.references?.some((reference) => reference.path === "src/main.ts"));
    workspace.dispose();
  } finally {
    await item.cleanup();
  }
});

test("project path aliases participate in definition, reference, and rename resolution", async () => {
  const item = await fixture();
  try {
    const workspace = await EditorLanguageWorkspace.open({
      spaceId: "space-a", projectId: "project-a", sessionId: null, repositoryId: "web", root: item.root,
    });
    const definition = await workspace.definitions("src/main.ts", { line: 0, character: 10 });
    assert.equal(definition.definitions?.[0]?.path, "src/defs.ts");
    const references = await workspace.references("src/defs.ts", { line: 0, character: 13 });
    assert.ok(references.references?.some((reference) => reference.path === "src/main.ts"));
    const rename = await workspace.rename("src/defs.ts", { line: 0, character: 13 }, "answerValue");
    assert.ok(rename.rename?.targets.some((target) => target.path === "src/main.ts"));
    workspace.dispose();
  } finally {
    await item.cleanup();
  }
});

test("same path remains scoped to independent repositories and Spaces", async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    const left = await EditorLanguageWorkspace.open({
      spaceId: "space-a", projectId: "project-a", sessionId: "session-a", repositoryId: "web", root: first.root,
    });
    const right = await EditorLanguageWorkspace.open({
      spaceId: "space-b", projectId: "project-a", sessionId: "session-a", repositoryId: "api", root: second.root,
    });
    const [leftDef, rightDef] = await Promise.all([
      left.definitions("src/main.ts", { line: 1, character: 21 }),
      right.definitions("src/main.ts", { line: 1, character: 21 }),
    ]);
    assert.equal(leftDef.definitions?.[0]?.repositoryId, "web");
    assert.equal(rightDef.definitions?.[0]?.repositoryId, "api");
    assert.equal(left.scope.spaceId, "space-a");
    assert.equal(right.scope.spaceId, "space-b");
    left.dispose();
    right.dispose();
  } finally {
    await Promise.all([first.cleanup(), second.cleanup()]);
  }
});

test("rename targets carry revisions from the preflight snapshot", async () => {
  const item = await fixture();
  try {
    const workspace = await EditorLanguageWorkspace.open({
      spaceId: "space-a", projectId: "project-a", sessionId: null, repositoryId: "web", root: item.root,
    });
    const preview = await workspace.rename("src/defs.ts", { line: 0, character: 13 }, "result");
    const target = preview.rename?.targets.find((candidate) => candidate.path === "src/main.ts");
    assert.ok(target);
    await writeFile(join(item.root, "src", "main.ts"), "import { answer } from './defs.js';\nexport const changed = answer;\n", "utf8");
    await workspace.refresh();
    assert.notEqual(workspace.source("src/main.ts")?.revision, target.expectedRevision);
    assert.match(await readFile(join(item.root, "src", "main.ts"), "utf8"), /changed/);
    workspace.dispose();
  } finally {
    await item.cleanup();
  }
});

test("definitions and rename preview use the bounded current-document overlay", async () => {
  const item = await fixture();
  try {
    // The persisted file deliberately has no import or symbol at this point.
    await writeFile(join(item.root, "src", "main.ts"), "export const diskOnly = 1;\n", "utf8");
    const workspace = await EditorLanguageWorkspace.open({
      spaceId: "space-a", projectId: "project-a", sessionId: "session-a", repositoryId: "web", root: item.root,
    });
    const liveMain = "import { answer } from '@/defs.js';\nexport const live = answer;\n";
    const definition = await workspace.definitions("src/main.ts", { line: 1, character: 21 }, { content: liveMain });
    assert.equal(definition.definitions?.[0]?.path, "src/defs.ts");
    const liveDefs = "export const liveAnswer = 42;\n";
    const preview = await workspace.rename("src/defs.ts", { line: 0, character: 18 }, "result", {
      content: liveDefs,
      revision: contentRevision(liveDefs),
    });
    assert.equal(preview.rename?.oldName, "liveAnswer");
    assert.equal(preview.rename?.targets.find((target) => target.path === "src/defs.ts")?.expectedRevision, contentRevision(liveDefs));
    workspace.dispose();
  } finally {
    await item.cleanup();
  }
});

test("malformed or escaping tsconfig options fail closed without expanding the workspace", async () => {
  const item = await fixture();
  try {
    await writeFile(join(item.root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["../outside/*"] } } }), "utf8");
    const escaped = await EditorLanguageWorkspace.open({
      spaceId: "space-a", projectId: "project-a", sessionId: null, repositoryId: "web", root: item.root,
    });
    const escapedResult = await escaped.definitions("src/main.ts", { line: 0, character: 10 });
    assert.ok((escapedResult.definitions ?? []).every((definition) => definition.path.startsWith("src/")));
    escaped.dispose();
    await writeFile(join(item.root, "tsconfig.json"), "{ malformed", "utf8");
    const malformed = await EditorLanguageWorkspace.open({
      spaceId: "space-a", projectId: "project-a", sessionId: null, repositoryId: "web", root: item.root,
    });
    const malformedResult = await malformed.definitions("src/main.ts", { line: 0, character: 10 });
    assert.ok((malformedResult.definitions ?? []).every((definition) => definition.path.startsWith("src/")));
    malformed.dispose();
  } finally {
    await item.cleanup();
  }
});

function routeRequest(body: Record<string, unknown>, spaceId = "space-a") {
  let result: { code: number; body: unknown } | undefined;
  return {
    request: {
      path: "/api/editor/language/rename-apply",
      method: "POST",
      url: new URL("http://localhost/api/editor/language/rename-apply"),
      space: { spaceId, spaceSlug: spaceId, userId: "user-a", role: "owner", deployment: "local-trusted", storageDir: "/tmp" },
      body: async () => body,
      json: (code: number, value: unknown) => { result = { code, body: value }; },
    } as never,
    result: () => result,
  };
}

test("rename route preflights every target and rejects a foreign Space", async () => {
  const item = await fixture();
  try {
    const project = {
      id: "project-a", name: "Project", path: item.root, createdAt: 0,
      repositories: [{ id: "web", alias: "Web", path: item.root }], primaryRepositoryId: "web",
    };
    const host = {
      forSpace: (space: { spaceId: string }) => {
        if (space.spaceId !== "space-a") throw new Error("foreign Space");
        return { projects: { get: async () => project }, sessions: { snapshot: async () => { throw new Error("unexpected session"); } } };
      },
    } as never;
    const route = registerEditorPackage(host).routes!;
    // Ask for a preview first, then mutate one target before applying it.
    const previewResult = routeRequest({ projectId: "project-a", repositoryId: "web", path: "src/defs.ts", position: { line: 0, character: 13 }, newName: "result" });
    (previewResult.request as { path: string }).path = "/api/editor/language/rename-preview";
    await route(previewResult.request);
    const preview = previewResult.result()?.body as { rename?: { targets: unknown[] } };
    assert.ok(preview.rename?.targets.length);
    await writeFile(join(item.root, "src", "main.ts"), "import { answer } from './defs.js';\nexport const changed = answer;\n", "utf8");
    const applyRequest = routeRequest({
      projectId: "project-a", repositoryId: "web", newName: "result", targets: preview.rename.targets,
    });
    await route(applyRequest.request);
    assert.equal(applyRequest.result()?.code, 409);
    assert.match(await readFile(join(item.root, "src", "defs.ts"), "utf8"), /answer/);
    const foreign = routeRequest({ projectId: "project-a", repositoryId: "web", path: "src/main.ts", position: { line: 1, character: 21 }, capability: "definition" }, "space-b");
    (foreign.request as { path: string }).path = "/api/editor/language";
    await assert.rejects(() => route(foreign.request), /foreign Space/);
    await (route as RouteWithDispose).dispose?.();
  } finally {
    await item.cleanup();
  }
});

test("rename apply groups multiple occurrences in one file and rejects invalid ranges", async () => {
  const item = await fixture();
  try {
    await writeFile(join(item.root, "src", "defs.ts"), "export const answer = 42;\nexport const copy = answer;\n", "utf8");
    const project = { id: "project-a", name: "Project", path: item.root, createdAt: 0, repositories: [{ id: "web", alias: "Web", path: item.root }], primaryRepositoryId: "web" };
    const host = { forSpace: () => ({ projects: { get: async () => project }, sessions: { snapshot: async () => { throw new Error("unexpected session"); } } }) } as never;
    const route = registerEditorPackage(host).routes!;
    const previewResult = routeRequest({ projectId: "project-a", repositoryId: "web", path: "src/defs.ts", position: { line: 0, character: 13 }, newName: "result" });
    (previewResult.request as { path: string }).path = "/api/editor/language/rename-preview";
    await route(previewResult.request);
    const preview = previewResult.result()?.body as { rename?: { targets: EditorRenameTarget[] } };
    assert.ok((preview.rename?.targets ?? []).filter((target) => target.path === "src/defs.ts").length >= 2);
    const apply = routeRequest({ projectId: "project-a", repositoryId: "web", newName: "result", targets: preview.rename?.targets });
    await route(apply.request);
    assert.equal(apply.result()?.code, 200);
    assert.match(await readFile(join(item.root, "src", "defs.ts"), "utf8"), /export const copy = result/);
    const currentTargets = await Promise.all((preview.rename?.targets ?? []).map(async (target) => ({ ...target, expectedRevision: contentRevision(await readFile(join(item.root, target.path), "utf8")), range: { start: { line: 999, character: 0 }, end: { line: 999, character: 1 } } })));
    const invalid = routeRequest({ projectId: "project-a", repositoryId: "web", newName: "again", targets: currentTargets });
    await route(invalid.request);
    assert.equal(invalid.result()?.code, 400);
    await (route as RouteWithDispose).dispose?.();
  } finally {
    await item.cleanup();
  }
});

type RouteWithDispose = { dispose?: () => void | Promise<void> };


test("viewer rename and malformed session scope are rejected before workspace access", async () => {
  let accesses = 0;
  const packageEntry = registerEditorPackage({ forSpace: () => { accesses += 1; throw new Error("must not resolve"); } } as never);
  const viewer = routeRequest({ projectId: "p", repositoryId: "r", targets: [] });
  (viewer.request as { space: { role: string } }).space.role = "viewer";
  await packageEntry.routes!(viewer.request);
  assert.equal(viewer.result()?.code, 403);
  const invalid = routeRequest({ projectId: "p", repositoryId: "r", sessionId: 123, path: "a.ts", position: { line: 0, character: 0 }, capability: "definition" });
  (invalid.request as { path: string }).path = "/api/editor/language";
  await packageEntry.routes!(invalid.request);
  assert.equal(invalid.result()?.code, 400);
  assert.equal(accesses, 0);
  await packageEntry.onDisable?.();
});
