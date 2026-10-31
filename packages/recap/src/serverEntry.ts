import { join } from "node:path";
import type { RouteHandler, SessionProjection } from "@polyth/contracts";
import { deriveMessages } from "@polyth/session";
import { assistFreshnessSeq } from "@polyth/session/next-action";
import {
  adoptLegacyPackageData,
  localOnlyRemoteAccess,
  packageDataDir,
  SERVER_TURN_COMPLETION_BUS,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import {
  createRecapService,
  createRecapSettings,
  isFresh,
} from "./recap.ts";
import {
  buildPromptImprovementPrompt,
  createManualSuggestionService,
  PROMPT_IMPROVEMENT_OUTPUT_MAX_CHARS,
  sanitizeNextActionReply,
} from "./prompt.ts";
import { buildCalloutPrompt, latestTurnSources, parseCalloutReply } from "./callouts.ts";
import { promptRoutes } from "./promptRoutes.ts";

export function recapRoutes(deps: {
  settings: { get(): { idleSeconds: number }; put(patch: Record<string, unknown>): { idleSeconds: number } };
  projection(sessionId: string): Promise<SessionProjection | undefined>;
  latestConversationSeq(sessionId: string): Promise<number>;
}): RouteHandler {
  return async (rc) => {
    const { path, method, json } = rc;
    if (path === "/api/settings/assist" && method === "GET") {
      json(200, deps.settings.get());
      return true;
    }
    if (path === "/api/settings/assist" && method === "PUT") {
      json(200, deps.settings.put(await rc.body()));
      return true;
    }

    const match = path.match(/^\/api\/sessions\/([^/]+)\/assist$/);
    if (match && method === "GET") {
      const sessionId = decodeURIComponent(match[1]!);
      const projection = await deps.projection(sessionId);
      if (!projection) {
        json(404, { error: "not-found", message: "unknown session" });
        return true;
      }
      const assist = projection.assist;
      if (!assist) {
        json(404, { error: "not-found", message: "no recap generated yet" });
        return true;
      }
      if (!isFresh(assist, await deps.latestConversationSeq(sessionId))) {
        json(404, { error: "stale", message: "the session moved past this recap" });
        return true;
      }
      json(200, assist);
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const dataDir = packageDataDir(host);
  adoptLegacyPackageData(host, ["assist.json"]);
  // Keep the former file path so existing quiet-time preferences migrate
  // without a one-off data rewrite. Package lifecycle is now the sole switch.
  const settings = createRecapSettings({ file: join(dataDir, "assist.json") });

  const transcript = async (sessionId: string): Promise<string> => {
    const messages = deriveMessages(await host.store.events(sessionId));
    const lines: string[] = [];
    for (const message of messages.slice(-40)) {
      if (message.role === "tool") continue;
      const text = message.parts
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) lines.push(`${message.role === "user" ? "User" : "Assistant"}: ${text}`);
    }
    return lines.join("\n\n").slice(-16_000);
  };

  const recap = createRecapService({
    settings: () => settings.get(),
    latestSeq: (sessionId) => host.store.latestSeq(sessionId),
    eventsAfter: (sessionId, afterSeq) => host.store.events(sessionId, afterSeq),
    transcript,
    complete: async (sessionId, prompt, userId) => {
      const projection = await host.store.projection(sessionId);
      if (!projection) {
        throw Object.assign(new Error("unknown session"), { code: "not-found" });
      }
      const binding = await host.resolveSessionRuntime(sessionId);
      const model = host.smallModel(userId);
      const runtime = model?.harnessId
        ? await host.runtimes.forProject(projection.projectId, binding.cwd, model.harnessId)
        : binding.rt;
      const result = await host.smallModelComplete(runtime, {
        cwd: binding.cwd,
        prompt,
        ...(model ? { model } : binding.model ? { model: binding.model } : {}),
        maxOutputTokens: 1_024,
        timeoutMs: 90_000,
        purpose: "recap",
      });
      return result.text;
    },
    save: async (sessionId, assist) => {
      if (!host.store.patchProjection) return;
      const next = await host.store.patchProjection(sessionId, (current) => ({
        ...current,
        assist,
        updatedAt: Date.now(),
      }));
      if (next) host.broadcast.projection(next);
    },
    onError: (sessionId, error) =>
      console.error(`[polyth] recap generation failed for ${sessionId}`, error),
  });

  const manualSuggestion = createManualSuggestionService({
    latestSeq: (sessionId) => host.store.latestSeq(sessionId),
    events: (sessionId, afterSeq) => host.store.events(sessionId, afterSeq),
    complete: async (sessionId, prompt, userId) => {
      const projection = await host.store.projection(sessionId);
      if (!projection) throw Object.assign(new Error("unknown session"), { code: "not-found" });
      const project = await host.projects.get(projection.projectId);
      if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
      const configured = host.smallModel(userId);
      const model = configured ?? projection.model;
      const harnessId = configured?.harnessId ?? (configured ? undefined : projection.resolvedHarnessId);
      const runtime = await host.runtimes.forProject(projection.projectId, project.path, harnessId);
      const result = await host.smallModelComplete(runtime, {
        cwd: project.path,
        prompt,
        ...(model ? { model } : {}),
        maxOutputTokens: 1_024,
        timeoutMs: 90_000,
        purpose: "prompt-assist",
      });
      return result.text;
    },
  });
  let generation = 0;
  const prompts = promptRoutes({
    projection: async (space, sessionId) => {
      try { return await host.forSpace(space).sessions.snapshot(sessionId); }
      catch (error) {
        if ((error as { code?: string }).code === "not-found") return undefined;
        throw error;
      }
    },
    suggestion: (space, sessionId, draft, options) => manualSuggestion.generate(sessionId, draft, space.userId, options),
    // Explicit user request only; the heuristic pass needs no model.
    callouts: async (space, sessionId) => {
      const events = await host.store.events(sessionId);
      const sources = latestTurnSources(events);
      const atSeq = sources.at(-1)?.seq ?? 0;
      if (!sources.length) throw Object.assign(new Error("no completed turn"), { code: "no-completed-turn" });
      const projection = await host.store.projection(sessionId);
      const project = projection && await host.projects.get(projection.projectId);
      if (!projection || !project) throw Object.assign(new Error("unknown session"), { code: "not-found" });
      const configured = host.smallModel(space.userId);
      const model = configured ?? projection.model;
      const harnessId = configured?.harnessId ?? (configured ? undefined : projection.resolvedHarnessId);
      const runtime = await host.runtimes.forProject(projection.projectId, project.path, harnessId);
      const result = await host.smallModelComplete(runtime, {
        cwd: project.path,
        prompt: buildCalloutPrompt(sources),
        ...(model ? { model } : {}),
        maxOutputTokens: 1_024,
        timeoutMs: 90_000,
        purpose: "recap",
      });
      const latest = latestTurnSources(await host.store.events(sessionId));
      if ((latest.at(-1)?.seq ?? 0) !== atSeq) throw Object.assign(new Error("stale"), { code: "stale" });
      return { callouts: parseCalloutReply(result.text, sources), atSeq };
    },
    improve: async (space, projectId, draft) => {
      const admittedGeneration = generation;
      const project = await host.forSpace(space).projects.get(projectId);
      if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
      const model = host.smallModel(space.userId);
      const runtime = await host.runtimes.forProject(projectId, project.path, model?.harnessId);
      if (admittedGeneration !== generation) throw Object.assign(new Error("stale"), { code: "stale" });
      const result = await host.smallModelComplete(runtime, {
        cwd: project.path,
        prompt: buildPromptImprovementPrompt(draft),
        ...(model ? { model } : {}),
        maxOutputTokens: 1_024,
        timeoutMs: 90_000,
        purpose: "prompt-generation",
      });
      if (admittedGeneration !== generation) throw Object.assign(new Error("stale"), { code: "stale" });
      return sanitizeNextActionReply(result.text, PROMPT_IMPROVEMENT_OUTPUT_MAX_CHARS);
    },
  });

  let turnSubscription: { dispose(): void } | undefined;

  const routes = recapRoutes({
    settings,
    projection: (sessionId) => host.store.projection(sessionId),
    latestConversationSeq: async (sessionId) =>
      assistFreshnessSeq(await host.store.events(sessionId)),
  });

  return {
    remoteAccess: localOnlyRemoteAccess(["recap"]),
    routes: async (rc) => await prompts(rc) || await routes(rc),
    onEnable() {
      turnSubscription?.dispose();
      turnSubscription = host.services.require(SERVER_TURN_COMPLETION_BUS).subscribe(
        ({ sessionId, userId }) => recap.onTurnCompleted(sessionId, userId),
      );
    },
    onDisable() {
      generation += 1;
      manualSuggestion.invalidate();
      turnSubscription?.dispose();
      turnSubscription = undefined;
      recap.stop();
    },
  };
}
