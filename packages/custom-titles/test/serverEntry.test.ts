import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { AgentRuntime, ModelDescriptor, RouteHandler, SessionEvent, SessionProjection, SpaceContext } from "@polyth/contracts";
import {
  SERVER_SESSION_TITLE_GENERATOR,
  type ServerPackageHost,
  type ServerSessionTitleGenerator,
} from "@polyth/plugins";
import registerPackage, { namingRequest } from "../src/serverEntry.ts";
import { DEFAULT_CUSTOM_TITLE_SETTINGS, type CustomTitleSettings } from "../src/settings.ts";
import { createCustomTitleSettingsStore } from "../src/settingsStore.ts";
import { httpErrorDiagnostics } from "../../server/src/errorDiagnostics.ts";

type CompletionOptions = Parameters<ServerPackageHost["smallModelComplete"]>[1];

const freeModel: ModelDescriptor = {
  providerID: "opencode", modelID: "ling-3.0-tiny-free", name: "Ling Tiny Free",
  capabilities: ["input:text", "output:text"],
};

function fixture(t: TestContext, stage?: "context" | "runtime" | "catalog" | "completion") {
  const scratch = resolve(import.meta.dirname, "../../../.scratch/custom-titles-tests");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const space = { spaceId: "space", storageDir: root } as SpaceContext;
  const spaceStorage = () => ({ path: (relative: string) => join(root, relative) }) as ReturnType<ServerPackageHost["spaceStorage"]>;
  const settings: CustomTitleSettings = {
    ...DEFAULT_CUSTOM_TITLE_SETTINGS,
    mode: "always",
    ...(stage === "runtime" ? {
      generator: { kind: "custom", harnessId: "codex", providerID: "openai", modelID: "title-model" },
    } : {}),
  };
  createCustomTitleSettingsStore(spaceStorage).save(space, settings, 0);
  const projections = new Map<string, SessionProjection>([
    ["session", { id: "session", projectId: "project", spaceId: "space", worktreePath: "/project-worktree", title: "Existing title", titleSource: "native", status: "idle", createdAt: 1, updatedAt: 1 }],
    ["foreign", { id: "foreign", projectId: "foreign-project", spaceId: "foreign-space", title: "Private title", status: "idle", createdAt: 1, updatedAt: 1 }],
  ]);
  let prompt = "Fix title generation";
  const renames: Array<{ sessionId: string; title: string }> = [];
  const snapshot = async (sessionId: string) => {
    const projection = projections.get(sessionId);
    if (!projection || projection.spaceId !== space.spaceId) throw Object.assign(new Error("session not found"), { code: "not-found" });
    return { ...projection };
  };
  let release!: () => void;
  const pending = new Promise<void>((resolvePending) => { release = resolvePending; });
  let reached = false;
  let calls = 0;
  let completion: CompletionOptions | undefined;
  const completions: CompletionOptions[] = [];
  const replies: Array<string | Error> = [];
  let completionError: unknown;
  let renameError: unknown;
  let failAfterRename = false;
  let projectAvailable = true;
  const acquisitions: Array<{ projectId: string; cwd: string; harnessId: string; sessionId?: string }> = [];
  const pause = async (current: typeof stage) => {
    if (stage !== current) return;
    reached = true;
    await pending;
  };
  const runtime = {
    harnessId: "opencode",
    models: async () => { await pause("catalog"); return [freeModel]; },
  } as AgentRuntime;
  let generator!: ServerSessionTitleGenerator;
  const host = {
    store: { projection: async (sessionId: string) => { await pause("context"); return projections.get(sessionId); } },
    projects: { get: async () => projectAvailable ? { id: "project", path: "/project", spaceId: space.spaceId } : undefined },
    systemSpaceContext: () => space,
    spaceStorage,
    forSpace(context: SpaceContext) {
      assert.equal(context, space);
      return { sessions: {
        snapshot,
        events: async (sessionId: string) => {
          await snapshot(sessionId);
          return [{ type: "user/message", data: { text: "  " } }, { type: "user/message", data: { text: prompt } }];
        },
        rename: async (sessionId: string, title: string) => {
          await snapshot(sessionId);
          if (renameError && !failAfterRename) throw renameError;
          renames.push({ sessionId, title });
          projections.set(sessionId, { ...projections.get(sessionId)!, title, titleSource: "manual" });
          if (renameError) throw renameError;
        },
      } };
    },
    services: {
      provide(key: typeof SERVER_SESSION_TITLE_GENERATOR, service: ServerSessionTitleGenerator) {
        assert.equal(key, SERVER_SESSION_TITLE_GENERATOR);
        generator = service;
      },
    },
    resolveSessionRuntime: async () => { throw new Error("the conversation harness is unavailable"); },
    runtimes: {
      forSession: async (projection: SessionProjection, cwd: string, harnessId: string) => {
        acquisitions.push({ projectId: projection.projectId, sessionId: projection.id, cwd, harnessId });
        await pause("runtime");
        return runtime;
      },
      forProject: async (projectId: string, cwd: string, harnessId: string) => {
        acquisitions.push({ projectId, cwd, harnessId });
        await pause("runtime");
        return runtime;
      },
    },
    smallModelComplete: async (_runtime: AgentRuntime, options: CompletionOptions) => {
      calls += 1;
      completion = options;
      completions.push(options);
      await pause("completion");
      if (completionError) throw completionError;
      const reply = replies.shift() ?? 'Title: "Fix custom title generation"';
      if (reply instanceof Error) throw reply;
      return { text: reply };
    },
  } as unknown as ServerPackageHost;
  const pkg = registerPackage(host);
  void pkg.onEnable?.();
  t.after(() => pkg.onDisable?.());
  t.after(release);
  const request = async (sessionId = "session", method = "POST") => {
    let status = 0;
    let data: Record<string, unknown> = {};
    const handled = await pkg.routes!({
      path: `/api/custom-titles/sessions/${sessionId}/regenerate`, method, space,
      json(code: number, payload: Record<string, unknown>) {
        status = code;
        data = code >= 400
          ? { ...httpErrorDiagnostics({ ...payload, code: payload.error }, method, "request"), ...payload }
          : payload;
      },
    } as Parameters<RouteHandler>[0]);
    return { handled, status, data };
  };
  return {
    generator, pkg, request, snapshot, renames, acquisitions, reached: () => reached, calls: () => calls,
    completion: () => completion, completions: () => completions, release,
    reply(...next: Array<string | Error>) { replies.push(...next); },
    failCompletion(error: unknown) { completionError = error; },
    failRename(error: unknown, afterMutation = false) { renameError = error; failAfterRename = afterMutation; },
    removeProject() { projectAvailable = false; },
    removeWorktree() { projections.set("session", { ...projections.get("session")!, worktreePath: undefined }); },
    useLegacyPool() { delete host.runtimes.forSession; },
    setPrompt(value: string) { prompt = value; },
    setTitle(title: string) { projections.set("session", { ...projections.get("session")!, title, titleSource: "manual" }); },
    setDraft(draft: string) { projections.set("session", { ...projections.get("session")!, draft }); },
    saveSettings(value: CustomTitleSettings) { createCustomTitleSettingsStore(spaceStorage).save(space, value, 1); },
  };
}

test("disabling Custom Titles cancels pending generation and re-enable permits new titles", async (t) => {
  const f = fixture(t, "catalog");
  const generating = f.generator.generate({ sessionId: "session", prompt: "Fix title generation" });
  const rejected = assert.rejects(generating, { code: "unavailable" });
  await setImmediate();
  await f.pkg.onDisable?.();
  await rejected;
  assert.equal(await f.generator.policy("session"), undefined);
  assert.equal(await f.generator.generate({ sessionId: "session", prompt: "Disabled" }), undefined);
  f.release();
  await setImmediate();
  assert.equal(f.calls(), 0);
  await f.pkg.onEnable?.();
  assert.equal(await f.generator.generate({ sessionId: "session", prompt: "Fix title generation" }), "Fix custom title generation");
});

test("title generation uses its selected harness and worktree even when the conversation harness is unavailable", async (t) => {
  const f = fixture(t);
  assert.equal((await f.generator.policy("session"))?.mode, "always");
  assert.equal(await f.generator.generate({ sessionId: "session", prompt: "Fix title generation" }), "Fix custom title generation");
  assert.equal(f.calls(), 1);
  assert.equal(f.completion()?.cwd, "/project-worktree");
  assert.deepEqual(f.acquisitions, [{ projectId: "project", sessionId: "session", cwd: "/project-worktree", harnessId: "opencode" }]);
  assert.deepEqual(f.completion()?.model, { providerID: freeModel.providerID, modelID: freeModel.modelID });
});

test("a custom generator acquires its harness in the project directory when no worktree is set", async (t) => {
  const f = fixture(t);
  f.removeWorktree();
  f.saveSettings({ ...DEFAULT_CUSTOM_TITLE_SETTINGS,
    generator: { kind: "custom", harnessId: "codex", providerID: "openai", modelID: "title-model" },
  });
  assert.equal((await f.request()).status, 200);
  assert.deepEqual(f.acquisitions, [{ projectId: "project", sessionId: "session", cwd: "/project", harnessId: "codex" }]);
  assert.equal(f.completion()?.cwd, "/project");
  assert.deepEqual(f.completion()?.model, { providerID: "openai", modelID: "title-model" });
});

test("older runtime pools acquire the selected generator directly through the project", async (t) => {
  const f = fixture(t);
  f.useLegacyPool();
  assert.equal((await f.request()).status, 200);
  assert.deepEqual(f.acquisitions, [{ projectId: "project", cwd: "/project-worktree", harnessId: "opencode" }]);
});

test("a deleted project cannot start a title generator in a default runtime", async (t) => {
  const f = fixture(t);
  f.removeProject();
  assert.equal((await f.request()).status, 404);
  assert.deepEqual(f.acquisitions, []);
  assert.equal(f.calls(), 0);
});

test("explicit regeneration uses current settings in fallback mode and the canonical rename path", async (t) => {
  const f = fixture(t);
  f.saveSettings({ ...DEFAULT_CUSTOM_TITLE_SETTINGS, mode: "fallback", language: "Ukrainian", style: "Concise", rules: "Mention the feature" });
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { title: "Fix custom title generation" });
  assert.deepEqual(f.renames, [{ sessionId: "session", title: "Fix custom title generation" }]);
  // The message is data between markers and the instruction comes last, so an
  // agent-tuned model reads "title this" last rather than the message's own ask.
  assert.match(f.completion()?.prompt ?? "", /^First message of the session:\n"""\nFix title generation\n"""\nReply with the title only\.\nTitle \(Ukrainian\):$/);
  assert.match(f.completion()?.systemPrompt ?? "", /Ukrainian/);
  assert.match(f.completion()?.systemPrompt ?? "", /Concise/);
  assert.match(f.completion()?.systemPrompt ?? "", /Mention the feature/);
  assert.equal((await f.snapshot("session")).titleSource, "manual");
});

test("regeneration rejects a known-valid foreign-Space session like an unknown session before inference", async (t) => {
  const f = fixture(t);
  const foreign = await f.request("foreign");
  const unknown = await f.request("unknown");
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign, unknown);
  assert.equal(f.calls(), 0);
  assert.deepEqual(f.renames, []);
});

test("a chat with only a draft is named after the draft", async (t) => {
  const f = fixture(t);
  f.setPrompt("  ");
  f.setDraft("Draft about title generation");
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.deepEqual(f.renames, [{ sessionId: "session", title: "Fix custom title generation" }]);
  assert.match(f.completion()?.prompt ?? "", /Draft about title generation/);
});

test("a sent message names the chat even when a draft is pending", async (t) => {
  const f = fixture(t);
  f.setDraft("Unrelated follow-up draft");
  assert.equal((await f.request()).status, 200);
  assert.match(f.completion()?.prompt ?? "", /Fix title generation/);
  assert.doesNotMatch(f.completion()?.prompt ?? "", /Unrelated follow-up draft/);
});

test("empty sessions cannot regenerate and requests must use POST", async (t) => {
  const f = fixture(t);
  f.setPrompt("  ");
  f.setDraft("   ");
  assert.equal((await f.request()).status, 400);
  assert.equal((await f.request("session", "GET")).handled, false);
  assert.equal(f.calls(), 0);
  assert.equal((await f.snapshot("session")).title, "Existing title");
});

test("a later manual title wins over pending regeneration", async (t) => {
  const f = fixture(t, "completion");
  const pending = f.request();
  await setImmediate();
  assert.equal(f.reached(), true);
  f.setTitle("User-chosen title");
  f.release();
  assert.equal((await pending).status, 409);
  assert.deepEqual(f.renames, []);
  assert.equal((await f.snapshot("session")).title, "User-chosen title");
});

test("duplicate regeneration is rejected and completion releases the pending key", async (t) => {
  const f = fixture(t, "completion");
  const pending = f.request();
  await setImmediate();
  assert.equal((await f.request()).status, 409);
  assert.equal(f.calls(), 1);
  f.release();
  assert.equal((await pending).status, 200);
  assert.equal((await f.request()).status, 200);
  assert.equal(f.calls(), 2);
});

test("a slow generator still completes an explicit regeneration after the automatic deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, "completion");
  const pending = f.request();
  await setImmediate();
  t.mock.timers.tick(30_000);
  await setImmediate();
  assert.equal(f.completion()?.signal?.aborted, false);
  f.release();
  assert.equal((await pending).status, 200);
  assert.equal(f.completion()?.timeoutMs, 45_000);
  assert.deepEqual(f.renames, [{ sessionId: "session", title: "Fix custom title generation" }]);
});

test("automatic naming hands the generator its own, shorter deadline", async (t) => {
  const f = fixture(t);
  assert.equal(await f.generator.generate({ sessionId: "session", prompt: "Fix title generation" }), "Fix custom title generation");
  assert.equal(f.completion()?.timeoutMs, 30_000);
});

test("disabling or timing out regeneration preserves the old title and permits a later retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, "completion");
  const pending = f.request();
  await setImmediate();
  t.mock.timers.tick(44_999);
  await setImmediate();
  assert.equal(f.completion()?.signal?.aborted, false);
  t.mock.timers.tick(1);
  const expired = await pending;
  assert.equal(expired.status, 504);
  assert.equal(expired.data.error, "timeout");
  assert.equal(expired.data.mutationOutcome, "not-started");
  assert.match(String(expired.data.message), /timed out/);
  assert.deepEqual(f.renames, []);
  assert.equal((await f.snapshot("session")).title, "Existing title");
  const retry = f.request();
  await setImmediate();
  await f.pkg.onDisable?.();
  assert.equal((await retry).status, 503);
  assert.deepEqual(f.renames, []);
  f.release();
  await f.pkg.onEnable?.();
  assert.equal((await f.request()).status, 200);
});

for (const [code, status, message] of [
  ["invalid-model", 422, /selected title model/],
  ["outcome-unknown", 503, /Title generation could not be confirmed/],
  ["unavailable", 503, /Custom Titles/],
] as const) {
  test(`regeneration reports ${code} without implying an uncertain session mutation`, async (t) => {
    const f = fixture(t);
    f.failCompletion(Object.assign(new Error("private upstream detail"), { code }));
    const response = await f.request();
    // A real failure is not a model that answered badly: never replayed.
    assert.equal(f.calls(), 1);
    assert.equal(response.status, status);
    assert.equal(response.data.mutationOutcome, "not-started");
    assert.notEqual(response.data.error, "outcome-unknown");
    assert.match(String(response.data.message), message);
    assert.doesNotMatch(String(response.data.message), /private upstream detail/);
    assert.deepEqual(f.renames, []);
    assert.equal((await f.snapshot("session")).title, "Existing title");
  });
}

test("a reply that wraps the title in reasoning and tags still names the session", async (t) => {
  const f = fixture(t);
  f.reply("<think>The user wants a title for the login bug.</think>\n<title>Fix login redirect loop</title>");
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { title: "Fix login redirect loop" });
  assert.equal(f.calls(), 1);
});

test("a reply with no title is retried once with the bare few-shot prompt", async (t) => {
  const f = fixture(t);
  f.reply("<tool_call>", "Fix the login redirect loop");
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { title: "Fix the login redirect loop" });
  const [first, retry] = f.completions();
  assert.equal(f.calls(), 2);
  assert.match(first!.prompt, /^First message of the session:/);
  assert.match(retry!.prompt, /^Message: the cron job runs twice every night, find out why\nTitle: .+\n\n/);
  assert.match(retry!.prompt, /\nMessage: Fix title generation\nTitle:$/);
  assert.ok(retry!.maxOutputTokens > first!.maxOutputTokens, "the retry leaves room for a model that thinks first");
  assert.notEqual(retry!.systemPrompt, first!.systemPrompt);
  assert.deepEqual(f.renames, [{ sessionId: "session", title: "Fix the login redirect loop" }]);
});

test("a model that never produces a title still gets an explicit regeneration a title from the request", async (t) => {
  const f = fixture(t);
  f.setPrompt("Hey, can you please fix the login redirect loop after OAuth? It started with the last deploy.");
  f.reply("<tool_call>", "Let me explore the project structure first.<tool_call>");
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { title: "Fix the login redirect loop after OAuth", fallback: true });
  assert.equal(f.calls(), 2);
  assert.deepEqual(f.renames, [{ sessionId: "session", title: "Fix the login redirect loop after OAuth" }]);
  assert.equal((await f.snapshot("session")).titleSource, "manual");
});

test("an adapter that reports an empty completion counts as a reply with no title", async (t) => {
  const f = fixture(t);
  const empty = () => Object.assign(new Error("pi returned an empty utility completion"), { code: "invalid-response" });
  f.reply(empty(), empty());
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.equal(response.data.fallback, true);
  assert.equal(f.calls(), 2);
  assert.doesNotMatch(String(response.data.title), /empty|utility/);
});

test("automatic naming retries once, then lets the session service pick its own fallback", async (t) => {
  const f = fixture(t);
  f.reply("Sure! I can help with that.", "<|im_start|>assistant");
  await assert.rejects(f.generator.generate({ sessionId: "session", prompt: "Fix title generation" }), { code: "invalid-response" });
  assert.equal(f.calls(), 2);
  f.reply("Sure! I can help with that.", "Fix custom title generation");
  assert.equal(await f.generator.generate({ sessionId: "session", prompt: "Fix title generation" }), "Fix custom title generation");
});

test("a retry gets only what remains of the deadline and is skipped when too little remains", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const slow = fixture(t, "completion");
  slow.reply("<tool_call>", "Fix login loop");
  const early = slow.generator.generate({ sessionId: "session", prompt: "Fix title generation" });
  await setImmediate();
  t.mock.timers.tick(10_000);
  slow.release();
  assert.equal(await early, "Fix login loop");
  assert.equal(slow.completions()[0]!.timeoutMs, 30_000);
  assert.equal(slow.completions()[1]!.timeoutMs, 18_500, "what remains, less the margin that lets a stalled retry fail before the deadline");

  const late = fixture(t, "completion");
  late.reply("<tool_call>", "Fix login loop");
  const expiring = late.generator.generate({ sessionId: "session", prompt: "Fix title generation" })
    .catch((error: unknown) => error as { code?: string });
  await setImmediate();
  t.mock.timers.tick(25_000);
  late.release();
  assert.equal(((await expiring) as { code?: string }).code, "invalid-response");
  assert.equal(late.calls(), 1, "5 s left is not enough for another model turn");
});

test("a retry that fails after a reply with no title ends in the fallback, not in an error", async (t) => {
  const f = fixture(t);
  f.reply("<tool_call>", Object.assign(new Error("pi utility completion timed out after 18500ms"), { code: "unavailable" }));
  const response = await f.request();
  assert.equal(response.status, 200);
  assert.equal(response.data.fallback, true);
  assert.equal(f.calls(), 2);
  f.reply("<tool_call>", Object.assign(new Error("provider failed"), { code: "auth-rejected" }));
  await assert.rejects(f.generator.generate({ sessionId: "session", prompt: "Fix title generation" }), { code: "invalid-response" });
});

test("an error after rename begins preserves an uncertain title mutation", async (t) => {
  const f = fixture(t);
  f.failRename(new Error("storage failed after rename began"), true);
  const response = await f.request();
  assert.equal(response.status, 503);
  assert.equal(response.data.mutationOutcome, "unknown");
  assert.equal(response.data.retryability, "never");
  assert.equal(response.data.error, "outcome-unknown");
  assert.match(String(response.data.message), /Check the session title/);
  assert.equal((await f.snapshot("session")).title, "Fix custom title generation");
  assert.equal(f.renames.length, 1);
});

for (const [code, status] of [["not-found", 404], ["invalid-input", 400]] as const) {
  test(`a canonical rename ${code} rejection does not imply an uncertain title change`, async (t) => {
    const f = fixture(t);
    f.failRename(Object.assign(new Error("Rename rejected"), { code }));
    const response = await f.request();
    assert.equal(response.status, status);
    assert.equal(response.data.error, code);
    assert.equal(response.data.mutationOutcome, "not-started");
    assert.equal((await f.snapshot("session")).title, "Existing title");
    assert.deepEqual(f.renames, []);
  });
}

for (const stage of ["context", "runtime", "catalog", "completion"] as const) {
  test(`title generation times out when ${stage} stalls and cannot submit after expiry`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(t, stage);
    let outcome: unknown;
    const generating = f.generator.generate({ sessionId: "session", prompt: "Fix title generation" })
      .catch((error: unknown) => { outcome = error; });
    await setImmediate();
    assert.equal(f.reached(), true);
    t.mock.timers.tick(29_999);
    await setImmediate();
    assert.equal(outcome, undefined);
    t.mock.timers.tick(1);
    await setImmediate();
    assert.equal((outcome as { code?: string } | undefined)?.code, "timeout");
    assert.equal(f.completion()?.signal?.aborted, stage === "completion" ? true : undefined);
    f.release();
    await generating;
    await setImmediate();
    assert.equal(f.calls(), stage === "completion" ? 1 : 0);
  });
}

test("regeneration names a session after the person's request, not a hidden wake", () => {
  const event = (type: string, data: Record<string, unknown>) => ({ type, data }) as unknown as SessionEvent;
  // A workflow parent never receives its task as a user turn; a delegated
  // permission arrives as a hidden message after the run started.
  assert.equal(namingRequest([
    event("session/created", { title: "New session" }),
    event("workflow/run-started", { input: "Fix the schedule date picker" }),
    event("user/message", { text: "The user delegated a subagent's permission request to you.", hiddenUserMessage: true }),
  ]), "Fix the schedule date picker");
  assert.equal(namingRequest([
    event("user/message", { text: "  " }),
    event("user/message", { text: "Hidden wake", hiddenUserMessage: true }),
    event("user/message", { text: "Fix title generation" }),
    event("workflow/run-started", { input: "A later workflow" }),
  ]), "Fix title generation");
  assert.equal(namingRequest([event("user/message", { text: "Only hidden", hiddenUserMessage: true })]), undefined);
});
