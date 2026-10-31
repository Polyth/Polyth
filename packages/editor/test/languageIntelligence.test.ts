import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EditorLanguageWorkspace } from "../src/languageService.ts";
import registerEditorPackage from "../src/serverEntry.ts";

async function fixture(): Promise<{ root: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "polyth-editor-intel-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", baseUrl: ".", paths: { "@/*": ["src/*"] } },
  }), "utf8");
  await writeFile(join(root, "src", "obj.ts"), "export const user = { id: 1, name: 'Alice' };\n", "utf8");
  await writeFile(join(root, "src", "funcs.ts"), `/**
 * Calculate the total cost.
 * @param price Unit price in cents
 * @param quantity Number of units
 */
export function calculateTotal(price: number, quantity: number): number {
  return price * quantity;
}
`, "utf8");
  await writeFile(join(root, "src", "clean.ts"), "export const ok = 100;\n", "utf8");
  await writeFile(join(root, "src", "error.ts"), "const count: number = 'not a number';\n", "utf8");
  await writeFile(join(root, "src", "data.json"), '{"key": "value"}\n', "utf8");
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function routeRequest(body: Record<string, unknown>, spaceId = "space-a") {
  let result: { code: number; body: unknown } | undefined;
  return {
    request: {
      path: "/api/editor/language",
      method: "POST",
      url: new URL("http://localhost/api/editor/language"),
      space: { spaceId, spaceSlug: spaceId, userId: "user-a", role: "owner", deployment: "local-trusted", storageDir: "/tmp" },
      body: async () => body,
      json: (code: number, value: unknown) => { result = { code, body: value }; },
    } as never,
    result: () => result,
  };
}

type RouteWithDispose = { dispose?: () => void | Promise<void> };

test("member completion lists object properties with kinds", async () => {
  const item = await fixture();
  try {
    await writeFile(join(item.root, "src", "member.ts"), "import { user } from './obj.js';\nuser.\n", "utf8");
    const workspace = await EditorLanguageWorkspace.open({
      spaceId: "space-a", projectId: "project-a", sessionId: null, repositoryId: "web", root: item.root,
    });
    const result = await workspace.completion("src/member.ts", { line: 1, character: 5 });
    assert.ok(result);
    assert.deepEqual(result.from, { line: 1, character: 5 });
    const idItem = result.items.find((entry) => entry.label === "id");
    const nameItem = result.items.find((entry) => entry.label === "name");
    assert.ok(idItem);
    assert.equal(idItem.kind, "property");
    assert.ok(nameItem);
    assert.equal(nameItem.kind, "property");
    workspace.dispose();
  } finally {
    await item.cleanup();
  }
});

test("identifier prefix completion resolves with the right from position", async () => {
  const item = await fixture();
  try {
    await writeFile(join(item.root, "src", "prefix.ts"), "function calculateTotal(price: number): number { return price; }\ncalc\n", "utf8");
    const workspace = await EditorLanguageWorkspace.open({
      spaceId: "space-a", projectId: "project-a", sessionId: null, repositoryId: "web", root: item.root,
    });
    const result = await workspace.completion("src/prefix.ts", { line: 1, character: 4 });
    assert.ok(result);
    assert.deepEqual(result.from, { line: 1, character: 0 });
    const match = result.items.find((entry) => entry.label === "calculateTotal");
    assert.ok(match);
    assert.equal(match.kind, "function");
    workspace.dispose();
  } finally {
    await item.cleanup();
  }
});

test("hover on a function with a JSDoc comment displays signature and documentation", async () => {
  const item = await fixture();
  try {
    await writeFile(join(item.root, "src", "call.ts"), "import { calculateTotal } from './funcs.js';\ncalculateTotal(10, 2);\n", "utf8");
    const workspace = await EditorLanguageWorkspace.open({
      spaceId: "space-a", projectId: "project-a", sessionId: null, repositoryId: "web", root: item.root,
    });
    const hover = await workspace.hover("src/call.ts", { line: 1, character: 5 });
    assert.ok(hover);
    assert.match(hover.display, /calculateTotal/);
    assert.match(hover.display, /price:\s*number/);
    assert.match(hover.display, /quantity:\s*number/);
    assert.ok(hover.documentation);
    assert.match(hover.documentation, /Calculate the total cost\./);
    assert.match(hover.documentation, /@param price Unit price in cents/);
    assert.match(hover.documentation, /@param quantity Number of units/);
    assert.deepEqual(hover.range, {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 14 },
    });
    workspace.dispose();
  } finally {
    await item.cleanup();
  }
});

test("type error produces one error diagnostic with the right range and message, while clean file gives []", async () => {
  const item = await fixture();
  try {
    const workspace = await EditorLanguageWorkspace.open({
      spaceId: "space-a", projectId: "project-a", sessionId: null, repositoryId: "web", root: item.root,
    });
    const cleanDiag = await workspace.diagnostics("src/clean.ts");
    assert.deepEqual(cleanDiag, []);

    const errorDiag = await workspace.diagnostics("src/error.ts");
    assert.ok(errorDiag.length >= 1);
    const err = errorDiag.find((d) => d.severity === "error");
    assert.ok(err);
    assert.equal(err.severity, "error");
    assert.match(err.message, /not assignable to type/);
    assert.equal(err.range.start.line, 0);
    assert.equal(err.code, 2322);
    workspace.dispose();
  } finally {
    await item.cleanup();
  }
});

test("live overlay is what gets analysed for completion, hover, and diagnostics", async () => {
  const item = await fixture();
  try {
    const workspace = await EditorLanguageWorkspace.open({
      spaceId: "space-a", projectId: "project-a", sessionId: null, repositoryId: "web", root: item.root,
    });
    // On disk, src/clean.ts is clean. With overlay containing a type error, diagnostics must report it.
    const brokenOverlay = "export const ok: number = 'broken';\n";
    const diagWithOverlay = await workspace.diagnostics("src/clean.ts", { content: brokenOverlay });
    assert.ok(diagWithOverlay.some((d) => d.severity === "error" && /not assignable/.test(d.message)));
    // Without overlay, file remains clean.
    const diagAfter = await workspace.diagnostics("src/clean.ts");
    assert.deepEqual(diagAfter, []);

    // Completion with overlay
    const completionOverlay = "const overlaidVar = 42;\nover\n";
    const compWithOverlay = await workspace.completion("src/clean.ts", { line: 1, character: 4 }, { content: completionOverlay });
    assert.ok(compWithOverlay?.items.some((item) => item.label === "overlaidVar"));

    // Hover with overlay
    const hoverOverlay = "/**\n * Overlaid doc\n */\nfunction overlaidFn() {}\noverlaidFn();\n";
    const hoverWithOverlay = await workspace.hover("src/clean.ts", { line: 4, character: 2 }, { content: hoverOverlay });
    assert.ok(hoverWithOverlay);
    assert.match(hoverWithOverlay.documentation ?? "", /Overlaid doc/);

    workspace.dispose();
  } finally {
    await item.cleanup();
  }
});

test(".json file answers unavailable language for all capabilities", async () => {
  const item = await fixture();
  try {
    const project = {
      id: "project-a", name: "Project", path: item.root, createdAt: 0,
      repositories: [{ id: "web", alias: "Web", path: item.root }], primaryRepositoryId: "web",
    };
    const host = {
      forSpace: () => ({ projects: { get: async () => project }, sessions: { snapshot: async () => null } }),
    } as never;
    const pkg = registerEditorPackage(host);
    const route = pkg.routes!;

    for (const capability of ["completion", "hover", "diagnostics"] as const) {
      const req = routeRequest({
        projectId: "project-a",
        repositoryId: "web",
        path: "src/data.json",
        position: { line: 0, character: 0 },
        capability,
      });
      await route(req.request);
      assert.equal(req.result()?.code, 200);
      const body = req.result()?.body as { capability: string; unavailable?: string };
      assert.equal(body.capability, capability);
      assert.equal(body.unavailable, "language");
    }

    await (route as RouteWithDispose).dispose?.();
  } finally {
    await item.cleanup();
  }
});

test("route-level validation rejects missing path (400) and foreign session (404) for new capabilities", async () => {
  const item = await fixture();
  try {
    const project = {
      id: "project-a", name: "Project", path: item.root, createdAt: 0,
      repositories: [{ id: "web", alias: "Web", path: item.root }], primaryRepositoryId: "web",
    };
    const foreignSession = { id: "foreign-session", projectId: "other-project" };
    const host = {
      forSpace: () => ({
        projects: { get: async (id: string) => (id === "project-a" ? project : null) },
        sessions: { snapshot: async (id: string) => (id === "foreign-session" ? foreignSession : null) },
      }),
    } as never;
    const pkg = registerEditorPackage(host);
    const route = pkg.routes!;

    for (const capability of ["completion", "hover", "diagnostics"] as const) {
      // Missing path -> 400
      const missingPath = routeRequest({
        projectId: "project-a",
        repositoryId: "web",
        position: { line: 0, character: 0 },
        capability,
      });
      await route(missingPath.request);
      assert.equal(missingPath.result()?.code, 400);

      // Session from another project -> 404
      const foreignReq = routeRequest({
        projectId: "project-a",
        repositoryId: "web",
        sessionId: "foreign-session",
        path: "src/clean.ts",
        position: { line: 0, character: 0 },
        capability,
      });
      await route(foreignReq.request);
      assert.equal(foreignReq.result()?.code, 404);
      const foreignBody = foreignReq.result()?.body as { error: string };
      assert.match(foreignBody.error, /session not found in project/);
    }

    await (route as RouteWithDispose).dispose?.();
  } finally {
    await item.cleanup();
  }
});

test("clean fixture importing unresolvable package produces 0 diagnostics, while local type error produces 1", async () => {
  const item = await fixture();
  try {
    await writeFile(
      join(item.root, "src", "unresolved.ts"),
      'import { something } from "unresolvable-external-pkg";\nexport const x = 42;\n',
      "utf8",
    );
    const workspace = await EditorLanguageWorkspace.open({
      spaceId: "space-a", projectId: "project-a", sessionId: null, repositoryId: "web", root: item.root,
    });

    const cleanDiags = await workspace.diagnostics("src/unresolved.ts");
    assert.deepEqual(cleanDiags, []);

    const errorOverlay = 'import { something } from "unresolvable-external-pkg";\nexport const x: number = "bad";\n';
    const errorDiags = await workspace.diagnostics("src/unresolved.ts", { content: errorOverlay });
    assert.equal(errorDiags.length, 1);
    assert.equal(errorDiags[0]?.code, 2322);
    assert.equal(errorDiags[0]?.severity, "error");

    workspace.dispose();
  } finally {
    await item.cleanup();
  }
});

test("ensureSource bounds on-demand files to MAX_ON_DEMAND_FILES, evicting oldest on-demand entries without evicting scanned files", async () => {
  const item = await fixture();
  try {
    const workspace = await EditorLanguageWorkspace.open({
      spaceId: "space-a", projectId: "project-a", sessionId: null, repositoryId: "web", root: item.root,
    });
    // Verify scanned file exists
    assert.ok(workspace.source("src/clean.ts"));

    // Create 105 files on disk that were not in the initial scan
    await mkdir(join(item.root, "extra"));
    for (let i = 0; i < 105; i++) {
      await writeFile(join(item.root, "extra", `file${i}.ts`), `export const v${i} = ${i};\n`, "utf8");
    }

    // Load first 100 on-demand files
    for (let i = 0; i < 100; i++) {
      const s = await workspace.ensureSource(`extra/file${i}.ts`);
      assert.ok(s);
    }

    // All 100 are present
    assert.ok(workspace.source("extra/file0.ts"));
    assert.ok(workspace.source("extra/file99.ts"));

    // Load 101st file -> should evict extra/file0.ts (oldest on-demand)
    await workspace.ensureSource("extra/file100.ts");
    assert.equal(workspace.source("extra/file0.ts"), undefined);
    assert.ok(workspace.source("extra/file100.ts"));

    // Scanned file was never evicted
    assert.ok(workspace.source("src/clean.ts"));

    // Access extra/file1.ts to refresh its accessedAt
    await workspace.ensureSource("extra/file1.ts");

    // Load 102nd file -> should evict extra/file2.ts, NOT extra/file1.ts
    await workspace.ensureSource("extra/file101.ts");
    assert.ok(workspace.source("extra/file1.ts"));
    assert.equal(workspace.source("extra/file2.ts"), undefined);
    assert.ok(workspace.source("extra/file101.ts"));

    workspace.dispose();
  } finally {
    await item.cleanup();
  }
});

