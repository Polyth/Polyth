import { join } from "node:path";
import type { RouteHandler, SessionProjection } from "@polyth/contracts";
import { deriveMessages } from "@polyth/session";
import { assistFreshnessSeq } from "@polyth/session/next-action";
import {
  localOnlyRemoteAccess,
  SERVER_TURN_COMPLETION_BUS,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import {
  createRecapService,
  createRecapSettings,
  isFresh,
} from "./recap.ts";

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
  // Keep the former file path so existing quiet-time preferences migrate
  // without a one-off data rewrite. Package lifecycle is now the sole switch.
  const settings = createRecapSettings({ file: join(host.storageDir, "assist.json") });

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

  let turnSubscription: { dispose(): void } | undefined;

  const routes = recapRoutes({
    settings,
    projection: (sessionId) => host.store.projection(sessionId),
    latestConversationSeq: async (sessionId) =>
      assistFreshnessSeq(await host.store.events(sessionId)),
  });

  return {
    remoteAccess: localOnlyRemoteAccess(["recap"]),
    routes,
    onEnable() {
      turnSubscription?.dispose();
      turnSubscription = host.services.require(SERVER_TURN_COMPLETION_BUS).subscribe(
        ({ sessionId, userId }) => recap.onTurnCompleted(sessionId, userId),
      );
    },
    onDisable() {
      turnSubscription?.dispose();
      turnSubscription = undefined;
      recap.stop();
    },
  };
}
