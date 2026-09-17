import type { ProjectService, RouteHandler, RouteRequest, SessionService } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { loadInlineAiSettings, saveInlineAiSettings } from "./inlineAi.ts";
import {
  MAX_INLINE_AI_SELECTION_CHARS,
  parseModelOverride,
  substituteInlineAiPrompt,
  type InlineAiAction,
} from "./inlineAiShared.ts";

function notFound(message = "not found"): never {
  throw Object.assign(new Error(message), { code: "not-found" });
}

function badRequest(message: string): never {
  throw Object.assign(new Error(message), { code: "invalid-input" });
}

const EXT_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
  ".py": "python", ".go": "go", ".rs": "rust", ".md": "markdown", ".json": "json",
};

function languageOfPath(relPath: string): string {
  const ext = relPath.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  return EXT_LANG[ext] ?? "text";
}

export function inlineAiRoutes(
  host: Pick<
    ServerPackageHost,
    "spaceStorage" | "projects" | "sessions" | "smallModel" | "smallModelComplete" | "runtimes"
  >,
  deps: { projects: ProjectService; sessions: SessionService },
): RouteHandler {
  const assertProject = async (spaceId: string, projectId: string) => {
    const project = await deps.projects.get(projectId);
    if (!project || project.spaceId !== spaceId) notFound("project not found");
    return project;
  };

  const assertSession = async (spaceId: string, projectId: string, sessionId?: string) => {
    if (!sessionId) return undefined;
    const snap = await deps.sessions.snapshot(sessionId);
    if (snap.spaceId !== spaceId || snap.projectId !== projectId) notFound("session not found");
    return snap;
  };

  return async (request: RouteRequest) => {
    const { path, method, space } = request;
    if (!path.startsWith("/api/files/inline-ai")) return false;
    const storage = host.spaceStorage(space);

    if (path === "/api/files/inline-ai/settings") {
      if (method === "GET") {
        request.json(200, await loadInlineAiSettings(storage));
        return true;
      }
      if (method === "PUT") {
        const input = await request.body();
        request.json(200, await saveInlineAiSettings(storage, {
          ...(typeof input.explainPrompt === "string" ? { explainPrompt: input.explainPrompt } : {}),
          ...(typeof input.fixPrompt === "string" ? { fixPrompt: input.fixPrompt } : {}),
          ...(typeof input.modelOverride === "string" ? { modelOverride: input.modelOverride } : {}),
        }));
        return true;
      }
      return false;
    }

    if (path === "/api/files/inline-ai" && method === "POST") {
      const input = await request.body();
      const action = String(input.action ?? "") as InlineAiAction;
      if (action !== "explain" && action !== "fix") badRequest("action must be explain or fix");
      const projectId = String(input.projectId ?? "");
      const relPath = String(input.path ?? "");
      const selection = String(input.selection ?? "");
      if (!projectId || !relPath) badRequest("projectId and path are required");
      if (!selection.trim()) badRequest("selection is required");
      if (selection.length > MAX_INLINE_AI_SELECTION_CHARS) {
        badRequest(`selection exceeds ${MAX_INLINE_AI_SELECTION_CHARS} characters`);
      }
      const project = await assertProject(space.spaceId, projectId);
      const sessionId = input.sessionId ? String(input.sessionId) : undefined;
      await assertSession(space.spaceId, projectId, sessionId);

      const settings = await loadInlineAiSettings(storage);
      const language = typeof input.language === "string" && input.language
        ? input.language
        : languageOfPath(relPath);
      const template = action === "explain" ? settings.explainPrompt : settings.fixPrompt;
      const prompt = substituteInlineAiPrompt(template, {
        selection,
        path: relPath,
        language,
      });

      const override = parseModelOverride(settings.modelOverride);
      const model = override ?? host.smallModel(space.userId);
      if (!model) {
        request.json(503, { error: "unavailable", message: "utility model is not configured" });
        return true;
      }
      const runtime = await host.runtimes.forProject(project.id, project.path, "harnessId" in model ? model.harnessId : undefined);
      const result = await host.smallModelComplete(runtime, {
        cwd: project.path,
        prompt,
        model,
        maxOutputTokens: action === "explain" ? 1_024 : 2_048,
        timeoutMs: 120_000,
        purpose: "extension-utility",
      });
      request.json(200, { text: result.text });
      return true;
    }

    return false;
  };
}
