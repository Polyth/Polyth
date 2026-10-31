// Package routes for the studio surface. Every request is scoped through the
// gateway-validated Space (`rc.space` → host.forSpace) and resolves the studio
// inside the session's own checkout; the studio id is the session id.
import { createReadStream } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RouteHandler, RouteRequest } from "@polyth/contracts";
import { workspaceExecutionPath } from "@polyth/contracts/workspace";
import type { ServerPackageHost } from "@polyth/plugins";
import { applyStudioPatch, normalizeStudioId, studioPaths, type StudioInit, type StudioPatch } from "../index.ts";
import { loadThreeSource } from "../render/renderer.ts";
import type { StudioService } from "./service.ts";
import { stateView } from "./tools.ts";
import type { StudioRef } from "./store.ts";

export const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus", ".webm"]);
const LYRICS_EXTENSIONS = new Set([".lrc", ".txt"]);
const MEDIA_TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac",
  ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".webm": "audio/webm",
};

const fail = (message: string, code: string) => Object.assign(new Error(message), { code });

export function studioRoutes(host: ServerPackageHost, service: () => StudioService | undefined): RouteHandler {
  async function resolveRef(rc: RouteRequest, projectId: unknown, sessionId: unknown): Promise<StudioRef> {
    const studioId = normalizeStudioId(sessionId);
    const { projects, sessions } = host.forSpace(rc.space);
    const project = await projects.get(String(projectId ?? ""));
    if (!project) throw fail("project not found", "not-found");
    if (project.remote) throw fail("Creative Studio renders locally; remote (SSH) projects are not supported yet", "unsupported");
    const session = await sessions.snapshot(studioId).catch(() => null);
    // A foreign or unknown session answers exactly like a missing one.
    if (!session || session.projectId !== project.id) throw fail("session not found", "not-found");
    return { cwd: workspaceExecutionPath(project, session), studioId };
  }

  const query = (rc: RouteRequest, key: string) => rc.url.searchParams.get(key) ?? undefined;

  async function readRaw(rc: RouteRequest, limit: number): Promise<Buffer> {
    const declared = Number(rc.req.headers["content-length"] ?? 0);
    if (declared > limit) throw fail(`upload is larger than ${Math.round(limit / 1024 / 1024)} MB`, "too-large");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of rc.req) {
      size += (chunk as Buffer).length;
      if (size > limit) throw fail(`upload is larger than ${Math.round(limit / 1024 / 1024)} MB`, "too-large");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  function sendError(rc: RouteRequest, error: unknown): true {
    const code = (error as { code?: string }).code;
    const status = code === "not-found" ? 404
      : code === "invalid-input" || code === "invalid-path" || code === "unsupported" ? 400
        : code === "too-large" ? 413
          : code === "conflict" || code === "busy" ? 409
            : code === "unavailable" ? 503
              : 500;
    rc.json(status, { error: code ?? "failed", message: (error as Error).message ?? "failed" });
    return true;
  }

  async function streamFile(rc: RouteRequest, file: string): Promise<void> {
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw fail("file not found", "not-found");
    const type = MEDIA_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(rc.req.headers.range ?? ""));
    const headers: Record<string, string> = {
      "content-type": type,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(info.size - 1, Number(range[2])) : info.size - 1;
      if (start >= info.size || start > end) {
        rc.res.writeHead(416, { "content-range": `bytes */${info.size}` });
        rc.res.end();
        return;
      }
      rc.res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${info.size}`, "content-length": String(end - start + 1) });
      await pipe(createReadStream(file, { start, end }), rc);
      return;
    }
    rc.res.writeHead(200, { ...headers, "content-length": String(info.size) });
    await pipe(createReadStream(file), rc);
  }

  function pipe(stream: ReturnType<typeof createReadStream>, rc: RouteRequest): Promise<void> {
    return new Promise((resolve) => {
      const done = () => resolve();
      stream.on("error", () => { rc.res.destroy(); done(); });
      rc.res.on("close", () => { stream.destroy(); done(); });
      stream.on("end", done);
      stream.pipe(rc.res);
    });
  }

  return async (rc) => {
    if (!rc.path.startsWith("/api/creative-studio/")) return false;
    const studio = service();
    if (!studio) {
      rc.json(503, { error: "unavailable", message: "Creative Studio is disabled" });
      return true;
    }
    const store = studio.store;
    try {
      const route = rc.path.slice("/api/creative-studio/".length);
      if (route === "vendor/three" && rc.method === "GET") {
        const source = await loadThreeSource();
        if (!source) throw fail("Three.js is not installed on this host", "unavailable");
        rc.res.writeHead(200, { "content-type": "application/json", "cache-control": "private, max-age=86400" });
        rc.res.end(JSON.stringify(source));
        return true;
      }
      if (route === "state" && rc.method === "GET") {
        const ref = await resolveRef(rc, query(rc, "projectId"), query(rc, "sessionId"));
        const revision = await store.revision(ref);
        if (revision && revision === query(rc, "since")) {
          rc.json(200, { unchanged: true, revision });
          return true;
        }
        const state = await studio.reconcile(ref);
        rc.json(200, { revision: await store.revision(ref), state, view: state ? stateView(state, studio) : null });
        return true;
      }
      if (route === "state" && rc.method === "POST") {
        const input = await rc.body();
        const ref = await resolveRef(rc, input.projectId, input.sessionId);
        if (input.init && typeof input.init === "object") {
          const { state } = await store.init(ref, input.init as StudioInit);
          rc.json(200, { state });
          return true;
        }
        if (!input.patch || typeof input.patch !== "object") throw fail("patch is required", "invalid-input");
        const state = await store.update(ref, (current) => applyStudioPatch(current, input.patch as StudioPatch, { defaultRole: "user" }));
        rc.json(200, { state });
        return true;
      }
      if (route === "analysis" && rc.method === "GET") {
        const ref = await resolveRef(rc, query(rc, "projectId"), query(rc, "sessionId"));
        rc.json(200, { analysis: await store.readAnalysis(ref) });
        return true;
      }
      if (route === "scenes" && rc.method === "GET") {
        const ref = await resolveRef(rc, query(rc, "projectId"), query(rc, "sessionId"));
        const state = await store.require(ref);
        rc.json(200, { codes: await store.readScenes(ref, state.scenes.map((scene) => scene.id)) });
        return true;
      }
      if (route === "media" && rc.method === "GET") {
        const ref = await resolveRef(rc, query(rc, "projectId"), query(rc, "sessionId"));
        const relative = String(query(rc, "path") ?? "");
        const paths = studioPaths(ref.studioId);
        const state = await store.read(ref);
        // Only studio outputs and the studio's own song are served here.
        const allowed = relative.startsWith(`${paths.stillsDir}/`) || relative.startsWith(`${paths.rendersDir}/`)
          || relative.startsWith(`${paths.audioDir}/`) || (state?.audio?.path === relative);
        if (!allowed || !MEDIA_TYPES[path.extname(relative).toLowerCase()]) throw fail("not a studio media file", "invalid-path");
        await streamFile(rc, await store.file(ref, relative));
        return true;
      }
      if (route === "upload" && rc.method === "POST") {
        const ref = await resolveRef(rc, query(rc, "projectId"), query(rc, "sessionId"));
        const rawName = path.basename(String(query(rc, "name") ?? "")).replace(/[^\w.\- ]+/g, "_").trim().slice(0, 80);
        const extension = path.extname(rawName).toLowerCase();
        const kind = AUDIO_EXTENSIONS.has(extension) ? "audio" : LYRICS_EXTENSIONS.has(extension) ? "lyrics" : null;
        if (!rawName || !kind) throw fail("upload an audio file (mp3, wav, m4a, flac, ogg) or lyrics (.lrc, .txt)", "invalid-input");
        const data = await readRaw(rc, kind === "lyrics" ? 64_000 : MAX_UPLOAD_BYTES);
        const relative = `${studioPaths(ref.studioId).audioDir}/${rawName}`;
        const file = await store.file(ref, relative);
        await mkdir(path.dirname(file), { recursive: true });
        const temp = `${file}.${Date.now().toString(36)}.part`;
        await writeFile(temp, data);
        await rename(temp, file);
        const existing = await store.read(ref);
        if (existing) {
          await store.update(ref, (current) => applyStudioPatch(current, {
            audio: kind === "audio" ? { path: relative } : { lyricsPath: relative },
            activity: [{ role: "user", message: kind === "audio" ? `Song added: ${rawName}` : `Lyrics added: ${rawName}`, stage: "brief" }],
          }, { defaultRole: "user" }));
        }
        rc.json(200, { path: relative, kind, size: data.length });
        return true;
      }
      if (route === "analyze" && rc.method === "POST") {
        const input = await rc.body();
        const ref = await resolveRef(rc, input.projectId, input.sessionId);
        rc.json(200, await studio.analyze(ref, {
          ...(typeof input.audioPath === "string" ? { audioPath: input.audioPath } : {}),
          ...(typeof input.lyricsText === "string" ? { lyricsText: input.lyricsText.slice(0, 20_000) } : {}),
        }));
        return true;
      }
      if (route === "render" && rc.method === "POST") {
        const input = await rc.body();
        const ref = await resolveRef(rc, input.projectId, input.sessionId);
        if (input.kind === "stills") {
          rc.json(200, await studio.renderStills(ref));
          return true;
        }
        if (input.kind !== "preview" && input.kind !== "final") throw fail("kind must be stills, preview or final", "invalid-input");
        rc.json(200, { job: await studio.startRender(ref, input.kind) });
        return true;
      }
      if (route === "render/cancel" && rc.method === "POST") {
        const input = await rc.body();
        const ref = await resolveRef(rc, input.projectId, input.sessionId);
        rc.json(200, { cancelled: await studio.cancelRender(ref, typeof input.jobId === "string" ? input.jobId : undefined) });
        return true;
      }
      return false;
    } catch (error) {
      return sendError(rc, error);
    }
  };
}
