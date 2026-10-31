import type { RouteHandler, SessionEvent, SessionProjection, SpaceContext } from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  SERVER_SESSION_TITLE_GENERATOR,
  type ServerPackage,
  type ServerPackageHost,
  type ServerSessionTitleGenerator,
} from "@polyth/plugins";
import {
  CUSTOM_TITLE_FALLBACK_DELAY_MS,
  CUSTOM_TITLES_PACKAGE_ID,
  type CustomTitleSettings,
} from "./settings.ts";
import { createCustomTitleSettingsStore } from "./settingsStore.ts";
import {
  buildCustomTitlePrompt,
  buildCustomTitleSystemPrompt,
  fallbackTitleFromRequest,
  readGeneratedTitle,
  selectOpenCodeFreeModel,
  titlePromptInput,
  type CustomTitleAttempt,
} from "./title.ts";

// Automatic naming holds back the session's fallback title, so it gives up
// sooner than an explicit click, which can wait for a slow or cold generator.
// Measured: a title turn on OpenCode's free models takes 8–36 s end to end.
// Regeneration stays under the usual 60 s reverse-proxy read timeout.
const AUTOMATIC_TITLE_TIMEOUT_MS = 30_000;
const REGENERATE_TITLE_TIMEOUT_MS = 45_000;

// A model that answered without a title (prose, tool-call markup, nothing) is
// asked once more with a bare few-shot prompt before the request is given up on.
// Only such a reply is retried: a timeout, an auth or a model error is real,
// and replaying it could bill the same completion twice. A title needs ~30
// tokens; the caps leave room for a model that spends its first tokens thinking
// (direct providers count them), the retry's more so.
const ATTEMPTS: ReadonlyArray<{ kind: CustomTitleAttempt; maxOutputTokens: number }> = [
  { kind: "standard", maxOutputTokens: 192 },
  { kind: "strict", maxOutputTokens: 512 },
];
// A retry needs a budget for a process start plus one short answer, and that
// budget ends before the overall deadline so a stalled retry still ends in the
// caller's fallback instead of a timeout error.
const MIN_RETRY_MS = 8_000;
const RETRY_MARGIN_MS = 1_500;

const publicError = (cause: unknown): { status: number; code: string; message: string } => {
  const code = typeof (cause as { code?: unknown })?.code === "string"
    ? String((cause as { code: string }).code)
    : "unavailable";
  if (code === "invalid-input") return { status: 400, code, message: cause instanceof Error ? cause.message : "Invalid settings" };
  if (code === "conflict") return { status: 409, code, message: cause instanceof Error ? cause.message : "Settings changed" };
  if (code === "not-found") return { status: 404, code, message: "Session not found" };
  if (code === "timeout") return { status: 504, code, message: "Title generation timed out. Try again, or choose another generator in Custom Titles settings." };
  if (code === "invalid-model") return { status: 422, code, message: "The selected title model is unavailable. Choose another generator in Custom Titles settings." };
  if (code === "invalid-response") return { status: 502, code, message: "The generator returned no usable title. Try again." };
  if (code === "outcome-unknown") return { status: 503, code: "generation-unconfirmed", message: "Title generation could not be confirmed. The session title was not changed." };
  return { status: 503, code: "unavailable", message: "Custom Titles is unavailable. Check the title generator in Custom Titles settings, or try again." };
};

/** The person's request a session is named after: its first visible message,
 * or the task of a workflow run it was created to host (that parent never
 * receives the task as a user turn). Hidden messages, such as a delegated
 * permission wake, are not the person's words. */
export const namingRequest = (events: readonly SessionEvent[]): string | undefined => {
  for (const event of events) {
    const text = event.type === "user/message" && event.data.hiddenUserMessage !== true
      ? event.data.text
      : event.type === "workflow/run-started" ? event.data.input : undefined;
    if (typeof text === "string" && text.trim()) return text;
  }
  return undefined;
};

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const settingsStore = createCustomTitleSettingsStore((space) => host.spaceStorage(space));
  let enabled = false;
  const generations = new Set<AbortController>();
  const regenerations = new Set<string>();

  const sessionContext = async (sessionId: string): Promise<{
    space: SpaceContext;
    settings: CustomTitleSettings;
    projectId: string;
    cwd: string;
    projection: SessionProjection;
  }> => {
    const projection = await host.store.projection(sessionId);
    if (!projection) throw Object.assign(new Error("unknown session"), { code: "not-found" });
    const project = await host.projects.get(projection.projectId);
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    const spaceId = projection.spaceId ?? project.spaceId;
    if (!spaceId) throw Object.assign(new Error("session Space is unavailable"), { code: "unavailable" });
    const space = host.systemSpaceContext(spaceId);
    return {
      space,
      settings: settingsStore.read(space).settings,
      projectId: projection.projectId,
      cwd: projection.worktreePath ?? project.path,
      projection,
    };
  };

  const generateTitle = async (
    sessionId: string,
    prompt: string,
    signal: AbortSignal,
    timeoutMs: number,
    deadline: number,
  ): Promise<string | undefined> => {
    const { settings, projectId, cwd, projection } = await sessionContext(sessionId);
    signal.throwIfAborted();
    const input = titlePromptInput(prompt);
    if (!input) return undefined;
    const selected = settings.generator;
    const harnessId = selected.kind === "opencode-free" ? "opencode" : selected.harnessId;
    // Utility inference has its own selected harness. Resolving the conversation
    // leg first needlessly starts it and lets an unavailable leg block naming.
    const runtime = host.runtimes.forSession
      ? await host.runtimes.forSession(projection, cwd, harnessId)
      : await host.runtimes.forProject(projectId, cwd, harnessId);
    signal.throwIfAborted();
    const model = selected.kind === "opencode-free"
      ? selectOpenCodeFreeModel(await runtime.models())
      : { providerID: selected.providerID, modelID: selected.modelID };
    signal.throwIfAborted();
    if (!model) {
      throw Object.assign(new Error("OpenCode exposes no available free text model"), { code: "unavailable" });
    }
    const unusable: string[] = [];
    // Reasons only: a reply is derived from the user's message and may echo it.
    const report = (outcome: "recovered" | "gave-up") => console.warn("[polyth] custom title generator reply was not a title", JSON.stringify({
      generator: `${model.providerID}/${model.modelID}`,
      outcome,
      attempts: unusable,
    }));
    for (const attempt of ATTEMPTS) {
      const retry = attempt.kind !== "standard";
      const budget = retry ? deadline - Date.now() - RETRY_MARGIN_MS : timeoutMs;
      if (retry && budget < MIN_RETRY_MS) break;
      signal.throwIfAborted();
      let text: string;
      try {
        ({ text } = await host.smallModelComplete(runtime, {
          cwd,
          prompt: buildCustomTitlePrompt(prompt, settings, attempt.kind),
          systemPrompt: buildCustomTitleSystemPrompt(settings, attempt.kind),
          model,
          maxOutputTokens: attempt.maxOutputTokens,
          timeoutMs: budget,
          signal,
          purpose: "custom-title",
        }));
      } catch (cause) {
        signal.throwIfAborted();
        // The adapter found the completion empty or past its output bound. After
        // a first reply that was no title, any failure of the retry counts the
        // same way: the generator answers, it just cannot title this message.
        const code = (cause as { code?: unknown })?.code;
        if (code !== "invalid-response" && !retry) throw cause;
        unusable.push(`${attempt.kind}:${code === "invalid-response" ? "empty-completion" : "failed"}`);
        continue;
      }
      signal.throwIfAborted();
      const result = readGeneratedTitle(text, input);
      if ("title" in result) {
        if (unusable.length) report("recovered");
        return result.title;
      }
      unusable.push(`${attempt.kind}:${result.rejected}`);
    }
    report("gave-up");
    throw Object.assign(new Error("title generator returned no usable title"), { code: "invalid-response" });
  };

  const generateWithin = async (sessionId: string, prompt: string, timeoutMs: number): Promise<string | undefined> => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    const deadline = Date.now() + timeoutMs;
    generations.add(controller);
    const timer = setTimeout(() => controller.abort(Object.assign(
      new Error("custom title generation timed out"), { code: "timeout" },
    )), timeoutMs);
    timer.unref?.();
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      // Bound setup and catalog discovery as well as inference. Otherwise
      // Always mode suppresses native titles without ever reaching fallback.
      return await Promise.race([generateTitle(sessionId, prompt, controller.signal, timeoutMs, deadline), aborted]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      generations.delete(controller);
    }
  };

  const titleGenerator: ServerSessionTitleGenerator = {
    async policy(sessionId) {
      if (!enabled) return undefined;
      const { settings } = await sessionContext(sessionId);
      return { mode: settings.mode, fallbackDelayMs: CUSTOM_TITLE_FALLBACK_DELAY_MS };
    },
    generate: ({ sessionId, prompt }) => generateWithin(sessionId, prompt, AUTOMATIC_TITLE_TIMEOUT_MS),
  };
  host.services.provide(SERVER_SESSION_TITLE_GENERATOR, titleGenerator);

  const routes: RouteHandler = async ({ path, method, body, json, space }) => {
    const regenerate = path.match(/^\/api\/custom-titles\/sessions\/([^/]+)\/regenerate$/);
    if (regenerate && method === "POST") {
      let key: string | undefined;
      let renameStarted = false;
      try {
        const sessionId = decodeURIComponent(regenerate[1]!);
        const sessions = host.forSpace(space).sessions;
        const before = await sessions.snapshot(sessionId);
        if (!enabled || !sessions.rename) throw Object.assign(new Error("Custom Titles is unavailable"), { code: "unavailable" });
        const pendingKey = `${space.spaceId}\0${sessionId}`;
        if (regenerations.has(pendingKey)) throw Object.assign(new Error("Title regeneration is already in progress"), { code: "conflict" });
        key = pendingKey;
        regenerations.add(key);
        // A chat that has only a draft is named after it. The Space-scoped
        // snapshot carries the caller's own draft, never another person's.
        const prompt = namingRequest(await sessions.events(sessionId))
          ?? (before.draft?.trim() ? before.draft : undefined);
        if (prompt === undefined) throw Object.assign(new Error("Write a message before regenerating the title"), { code: "invalid-input" });
        let title: string | undefined;
        let fallback = false;
        try {
          title = await generateWithin(sessionId, prompt, REGENERATE_TITLE_TIMEOUT_MS);
        } catch (cause) {
          // The model answered, just never with a title. A click still earns one,
          // drawn from the user's own first message and flagged as such.
          if ((cause as { code?: unknown })?.code !== "invalid-response") throw cause;
          title = fallbackTitleFromRequest(prompt);
          if (!title) throw cause;
          fallback = true;
        }
        if (!title || !enabled) throw Object.assign(new Error("Custom Titles is unavailable"), { code: "unavailable" });
        const current = await sessions.snapshot(sessionId);
        if (current.title !== before.title || current.titleSource !== before.titleSource) {
          throw Object.assign(new Error("The session title changed during generation. Try again."), { code: "conflict" });
        }
        // Explicit regeneration settles naming intent through the same durable
        // rename path as a user edit, including automatic-title cancellation.
        renameStarted = true;
        await sessions.rename(sessionId, title);
        json(200, fallback ? { title, fallback: true } : { title });
      } catch (cause) {
        // Canonical rename rejects these before appending any event. Other
        // failures after entry can have occurred after a durable title change.
        const code = (cause as { code?: unknown })?.code;
        const uncertain = renameStarted && code !== "not-found" && code !== "invalid-input";
        const error = uncertain
          ? { status: 503, code: "outcome-unknown", message: "The title change could not be confirmed. Check the session title before regenerating again." }
          : publicError(cause);
        // The response keeps the cause private, so a server failure would
        // otherwise leave no trace of why a generator timed out or refused.
        if (error.status >= 500) console.warn("[polyth] custom title regeneration failed", cause);
        json(error.status, {
          error: error.code,
          message: error.message,
          operation: "title-regenerate",
          mutationOutcome: uncertain ? "unknown" : "not-started",
          retryability: "never",
        });
      } finally {
        if (key) regenerations.delete(key);
      }
      return true;
    }
    if (path !== "/api/custom-titles/settings") return false;
    if (method === "GET") {
      try {
        json(200, settingsStore.read(space));
      } catch (cause) {
        const error = publicError(cause);
        json(error.status, { error: error.code, message: error.message });
      }
      return true;
    }
    if (method === "PUT") {
      try {
        const payload = await body();
        const input = payload && typeof payload === "object" && !Array.isArray(payload)
          ? payload as Record<string, unknown>
          : {};
        json(200, settingsStore.save(space, input.settings, Number(input.expectedRevision)));
      } catch (cause) {
        const error = publicError(cause);
        json(error.status, { error: error.code, message: error.message });
      }
      return true;
    }
    return false;
  };

  return {
    remoteAccess: localOnlyRemoteAccess([CUSTOM_TITLES_PACKAGE_ID]),
    routes,
    onEnable() {
      enabled = true;
    },
    onDisable() {
      enabled = false;
      for (const controller of generations) {
        controller.abort(Object.assign(new Error("Custom Titles was disabled"), { code: "unavailable" }));
      }
    },
  };
}
