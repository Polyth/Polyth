import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteRequest, SpaceContext } from "@polyth/contracts";
import { createSpaceStorage } from "@polyth/tenancy";
import { loadInlineAiSettings, saveInlineAiSettings } from "../src/inlineAi.ts";
import {
  DEFAULT_EXPLAIN_PROMPT,
  DEFAULT_FIX_PROMPT,
  substituteInlineAiPrompt,
} from "../src/inlineAiShared.ts";
import { inlineAiRoutes } from "../src/inlineAiRoutes.ts";
import { FILES_REMOTE_ACCESS } from "../src/serverEntry.ts";

test("prompt substitution replaces placeholders", () => {
  const out = substituteInlineAiPrompt("{{path}} / {{language}}\n{{selection}}", {
    path: "a.ts",
    language: "typescript",
    selection: "const x = 1",
  });
  assert.match(out, /a\.ts/);
  assert.match(out, /typescript/);
  assert.match(out, /const x = 1/);
});

test("settings round-trip in Space storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "files-inline-ai-"));
  const storage = createSpaceStorage(root);
  const saved = await saveInlineAiSettings(storage, {
    explainPrompt: "Explain {{selection}}",
    fixPrompt: "Fix {{selection}}",
    modelOverride: "openai/gpt-test",
  });
  assert.equal(saved.explainPrompt, "Explain {{selection}}");
  const loaded = await loadInlineAiSettings(storage);
  assert.equal(loaded.modelOverride, "openai/gpt-test");
});

test("inline-ai routes reject foreign project with not-found", async () => {
  const ownerRoot = mkdtempSync(join(tmpdir(), "files-ai-owner-"));
  const foreignRoot = mkdtempSync(join(tmpdir(), "files-ai-foreign-"));
  const owner: SpaceContext = {
    spaceId: "spc_owner",
    spaceSlug: "owner",
    userId: "usr_owner",
    role: "owner",
    deployment: "local-trusted",
    storageDir: ownerRoot,
  };
  const foreign: SpaceContext = {
    spaceId: "spc_foreign",
    spaceSlug: "foreign",
    userId: "usr_foreign",
    role: "owner",
    deployment: "local-trusted",
    storageDir: foreignRoot,
  };
  let completeCalls = 0;
  const host = {
    spaceStorage: (space: SpaceContext) => createSpaceStorage(space.storageDir),
    projects: {
      get: async (id: string) => (id === "proj_owner"
        ? { id, path: "/repo", spaceId: owner.spaceId, name: "repo" }
        : id === "proj_foreign"
          ? { id, path: "/other", spaceId: foreign.spaceId, name: "other" }
          : undefined),
    },
    sessions: {
      snapshot: async () => ({ spaceId: owner.spaceId, projectId: "proj_owner" }),
    },
    smallModel: () => ({ providerID: "openai", modelID: "test" }),
    smallModelComplete: async () => {
      completeCalls++;
      return { text: "ok" };
    },
    runtimes: { forProject: async () => ({}) },
  };
  const route = inlineAiRoutes(host, { projects: host.projects, sessions: host.sessions });
  const invoke = async (space: SpaceContext, body: Record<string, unknown>) => {
    let status = 0;
    let payload: unknown;
    const handled = await route({
      path: "/api/files/inline-ai",
      method: "POST",
      space,
      url: new URL("https://polyth.test/api/files/inline-ai"),
      body: async () => body,
      json: (code: number, p: unknown) => { status = code; payload = p; },
    } as unknown as RouteRequest);
    return { handled, status, payload };
  };

  const ok = await invoke(owner, {
    action: "explain",
    projectId: "proj_owner",
    path: "a.ts",
    selection: "code",
  });
  assert.equal(ok.status, 200);
  assert.equal((ok.payload as { text: string }).text, "ok");
  assert.equal(completeCalls, 1);

  let foreignFailed = false;
  try {
    await invoke(foreign, {
      action: "explain",
      projectId: "proj_owner",
      path: "a.ts",
      selection: "code",
    });
  } catch (err) {
    foreignFailed = (err as { code?: string }).code === "not-found";
  }
  assert.equal(foreignFailed, true);
  assert.equal(completeCalls, 1);
});

test("remote policy lists write but not inline-ai spend routes", () => {
  assert.ok(FILES_REMOTE_ACCESS.http.some((r) => r.path === "/api/files/write"));
  assert.equal(
    FILES_REMOTE_ACCESS.http.some((r) => r.path.startsWith("/api/files/inline-ai")),
    false,
  );
});

test("defaults match product prompts", () => {
  assert.match(DEFAULT_EXPLAIN_PROMPT, /\{\{selection\}\}/);
  assert.match(DEFAULT_FIX_PROMPT, /\{\{selection\}\}/);
});
