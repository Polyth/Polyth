import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentCapabilityContributionRegistry,
  Disposable,
  BrowserAction,
  BrowserContextCaptureInput,
  JsonObject,
  RemoteAccessPolicy,
  RouteHandler,
  SessionEvent,
  SpaceStorage,
} from "@polyth/contracts";
import { REMOTE_CAPABILITY } from "@polyth/contracts";
import {
  SERVER_APPLICATION_SURFACE,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import {
  createBrowserArtifactStore,
  createBrowserService,
  createChromiumDriver,
  createFakeDriver,
  createFakeProfileDriver,
  createProfileChromiumDriver,
  createProfileRegistry,
  demoWeb,
  findChromiumExecutable,
  type BrowserArtifactStore,
  type BrowserService,
  type ProfileRegistry,
} from "./index.ts";
import { createBrowserAgentTool } from "./agentTool.ts";
import { readBrowserAgentAutoApprove, writeBrowserAgentAutoApprove } from "./agentToolSettings.ts";
import { originOf } from "./policy.ts";
import { isBrowserArtifactId } from "./artifacts.ts";

const STATUS: Record<string, number> = {
  "not-found": 404,
  "invalid-input": 400,
  "empty-text-range": 400,
  "invalid-url": 400,
  unavailable: 503,
  limit: 429,
  timeout: 504,
  "agent-paused": 409,
  "stale-frame": 409,
  conflict: 409,
  "context-closed": 410,
  "blocked-scheme": 403,
  "blocked-credentials": 403,
  "blocked-private": 403,
  "approval-required": 403,
  "download-blocked": 403,
  "dns-error": 502,
  forbidden: 403,
  "profile-locked": 409,
};

export function browserRoutes(deps: {
  browser: BrowserService;
  profiles?: ProfileRegistry;
  append: (sessionId: string, type: string, data: JsonObject) => Promise<SessionEvent>;
  shotsDir: string;
  artifacts: BrowserArtifactStore;
  storage?: SpaceStorage;
  canAccess?: (projectId: string, sessionId?: string) => Promise<boolean>;
}): RouteHandler {
  const { browser, profiles, append, artifacts } = deps;

  const rejectChatTab = (id: string): { error: string; message: string } | null => {
    if (profiles?.isChatTab(id)) {
      return {
        error: "forbidden",
        message: "chat-workspace-manual-only: agent browser APIs cannot control chat tabs",
      };
    }
    return null;
  };
  const saveShot = async (
    browserSessionId: string,
    revision: number,
    data: Uint8Array,
    mime: string,
  ): Promise<string> => {
    await mkdir(deps.shotsDir, { recursive: true });
    const name = `${browserSessionId}-${revision}.${mime.includes("webp") ? "webp" : "jpg"}`;
    await writeFile(join(deps.shotsDir, name), data);
    return name;
  };

  const parseCaptureInput = (raw: Record<string, unknown>): BrowserContextCaptureInput => {
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const expectedRevision = Number(raw.expectedRevision);
    const type = raw.type;
    const note = typeof raw.note === "string" ? raw.note : undefined;
    const includeScreenshot = typeof raw.includeScreenshot === "boolean" ? raw.includeScreenshot : undefined;
    if (!id || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw Object.assign(new Error("invalid browser context capture input"), { code: "invalid-input" });
    }
    if (type === "page") {
      return { type, id, expectedRevision, ...(includeScreenshot !== undefined ? { includeScreenshot } : {}), ...(note ? { note } : {}) };
    }
    if (type === "element") {
      const point = raw.point as { x?: unknown; y?: unknown } | undefined;
      const x = Number(point?.x);
      const y = Number(point?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw Object.assign(new Error("element point required"), { code: "invalid-input" });
      }
      return { type, id, expectedRevision, point: { x, y }, ...(includeScreenshot !== undefined ? { includeScreenshot } : {}), ...(note ? { note } : {}) };
    }
    if (type === "area") {
      const region = raw.region as Record<string, unknown> | undefined;
      const x = Number(region?.x);
      const y = Number(region?.y);
      const width = Number(region?.width);
      const height = Number(region?.height);
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
        throw Object.assign(new Error("area region required"), { code: "invalid-input" });
      }
      return {
        type,
        id,
        expectedRevision,
        region: { x, y, width, height },
        ...(includeScreenshot !== undefined ? { includeScreenshot } : {}),
        ...(note ? { note } : {}),
      };
    }
    if (type === "text") {
      const quote = typeof raw.quote === "string" ? raw.quote : undefined;
      const start = raw.start as { x?: unknown; y?: unknown } | undefined;
      const end = raw.end as { x?: unknown; y?: unknown } | undefined;
      const sx = Number(start?.x);
      const sy = Number(start?.y);
      const ex = Number(end?.x);
      const ey = Number(end?.y);
      const hasRange = [sx, sy, ex, ey].every(Number.isFinite);
      if (!(quote?.trim()) && !hasRange) {
        throw Object.assign(new Error("quote required"), { code: "invalid-input" });
      }
      return {
        type,
        id,
        expectedRevision,
        ...(quote ? { quote } : {}),
        ...(hasRange ? { start: { x: sx, y: sy }, end: { x: ex, y: ey } } : {}),
        ...(includeScreenshot !== undefined ? { includeScreenshot } : {}),
        ...(note ? { note } : {}),
      };
    }
    throw Object.assign(new Error("unknown browser context type"), { code: "invalid-input" });
  };

  return async ({ path, method, url, body, json, res }) => {
    try {
      const ownedId = path.match(/^\/api\/browser\/sessions\/([^/]+)/)?.[1];
      if (ownedId && deps.canAccess) {
        const owned = browser.get(ownedId);
        if (!owned || !await deps.canAccess(owned.projectId, owned.sessionId)) {
          json(404, { error: "not-found" });
          return true;
        }
      }
      if (path === "/api/browser/capability" && method === "GET") {
        json(200, browser.capability());
        return true;
      }
      if (path === "/api/browser/agent-auto-approve" && method === "GET") {
        if (!deps.storage) {
          json(503, { error: "unavailable" });
          return true;
        }
        json(200, { enabled: await readBrowserAgentAutoApprove(deps.storage) });
        return true;
      }
      if (path === "/api/browser/agent-auto-approve" && (method === "PATCH" || method === "POST")) {
        if (!deps.storage) {
          json(503, { error: "unavailable" });
          return true;
        }
        const input = await body();
        if (typeof input.enabled !== "boolean") {
          json(400, { error: "invalid-input", message: "enabled boolean required" });
          return true;
        }
        const saved = await writeBrowserAgentAutoApprove(deps.storage, input.enabled);
        json(200, saved);
        return true;
      }
      if (path === "/api/browser/artifacts" && method === "GET") {
        const id = url.searchParams.get("id") ?? "";
        if (!isBrowserArtifactId(id)) {
          json(400, { error: "invalid-input", message: "artifact id required" });
          return true;
        }
        const art = await artifacts.read(id);
        if (!art) {
          json(404, { error: "not-found", message: "artifact not found" });
          return true;
        }
        res.writeHead(200, {
          "content-type": art.mime,
          "content-length": art.size,
          "cache-control": "private, max-age=3600",
          "x-content-type-options": "nosniff",
        });
        res.end(Buffer.from(art.data));
        return true;
      }
      if (path === "/api/browser/artifacts" && method === "DELETE") {
        const id = url.searchParams.get("id") ?? "";
        if (!isBrowserArtifactId(id)) {
          json(400, { error: "invalid-input", message: "artifact id required" });
          return true;
        }
        const removed = await artifacts.remove(id);
        json(200, { ok: true, ...(removed ? {} : { retained: true }) });
        return true;
      }
      if (path === "/api/browser/approvals" && method === "GET") {
        const id = url.searchParams.get("browserSessionId") ?? "";
        const session = browser.get(id);
        if (!session || (deps.canAccess && !await deps.canAccess(session.projectId, session.sessionId))) {
          json(404, { error: "not-found" }); return true;
        }
        json(200, { origins: browser.approvals(id) });
        return true;
      }
      if (path === "/api/browser/approvals" && method === "POST") {
        const input = await body();
        const id = String(input.browserSessionId ?? "");
        const session = browser.get(id);
        if (!session || (deps.canAccess && !await deps.canAccess(session.projectId, session.sessionId))) {
          json(404, { error: "not-found" }); return true;
        }
        browser.approveOrigin(String(input.origin ?? ""), id);
        json(200, { origins: browser.approvals(id) });
        return true;
      }
      if (path === "/api/browser/sessions" && method === "GET") {
        const projectId = url.searchParams.get("projectId");
        const all = browser.list().filter((session) => !projectId || session.projectId === projectId);
        const visible = await Promise.all(all.map(async (session) =>
          !deps.canAccess || await deps.canAccess(session.projectId, session.sessionId) ? session : null));
        json(200, visible.filter(Boolean));
        return true;
      }
      if (path === "/api/browser/sessions" && method === "POST") {
        const input = await body();
        if (deps.canAccess && !await deps.canAccess(String(input.projectId ?? ""), typeof input.sessionId === "string" ? input.sessionId : undefined)) {
          json(404, { error: "not-found" });
          return true;
        }
        const viewport = input.viewport as { width?: number; height?: number } | undefined;
        const colorScheme = input.colorScheme === "light"
          || input.colorScheme === "dark"
          || input.colorScheme === "no-preference"
          ? input.colorScheme
          : undefined;
        if (input.colorScheme !== undefined && !colorScheme) {
          json(400, {
            error: "invalid-input",
            message: "colorScheme must be light, dark, or no-preference",
          });
          return true;
        }
        const target = String(input.url ?? "");
        const session = await browser.create({
          projectId: String(input.projectId ?? ""),
          ...(input.sessionId ? { sessionId: String(input.sessionId) } : {}),
          ...(target ? { url: target } : {}),
          ...(viewport && typeof viewport.width === "number" && typeof viewport.height === "number"
            ? { viewport: { width: viewport.width, height: viewport.height } }
            : {}),
          ...(colorScheme ? { colorScheme } : {}),
        });
        // If a URL was requested but the session stayed at about:blank, the
        // initial navigation needed approval — surface it to the client.
        if (target && session.url === "about:blank") {
          json(200, {
            session,
            approval: { origin: originOf(target) ?? target, message: `external origin ${originOf(target) ?? target} needs a per-origin approval` },
          });
        } else {
          json(200, session);
        }
        return true;
      }

      let       match = path.match(/^\/api\/browser\/sessions\/([^/]+)$/);
      if (match && method === "GET") {
        const blocked = rejectChatTab(match[1]!);
        if (blocked) { json(403, blocked); return true; }
        const session = browser.get(match[1]!);
        json(session ? 200 : 404, session ?? { error: "not-found" });
        return true;
      }
      if (match && method === "DELETE") {
        const blocked = rejectChatTab(match[1]!);
        if (blocked) { json(403, blocked); return true; }
        await browser.close(match[1]!);
        json(200, { ok: true });
        return true;
      }

      match = path.match(/^\/api\/browser\/sessions\/([^/]+)\/navigate$/);
      if (match && method === "POST") {
        const blocked = rejectChatTab(match[1]!);
        if (blocked) { json(403, blocked); return true; }
        const id = match[1]!;
        const input = await body();
        const actor = input.actor === "agent" ? "agent" as const : "user" as const;
        const target = String(input.url ?? "");
        try {
          const session = await browser.navigate(id, target, actor);
          json(200, session);
        } catch (error) {
          const failure = error as Error & { code?: string };
          // A user navigation that needs approval is an expected product flow,
          // not a failed transport request. Keep the durable failed-action
          // record, but let the client open its approval dialog without a
          // noisy 403 in the browser console.
          if (actor === "user" && failure.code === "approval-required") {
            json(200, {
              session: browser.get(id),
              approval: { origin: originOf(target) ?? target, message: failure.message },
            });
          } else {
            json(STATUS[failure.code ?? ""] ?? 500, {
              error: failure.code ?? "internal",
              message: failure.message,
            });
          }
        }
        return true;
      }

      match = path.match(/^\/api\/browser\/sessions\/([^/]+)\/actions$/);
      if (match && method === "POST") {
        const blocked = rejectChatTab(match[1]!);
        if (blocked) { json(403, blocked); return true; }
        const id = match[1]!;
        const input = await body();
        const actor = input.actor === "agent" ? "agent" as const : "user" as const;
        const action = input.action as BrowserAction | undefined;
        if (!action || typeof action !== "object" || !("kind" in action)) {
          json(400, { error: "invalid-input", message: "action required" });
          return true;
        }
        try {
          const { actionId, session, result } = await browser.action(id, action, actor);
          json(200, { actionId, session, ...(result ? { result } : {}) });
        } catch (error) {
          const failure = error as Error & { code?: string };
          json(STATUS[failure.code ?? ""] ?? 500, {
            error: failure.code ?? "internal",
            message: failure.message,
          });
        }
        return true;
      }

      match = path.match(/^\/api\/browser\/sessions\/([^/]+)\/observe$/);
      if (match && method === "POST") {
        const blocked = rejectChatTab(match[1]!);
        if (blocked) { json(403, blocked); return true; }
        const id = match[1]!;
        const input = await body();
        const observation = await browser.observe(id, {
          includeScreenshot: input.includeScreenshot === true,
          ...(typeof input.selector === "string" && input.selector.trim()
            ? { selector: input.selector }
            : {}),
        });
        let screenshotRef: string | undefined;
        if (observation.screenshot) {
          screenshotRef = await saveShot(
            id,
            browser.get(id)?.revision ?? 0,
            observation.screenshot.data,
            observation.screenshot.mime,
          );
        }
        const payload = {
          url: observation.url,
          title: observation.title,
          text: observation.text,
          accessibilityDigest: observation.accessibilityDigest ?? "",
          ...(screenshotRef ? { screenshotRef } : {}),
        };
        json(200, {
          ...payload,
          ...(observation.screenshot ? {
            screenshot: {
              mime: observation.screenshot.mime,
              data: Buffer.from(observation.screenshot.data).toString("base64"),
            },
          } : {}),
        });
        return true;
      }

      match = path.match(/^\/api\/browser\/sessions\/([^/]+)\/context$/);
      if (match && method === "POST") {
        const blocked = rejectChatTab(match[1]!);
        if (blocked) { json(403, blocked); return true; }
        const id = match[1]!;
        const input = parseCaptureInput(await body());
        const context = await browser.captureContext(id, input, artifacts);
        const linked = browser.get(id)?.sessionId;
        if (linked) {
          await append(linked, "browser/context-captured", {
            browserSessionId: id,
            contextId: context.id,
            type: context.type,
            url: context.url,
            title: context.title,
            frameRevision: context.frameRevision,
            ...(context.screenshot ? { screenshotId: context.screenshot.id } : {}),
            ...(context.crop ? { cropId: context.crop.id } : {}),
          });
        }
        json(200, { context });
        return true;
      }

      match = path.match(/^\/api\/browser\/sessions\/([^/]+)\/pause-agent$/);
      if (match && method === "POST") {
        const input = await body();
        browser.pauseAgent(match[1]!, input.paused !== false);
        json(200, { ok: true, paused: browser.agentPaused(match[1]!) });
        return true;
      }
      match = path.match(/^\/api\/browser\/sessions\/([^/]+)\/console$/);
      if (match && method === "GET") {
        json(200, browser.console(match[1]!));
        return true;
      }
      match = path.match(/^\/api\/browser\/sessions\/([^/]+)\/frame$/);
      if (match && method === "GET") {
        const frame = browser.latestFrame(
          match[1]!,
          Number(url.searchParams.get("afterRevision") ?? 0),
        );
        if (!frame) {
          json(204, {});
          return true;
        }
        json(200, {
          revision: frame.revision,
          mime: frame.mime,
          data: Buffer.from(frame.data).toString("base64"),
        });
        return true;
      }
      return false;
    } catch (error) {
      const failure = error as Error & { code?: string };
      json(STATUS[failure.code ?? ""] ?? 500, {
        error: failure.code ?? "internal",
        message: failure.message,
      });
      return true;
    }
  };
}

export const BROWSER_REMOTE_ACCESS: RemoteAccessPolicy = {
  routeScopes: ["browser"],
  http: [
    { methods: ["GET"], path: "/api/browser/capability", capability: REMOTE_CAPABILITY.browserUse, mutation: false },
    { methods: ["GET"], path: "/api/browser/agent-auto-approve", capability: REMOTE_CAPABILITY.browserUse, mutation: false },
    { methods: ["PATCH", "POST"], path: "/api/browser/agent-auto-approve", capability: REMOTE_CAPABILITY.browserUse, mutation: true },
    { methods: ["GET"], path: "/api/browser/approvals", capability: REMOTE_CAPABILITY.browserUse, mutation: false },
    { methods: ["POST"], path: "/api/browser/approvals", capability: REMOTE_CAPABILITY.browserUse, mutation: true },
    { methods: ["GET"], path: "/api/browser/sessions", capability: REMOTE_CAPABILITY.browserUse, mutation: false },
    { methods: ["POST"], path: "/api/browser/sessions", capability: REMOTE_CAPABILITY.browserUse, mutation: true },
    { methods: ["GET"], path: "/api/browser/sessions/:id", capability: REMOTE_CAPABILITY.browserUse, mutation: false },
    { methods: ["DELETE"], path: "/api/browser/sessions/:id", capability: REMOTE_CAPABILITY.browserUse, mutation: true },
    { methods: ["POST"], path: "/api/browser/sessions/:id/navigate", capability: REMOTE_CAPABILITY.browserUse, mutation: true },
    { methods: ["POST"], path: "/api/browser/sessions/:id/actions", capability: REMOTE_CAPABILITY.browserUse, mutation: true },
    { methods: ["POST"], path: "/api/browser/sessions/:id/observe", capability: REMOTE_CAPABILITY.browserUse, mutation: true },
    { methods: ["POST"], path: "/api/browser/sessions/:id/context", capability: REMOTE_CAPABILITY.browserUse, mutation: true },
    { methods: ["POST"], path: "/api/browser/sessions/:id/pause-agent", capability: REMOTE_CAPABILITY.browserUse, mutation: true },
    { methods: ["GET"], path: "/api/browser/sessions/:id/console", capability: REMOTE_CAPABILITY.browserUse, mutation: false },
    { methods: ["GET"], path: "/api/browser/sessions/:id/frame", capability: REMOTE_CAPABILITY.browserUse, mutation: false },
    { methods: ["GET"], path: "/api/browser/artifacts", capability: REMOTE_CAPABILITY.browserUse, mutation: false },
    { methods: ["DELETE"], path: "/api/browser/artifacts", capability: REMOTE_CAPABILITY.browserUse, mutation: true },
  ],
};

export default async function registerPackage(host: ServerPackageHost): Promise<ServerPackage> {
  const chromiumPath = process.env.POLYTH_FAKE_BROWSER === "1" ? null : await findChromiumExecutable();
  const driver = process.env.POLYTH_FAKE_BROWSER === "1"
    ? createFakeDriver(demoWeb())
    : chromiumPath
      ? createChromiumDriver(chromiumPath)
      : null;
  const profileDriver = process.env.POLYTH_FAKE_BROWSER === "1"
    ? createFakeProfileDriver()
    : await createProfileChromiumDriver(chromiumPath ?? undefined);
  const profiles = createProfileRegistry({
    driver: profileDriver,
    unavailableReason: "browser engine unavailable: no Chromium executable found (set POLYTH_CHROMIUM_PATH)",
  });
  const browser = createBrowserService({
    driver,
    unavailableReason: "Browser engine unavailable. Install a supported desktop build or configure Chromium for development.",
    allowPublicOrigins: true,
    // Resolve this on every hop: auth can change while a context is alive.
    // The server exposes only its exact login origin and only while cookie-less
    // loopback requests cannot inherit ambient operator/Space authority.
    exactAllowedOrigins: () => {
      const origin = host.services.get(SERVER_APPLICATION_SURFACE)
        ?.controlledBrowserLoginOrigin();
      return origin ? [origin] : [];
    },
    append: (sessionId, type, data) => host.events.append(sessionId, type, data, { ignorable: true, producerPlugin: "browser" }),
  });
  host.services.provide(serverServiceKey<BrowserService>("browser"), browser);
  host.services.provide(serverServiceKey<ProfileRegistry>("browser.profiles"), profiles);
  let routes: RouteHandler | null = null;
  let agentTool: Disposable | undefined;
  return {
    remoteAccess: BROWSER_REMOTE_ACCESS,
    routes: async (request) => routes ? routes(request) : false,
    onEnable() {
      const capabilities = host.services.require(serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"));
      agentTool = capabilities.register("browser", createBrowserAgentTool(browser));
      routes = async (request) => {
        if (!request.path.startsWith("/api/browser/")) return false;
        const scoped = host.forSpace(request.space);
        const storage = host.spaceStorage(request.space);
        return browserRoutes({
          browser, profiles,
          storage,
          canAccess: async (projectId, sessionId) => {
            try {
              if (!await scoped.projects.get(projectId)) return false;
              return !sessionId || (await scoped.sessions.snapshot(sessionId)).projectId === projectId;
            } catch { return false; }
          },
          append: (sessionId, type, data) => host.events.append(sessionId, type, data, { ignorable: true, producerPlugin: "browser" }),
          shotsDir: storage.path("browser-shots"),
          artifacts: createBrowserArtifactStore(storage.path("browser-artifacts")),
        })(request);
      };
    },
    async onDisable() {
      agentTool?.dispose();
      agentTool = undefined;
      routes = null;
      await browser.closeAll();
      await profiles.closeAll();
    },
  };
}
