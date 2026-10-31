import { roleAtLeast, type RouteHandler } from "@polyth/contracts";
import { readFile, realpath } from "node:fs/promises";
import { resolveWorkspaceContext, workspaceRepository } from "@polyth/contracts/workspace";
import { localOnlyRemoteAccess, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import { capabilityFor, contentRevision, EditorLanguageWorkspace, unavailable, validateRelativeSource } from "./languageService.ts";
import type { EditorLanguageCapability, EditorLanguageRequest, EditorRenameApplyRequest, EditorRenameTarget } from "./languageTypes.ts";

type EditorRoute = RouteHandler & { dispose(): Promise<void> };

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function position(value: unknown): { line: number; character: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.line) || !Number.isSafeInteger(row.character)
    || Number(row.line) < 0 || Number(row.character) < 0) return null;
  return { line: Number(row.line), character: Number(row.character) };
}

function routeError(request: Parameters<RouteHandler>[0], code: number, message: string): void {
  request.json(code, { error: message });
}

function workspaceKey(scope: { spaceId: string; projectId: string; sessionId: string | null; repositoryId: string; root: string }): string {
  return JSON.stringify([scope.spaceId, scope.projectId, scope.sessionId, scope.repositoryId, scope.root]);
}

const MAX_WORKSPACES = 2;

function registerRoutes(host: ServerPackageHost): EditorRoute {
  const workspaces = new Map<string, EditorLanguageWorkspace>();

  const getWorkspace = async (
    request: Parameters<RouteHandler>[0],
    input: Record<string, unknown>,
  ): Promise<EditorLanguageWorkspace | null> => {
    const projectId = text(input.projectId);
    const sessionId = nullableText(input.sessionId);
    if (input.sessionId !== undefined && input.sessionId !== null && !sessionId) {
      routeError(request, 400, "sessionId must be a non-empty string");
      return null;
    }
    const repositoryId = text(input.repositoryId);
    if (!projectId || !repositoryId) {
      routeError(request, 400, "projectId and repositoryId are required");
      return null;
    }
    const scoped = host.forSpace(request.space);
    const project = await scoped.projects.get(projectId);
    if (!project) {
      routeError(request, 404, "project not found");
      return null;
    }
    if (project.remote) {
      routeError(request, 422, "Local language services are unavailable for remote repositories");
      return null;
    }
    const session = sessionId ? await scoped.sessions.snapshot(sessionId) : null;
    if (session && session.projectId !== projectId) {
      routeError(request, 404, "session not found in project");
      return null;
    }
    const context = resolveWorkspaceContext(project, session);
    let repository;
    try {
      repository = workspaceRepository(context, repositoryId);
    } catch {
      routeError(request, 404, "repository not found in workspace");
      return null;
    }
    if (repository.state !== "ready") {
      routeError(request, 404, "repository checkout is missing");
      return null;
    }
    const scope = {
      spaceId: request.space.spaceId,
      projectId,
      sessionId,
      repositoryId,
      root: repository.path,
    };
    const key = workspaceKey(scope);
    const existing = workspaces.get(key);
    if (existing) {
      await existing.refresh();
      return existing;
    }
    try {
      const workspace = await EditorLanguageWorkspace.open(scope);
      if (workspaces.size >= MAX_WORKSPACES) {
        const evictable = [...workspaces.entries()]
          .filter(([, candidate]) => !candidate.isBusy())
          .sort((a, b) => a[1].lastUsed() - b[1].lastUsed())[0];
        if (!evictable) {
          workspace.dispose();
          routeError(request, 429, "language workspace capacity is busy; retry shortly");
          return null;
        }
        evictable[1].dispose();
        workspaces.delete(evictable[0]);
      }
      workspaces.set(key, workspace);
      return workspace;
    } catch {
      routeError(request, 422, "repository is not available for local language services");
      return null;
    }
  };

  const requestInput = async (request: Parameters<RouteHandler>[0]): Promise<(EditorLanguageRequest & { capability: string | null }) | null> => {
    const input = await request.body();
    if (input.sessionId !== undefined && input.sessionId !== null && !text(input.sessionId)) {
      routeError(request, 400, "sessionId must be a non-empty string");
      return null;
    }
    const path = text(input.path);
    const projectId = text(input.projectId);
    const repositoryId = text(input.repositoryId);
    const point = position(input.position);
    if (!path || !projectId || !repositoryId || !point) {
      routeError(request, 400, "path, position, projectId and repositoryId are required");
      return null;
    }
    if (typeof input.content === "string" && Buffer.byteLength(input.content) > 512 * 1024) {
      routeError(request, 413, "current document exceeds the language-service size limit");
      return null;
    }
    return {
      projectId,
      repositoryId,
      sessionId: nullableText(input.sessionId),
      path,
      position: point,
      capability: text(input.capability),
      ...(typeof input.content === "string" && input.content.length <= 512 * 1024 ? { content: input.content } : {}),
      ...(typeof input.contentRevision === "string" && /^[0-9a-f]{64}$/i.test(input.contentRevision) ? { contentRevision: input.contentRevision } : {}),
    };
  };

  const execute: RouteHandler = async (request) => {
    if (!request.path.startsWith("/api/editor/language")) return false;
    if (request.method === "POST" && request.path === "/api/editor/language") {
      const input = await requestInput(request);
      if (!input) return true;
      if (input.capability !== "definition" && input.capability !== "references" && input.capability !== "rename"
        && input.capability !== "completion" && input.capability !== "hover" && input.capability !== "diagnostics") {
        routeError(request, 400, "unsupported language capability");
        return true;
      }
      const workspace = await getWorkspace(request, input as unknown as Record<string, unknown>);
      if (!workspace) return true;
      if (!validateRelativeSource(workspace.scope.root, input.path)) {
        routeError(request, 400, "path must be a repository-relative source path");
        return true;
      }
      if (!capabilityFor(input.path)) {
        request.json(200, unavailable(input.capability as EditorLanguageCapability, "language"));
        return true;
      }
      const overlay = input.content === undefined ? undefined : { content: input.content, revision: input.contentRevision };
      if (input.capability === "definition") {
        const response = await workspace.definitions(input.path, input.position, overlay);
        request.json(200, response);
        return true;
      }
      if (input.capability === "references") {
        const response = await workspace.references(input.path, input.position, overlay);
        request.json(200, response);
        return true;
      }
      if (input.capability === "rename") {
        const response = await workspace.rename(input.path, input.position, undefined, overlay);
        request.json(200, response);
        return true;
      }
      if (input.capability === "completion") {
        const completions = await workspace.completion(input.path, input.position, overlay);
        request.json(200, { capability: "completion", completions });
        return true;
      }
      if (input.capability === "hover") {
        const hover = await workspace.hover(input.path, input.position, overlay);
        request.json(200, { capability: "hover", hover });
        return true;
      }
      if (input.capability === "diagnostics") {
        const diagnostics = await workspace.diagnostics(input.path, overlay);
        request.json(200, { capability: "diagnostics", diagnostics });
        return true;
      }
      return true;
    }
    if (request.method === "POST" && request.path === "/api/editor/language/rename-preview") {
      const input = await request.body();
      const path = text(input.path);
      const workspace = await getWorkspace(request, input);
      const point = position(input.position);
      if (!workspace || !path || !point) {
        if (workspace) routeError(request, 400, "path and position are required");
        return true;
      }
      if (typeof input.content === "string" && Buffer.byteLength(input.content) > 512 * 1024) {
        routeError(request, 413, "current document exceeds the language-service size limit");
        return true;
      }
      const overlay = typeof input.content === "string" && input.content.length <= 512 * 1024
        ? { content: input.content, revision: typeof input.contentRevision === "string" ? input.contentRevision : undefined }
        : undefined;
      const response = await workspace.rename(path, point, text(input.newName) ?? undefined, overlay);
      request.json(200, response);
      return true;
    }
    if (request.method === "POST" && request.path === "/api/editor/language/rename-apply") {
      if (!roleAtLeast(request.space.role, "member")) {
        routeError(request, 403, "Space member access is required to rename symbols");
        return true;
      }
      const input = await request.body() as unknown as Partial<EditorRenameApplyRequest>;
      const workspace = await getWorkspace(request, input as Record<string, unknown>);
      if (!workspace) return true;
      const newName = text(input.newName);
      const targets = Array.isArray(input.targets) ? input.targets as EditorRenameTarget[] : [];
      if (!newName || !/^[A-Za-z_$][\w$]*$/.test(newName) || targets.length === 0 || targets.length > 2_000) {
        routeError(request, 400, "newName and rename targets are required");
        return true;
      }
      const checked: Array<{ target: EditorRenameTarget; absolute: string; content: string }> = [];
      for (const target of targets) {
        if (!target || typeof target !== "object" || !target.range || typeof target.path !== "string" || !/^[0-9a-f]{64}$/i.test(target.expectedRevision)) {
          routeError(request, 400, "malformed rename target");
          return true;
        }
        if (!target || target.repositoryId !== workspace.scope.repositoryId
          || target.projectId !== workspace.scope.projectId
          || (target.sessionId ?? null) !== workspace.scope.sessionId) {
          routeError(request, 400, "rename target is outside the requested workspace");
          return true;
        }
        const absolute = validateRelativeSource(workspace.scope.root, target.path);
        const source = absolute ? workspace.source(target.path) : undefined;
        if (!absolute || !source || source.revision !== target.expectedRevision) {
          routeError(request, 409, `stale rename target: ${target.path}`);
          return true;
        }
        let diskContent: string;
        try {
          if (await realpath(absolute) !== absolute) throw new Error("symlink target changed");
          diskContent = await readFile(absolute, "utf8");
        } catch {
          routeError(request, 409, `rename target is unavailable: ${target.path}`);
          return true;
        }
        if (contentRevision(diskContent) !== target.expectedRevision) {
          routeError(request, 409, `stale rename target: ${target.path}`);
          return true;
        }
        checked.push({ target, absolute, content: diskContent });
      }
      const offsets = (content: string, target: EditorRenameTarget): { start: number; end: number } | null => {
        const lines = content.split("\n");
        const { start, end } = target.range;
        if (![start.line, start.character, end.line, end.character].every(Number.isSafeInteger)
          || start.line < 0 || end.line < start.line || start.character < 0 || end.character < 0
          || start.line >= lines.length || end.line >= lines.length
          || start.character > lines[start.line]!.length || end.character > lines[end.line]!.length) return null;
        let startOffset = 0; let endOffset = 0;
        for (let line = 0; line < start.line; line++) startOffset += lines[line]!.length + 1;
        for (let line = 0; line < end.line; line++) endOffset += lines[line]!.length + 1;
        startOffset += start.character; endOffset += end.character;
        return startOffset <= endOffset ? { start: startOffset, end: endOffset } : null;
      };
      const grouped = new Map<string, Array<{ item: typeof checked[number]; start: number; end: number }>>();
      for (const item of checked) {
        const range = offsets(item.content, item.target);
        if (!range) { routeError(request, 400, `invalid rename range: ${item.target.path}`); return true; }
        const group = grouped.get(item.absolute) ?? [];
        if (group.some((existing) => range.start < existing.end && existing.start < range.end)) {
          routeError(request, 400, `overlapping rename targets: ${item.target.path}`); return true;
        }
        group.push({ item, ...range }); grouped.set(item.absolute, group);
      }
      if (grouped.size > 0 && grouped.size > 256) { routeError(request, 413, "too many rename files"); return true; }
      // Re-read every file immediately before the first write to catch a
      // concurrent editor save after the initial preview validation.
      for (const items of grouped.values()) {
        const item = items[0]!.item;
        let latest: string;
        try { if (await realpath(item.absolute) !== item.absolute) throw new Error("symlink target changed"); latest = await readFile(item.absolute, "utf8"); }
        catch { routeError(request, 409, `stale rename target: ${item.target.path}`); return true; }
        if (contentRevision(latest) !== item.target.expectedRevision) { routeError(request, 409, `stale rename target: ${item.target.path}`); return true; }
        for (const target of items) target.item.content = latest;
      }
      const applied: string[] = [];
      const failed: { path: string; reason: string }[] = [];
      for (const [absolute, items] of grouped) {
        const original = items[0]!.item.content;
        const next = [...items].sort((a, b) => b.start - a.start).reduce((content, target) => `${content.slice(0, target.start)}${newName}${content.slice(target.end)}`, original);
        try {
          const { writeFile } = await import("node:fs/promises");
          if (await realpath(absolute) !== absolute || contentRevision(await readFile(absolute, "utf8")) !== items[0]!.item.target.expectedRevision) {
            throw new Error("File changed before rename was applied");
          }
          await writeFile(absolute, next, "utf8");
          applied.push(items[0]!.item.target.path);
        } catch (error) {
          failed.push({ path: items[0]!.item.target.path, reason: error instanceof Error ? error.message : "write failed" });
        }
      }
      await workspace.refresh();
      request.json(failed.length ? 207 : 200, { ok: failed.length === 0, applied, ...(failed.length ? { failed } : {}) });
      return true;
    }
    return false;
  };
  // One bounded queue covers acquisition, overlay reads and writes. A workspace
  // cannot be evicted between acquisition and use, and concurrent renames cannot
  // interleave their preflight and writes inside this package.
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let closed = false;
  const route: EditorRoute = Object.assign((request: Parameters<RouteHandler>[0]): Promise<boolean> => {
    if (!request.path.startsWith("/api/editor/language")) return Promise.resolve(false);
    if (closed || pending >= 8) {
      routeError(request, closed ? 503 : 429, "Language service is busy or unavailable; retry shortly");
      return Promise.resolve(true);
    }
    pending += 1;
    const task = tail.then(async () => {
      if (closed) { routeError(request, 503, "Language service is disabled"); return true; }
      return execute(request);
    }).finally(() => { pending -= 1; });
    tail = task.catch(() => undefined);
    return task;
  }, { dispose: async () => {
    closed = true;
    await tail;
    for (const workspace of workspaces.values()) workspace.dispose();
    workspaces.clear();
  } });
  return route;
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let routes: RouteHandler | null = null;
  return {
    remoteAccess: localOnlyRemoteAccess(["editor"]),
    routes: async (request) => {
      routes ??= registerRoutes(host);
      return routes(request);
    },
    onDisable: async () => {
      if (routes) await (routes as EditorRoute).dispose();
      routes = null;
    },
  };
}
