// Polyth server boot. Composition root: kernel context + plugins + gateway.
//
// Feature packages are NOT imported here. Every workspace package that
// declares a polyth.serverEntry marker is discovered at boot, constructs its
// own services, and publishes them in the shared service registry
// (serverServiceKey). This file only composes infrastructure (session store,
// runtime pool, HTTP/WS gateway) plus the few genuinely cross-cutting seams
// (session service wiring, track workflow, browser-tool bridge).
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, loadPlugin } from "@polyth/kernel";
import {
  activePinnedMessages,
  compactionRecoveryText,
  createStore,
  deriveMessages,
  unrestoredCompactionSeq,
} from "@polyth/session";
import { CAP, SERVER_CAPABILITY_IDS, type AgentRuntime, type Disposable, type RemoteHost, type RuntimeEvent, type SessionEvent, type SessionProjection, type SessionService } from "@polyth/contracts";
import {
  createBrowserToolBridge,
  createConfigApplier,
  createOpenCodeRuntime,
  createRemoteOpenCodeRuntime,
  probeRemoteOpenCode,
  type OpenCodeAdapterOptions,
} from "@polyth/backend-opencode";
import {
  createServerServiceRegistry,
  discoverServerPackages,
  serverServiceKey,
  type HttpServerContext,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createProjectService } from "./projects.ts";
import { projectRoutes } from "./routes/projects.ts";
import { createPackageRegistry } from "./packages.ts";
import { createSessionService, type Broadcaster, type RuntimePool } from "./sessions.ts";
import { resolveSessionRuntimeBinding } from "./sessionRuntime.ts";
import { createRuntimeCatalog } from "./runtimeCatalog.ts";
import { createHttpServer, type RouteHandler } from "./http.ts";
import { packageRoutes } from "./routes/packages.ts";
import { contextRoutes } from "./routes/context.ts";
import { orgRoutes } from "./routes/org.ts";
import { sessionRetentionRoutes } from "./routes/sessionRetention.ts";
import { controlRoutes } from "./routes/control.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { opencodePendingRoutes } from "./routes/opencodePending.ts";
import { browseRoutes } from "./routes/browse.ts";
import { createAuthService } from "./auth.ts";
import { authRoutes } from "./routes/auth.ts";
import { createPushNotifier, createPushService } from "./push.ts";
import { pushRoutes } from "./routes/push.ts";
import { createNotificationStore } from "./notifications.ts";
import { notificationRoutes } from "./routes/notifications.ts";
import { registerDiscoveredPackages } from "./packageDiscovery.ts";
import { queueRoutes } from "./routes/queue.ts";
import { createBehaviorService } from "./behavior.ts";
import { createMcpConfigService, mcpEntriesFromBackendConfig } from "./mcp.ts";
import { createSecureSafeService, secureSafeBehaviorSection } from "./secureSafe.ts";
import { createModelVisibilityService } from "./modelVisibility.ts";
import { createVoiceSettings } from "./voice.ts";
import { buildNotePrompt, createAssistService, createAssistSettings, parseNoteReply, type AssistService } from "./assist.ts";
import { assistRoutes } from "./routes/assist.ts";
import { oneShot } from "./oneshot.ts";
import { attachWs } from "./ws.ts";
import { createTrackWorkflow, type TrackWorkflow, type TrackWorkflowDeps } from "./tracks.ts";
import { createRouteRegistry } from "./routeRegistry.ts";
import { createPackageLifecycle } from "./packageLifecycle.ts";
import { createDeferredConfigApplier, createOpenCodePendingService } from "./opencodePending.ts";
import { agentSessionRoutes, type AgentGoalService } from "./routes/agentSessions.ts";

/** POLYTH_SMALL_MODEL="provider/model-id" — cheap model for auditors/commit messages. */
const smallModel = (): { providerID: string; modelID: string } | undefined => {
  const raw = process.env.POLYTH_SMALL_MODEL;
  if (!raw || !raw.includes("/")) return undefined;
  const i = raw.indexOf("/");
  return { providerID: raw.slice(0, i), modelID: raw.slice(i + 1) };
};

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface BootOptions {
  port?: number;
  dataDir?: string;
  /** Optional listen address. The desktop host pins this to loopback. */
  hostname?: string;
  /** Static SPA directory override for packaged hosts. */
  webDist?: string;
  opencode?: Partial<OpenCodeAdapterOptions>;
  /** Workspace packages/ directory scanned for polyth.serverEntry markers. */
  packagesDir?: string;
}

export { isPackageEnabled } from "./packages.ts";

// ---- structural views of package-owned services -----------------------------------
// The composition root never imports feature packages; where it consumes their
// services it declares only the surface it calls. Richer types flow through
// tracks.ts (which type-imports the real service interfaces).

type SessionDeps = Parameters<typeof createSessionService>[0];

/** @polyth/ssh's transport surface used by the runtime pool and shutdown. */
interface SshTransportService {
  host(connectionId: string): RemoteHost;
  disconnectAll(): Promise<void>;
}

/** @polyth/commands' expansion surface consumed by the session service. */
interface CommandExpandService {
  expand(root: string, text: string): Promise<{ text: string; raw: string; agent?: string; model?: string }>;
}

type BrowserForWs = NonNullable<Parameters<typeof attachWs>[2]>;
type DictationForWs = NonNullable<Parameters<typeof attachWs>[3]>;

export async function boot(opts: BootOptions = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 4400);
  opts.hostname ??= process.env.HOST;
  const dataDir = resolve(opts.dataDir ?? process.env.POLYTH_DATA_DIR ?? "./data");
  const packagesDir = opts.packagesDir ?? resolve(__dirname, "../..");
  const discoveredPackageManifests = await discoverServerPackages(packagesDir);
  mkdirSync(dataDir, { recursive: true });
  const routeRegistry = createRouteRegistry();
  const packageLifecycle = createPackageLifecycle(routeRegistry);

  // Sessions and package transitions can emit before WS attaches. This box
  // starts forwarding as soon as the live broadcaster is installed.
  let live: Broadcaster | null = null;
  const broadcast: Broadcaster = {
    event: (e: SessionEvent) => live?.event(e),
    projection: (p: SessionProjection) => live?.projection(p),
    notification: (n) => live?.notification?.(n),
    pluginChanged: (plugin) => live?.pluginChanged?.(plugin),
    packageChanged: (pkg) => live?.packageChanged?.(pkg),
  };
  const packageRegistry = createPackageRegistry({
    file: `${dataDir}/packages.json`,
    descriptors: discoveredPackageManifests.map((pkg) => pkg.descriptor),
    onSetEnabled: (id, enabled) => enabled
      ? packageLifecycle.enable(id)
      : packageLifecycle.disable(id),
    onChanged: (pkg) => broadcast.packageChanged?.(pkg),
  });

  // --- kernel composition root
  const root = createContext("root");
  const store = createStore(`${dataDir}/sessions.db`);
  root.provide(CAP.sessionPersistence, store);
  const projects = createProjectService(dataDir);
  root.provide(CAP.projects, projects);

  // --- cross-package service seam. Discovered packages publish the services
  // they construct here; the composition root publishes the infrastructure
  // seams packages consume. Everything cross-package resolves lazily.
  const services = createServerServiceRegistry();
  const provideService = <T,>(name: string, service: T): void =>
    services.provide(serverServiceKey<T>(name), service);
  const svc = <T,>(name: string): T | undefined => services.get(serverServiceKey<T>(name));
  const requireSvc = <T,>(name: string): T => services.require(serverServiceKey<T>(name));

  // --- per-project opencode runtime pool (lazy spawn, one serve process per project)
  const runtimesByProject = new Map<string, Promise<AgentRuntime>>();
  const runtimeRestarters = new Map<string, () => Promise<void>>();
  const sessionIdMap = new Map<string, string>(); // canonical -> backend

  const isTransportError = (err: unknown): boolean =>
    /fetch failed|terminated|ECONNRESET|ECONNREFUSED/i.test(
      err instanceof Error ? `${err.message} ${String(err.cause ?? "")}` : String(err),
    );

  // The pool key must be the *resolved* cwd, never the raw argument: callers
  // that only know the project (`/api/models`) and callers that also pass the
  // project path (session start) address the same working tree. Keying them
  // apart spawned two `opencode serve` for one cwd, and the second spawn reaps
  // the first through the cwd-keyed pidfile — leaving the surviving facade
  // pointing at a killed process, so model/agent lookups came back empty.
  const cwdFor = async (projectId: string, cwd?: string): Promise<string> =>
    cwd ?? (await projects.get(projectId))?.path ?? process.cwd();

  // The bridge is created after package discovery (it consumes the browser
  // package's service) but the pool only spawns runtimes after boot completes.
  let browserToolBridge: ReturnType<typeof createBrowserToolBridge> | null = null;

  const spawnRuntime = async (projectId: string, cwd: string): Promise<AgentRuntime> => {
    // Remote-bound projects run `opencode serve` ON the remote host through
    // the SSH transport (one multiplexed channel + one forwarded port). The
    // browser-tool bridge is a local loopback endpoint the remote cannot
    // reach, so it is not registered for remote runtimes.
    const remoteBinding = (await projects.get(projectId))?.remote;
    if (remoteBinding?.kind === "ssh") {
      const ssh = svc<SshTransportService>("ssh");
      if (!ssh) {
        throw Object.assign(new Error("SSH support unavailable: the ssh package did not load"), { code: "unavailable" });
      }
      return createRemoteOpenCodeRuntime({
        host: ssh.host(remoteBinding.connectionId),
        remotePath: cwd,
        sessionIdMap,
      });
    }
    const browserTool = browserToolBridge?.register({ projectId, cwd });
    try {
      const runtime = await createOpenCodeRuntime({
        cwd, sessionIdMap,
        ...(opts.opencode?.port ? { port: opts.opencode.port } : {}),
        ...(opts.opencode?.bin ? { bin: opts.opencode.bin } : {}),
        ...(opts.opencode?.hostname ? { hostname: opts.opencode.hostname } : {}),
        ...(browserTool ? {
          browserTool: {
            endpoint: `http://127.0.0.1:${port}/internal/opencode/browser-tool`,
            token: browserTool.token,
            pluginDirectory: `${dataDir}/opencode-tools`,
          },
        } : {}),
      });
      const dispose = runtime.dispose.bind(runtime);
      runtime.dispose = async () => {
        browserTool?.dispose();
        await dispose();
      };
      return runtime;
    } catch (error) {
      browserTool?.dispose();
      throw error;
    }
  };

  // Stable facade per pool key: when ensureSession dies with a transport error
  // (serve process gone / poisoned socket), drop the cached promise, respawn,
  // and retry once. Callers keep the same handle, so listeners wired against
  // it keep receiving events from the fresh runtime.
  const facadeFor = (key: string, projectId: string, cwd: string, first: AgentRuntime): AgentRuntime => {
    let inner = first;
    const listeners = new Set<(sessionId: string, ev: RuntimeEvent) => void>();
    const fanout = (sessionId: string, ev: RuntimeEvent) => { for (const cb of listeners) cb(sessionId, ev); };
    let innerSub = inner.onEvent(fanout);
    let restarting: Promise<void> | null = null;

    const respawnOnce = async (): Promise<void> => {
      innerSub.dispose();
      await inner.dispose().catch(() => {});
      inner = await spawnRuntime(projectId, cwd);
      innerSub = inner.onEvent(fanout);
      runtimesByProject.set(key, Promise.resolve(facade));
    };
    const respawn = (): Promise<void> => {
      if (!restarting) {
        restarting = respawnOnce().finally(() => { restarting = null; });
      }
      return restarting;
    };

    // Read-only lookups are idempotent, so they get the same respawn-once
    // recovery as ensureSession: a serve process that died between requests
    // must not blank the model/agent pickers until the next session start.
    const reviving = async <T>(what: string, call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (err) {
        if (!isTransportError(err)) throw err;
        console.warn(`[polyth] opencode transport error for ${key} (${what}); respawning`, err);
        await respawn();
        return call();
      }
    };

    const facade: AgentRuntime = {
      capabilities: () => inner.capabilities(),
      models: () => reviving("models", () => inner.models()),
      agents: () => reviving("agents", () => inner.agents()),
      sessions: () => reviving("sessions", () => inner.sessions()),
      history: (sessionId) => reviving("history", () => inner.history(sessionId)),
      ensureSession: (canonical) => reviving("ensureSession", () => inner.ensureSession(canonical)),
      async resetSession(canonical) {
        if (!inner.resetSession) throw Object.assign(new Error("runtime cannot reset session history"), { code: "unsupported" });
        return reviving("resetSession", () => {
          if (!inner.resetSession) throw Object.assign(new Error("runtime cannot reset session history"), { code: "unsupported" });
          return inner.resetSession(canonical);
        });
      },
      // UX-MSG-ACTIONS: exact-history branching passes through the facade so
      // the session service never learns backend/OpenCode details.
      async branchSession(request) {
        if (!inner.branchSession) throw Object.assign(new Error("runtime cannot branch exact history"), { code: "unsupported" });
        return reviving("branchSession", () => {
          if (!inner.branchSession) throw Object.assign(new Error("runtime cannot branch exact history"), { code: "unsupported" });
          return inner.branchSession(request);
        });
      },
      async discardSession(sessionId) {
        // best-effort by contract: an unreachable backend must not turn a
        // clean fork failure into a second error.
        await inner.discardSession?.(sessionId).catch(() => {});
      },
      startTurn: (req) => inner.startTurn(req),
      abort: (sessionId) => inner.abort(sessionId),
      replyPermission: (sessionId, requestId, reply) => inner.replyPermission(sessionId, requestId, reply),
      replyQuestion: (sessionId, requestId, answers) => inner.replyQuestion(sessionId, requestId, answers),
      ...(inner.replySecret
        ? { replySecret: (sessionId: string, requestId: string, result: Parameters<NonNullable<AgentRuntime["replySecret"]>>[2]) =>
            inner.replySecret!(sessionId, requestId, result) }
        : {}),
      onEvent(cb) {
        listeners.add(cb);
        return { dispose: () => { listeners.delete(cb); } };
      },
      dispose: () => {
        runtimesByProject.delete(key);
        runtimeRestarters.delete(key);
        innerSub.dispose();
        return inner.dispose();
      },
    };
    runtimeRestarters.set(key, respawn);
    return facade;
  };

  const runtimes: RuntimePool = {
    async forProject(projectId, cwd) {
      const dir = await cwdFor(projectId, cwd);
      const key = `${projectId}::${dir}`;
      let p = runtimesByProject.get(key);
      if (!p) {
        p = (async () => {
          try {
            return facadeFor(key, projectId, dir, await spawnRuntime(projectId, dir));
          } catch (err) {
            if (!isTransportError(err)) throw err;
            return facadeFor(key, projectId, dir, await spawnRuntime(projectId, dir)); // one respawn retry
          }
        })();
        runtimesByProject.set(key, p);
        p.catch(() => runtimesByProject.delete(key)); // allow retry
      }
      return p;
    },
    async restartAll() {
      const restarters = [...runtimeRestarters.values()];
      await Promise.all(restarters.map((restart) => restart()));
      return restarters.length;
    },
  };
  const runtimeCatalog = createRuntimeCatalog({ projects, runtimes });

  const parseModel = (raw?: string) => {
    if (!raw || !raw.includes("/")) return undefined;
    const i = raw.indexOf("/");
    return { providerID: raw.slice(0, i), modelID: raw.slice(i + 1) };
  };

  // --- goals workflow package (listens on the turn seam, never touches the
  // loop). The service itself lives in @polyth/goals and is resolved lazily.
  let trackWorkflow: TrackWorkflow | null = null;
  // F9 idle assist: created after `sessions` (it needs the runtime resolver);
  // the turn hook below only pings it, so a late assignment is safe.
  let assist: AssistService | null = null;
  const goalService = () => svc<TrackWorkflowDeps["goals"]>("goals");
  const ensureGoalState = async (sessionId: string) => {
    const goals = goalService();
    if (!goals) return null;
    const known = goals.get(sessionId);
    if (known) return known;
    return goals.rehydrate(sessionId, await store.events(sessionId)); // survives restart
  };

  // Streaming dictation (WP15/F8): the settings live here (server-owned data
  // dir); the dictation package builds its adapter from them on every call.
  const voiceSettings = createVoiceSettings({ file: `${dataDir}/voice.json` });
  provideService("voice.settings", voiceSettings);

  // --- WP9: behavior instructions, MCP config, managed plugins (adapter-applied)
  const directConfigApplier = createConfigApplier();
  const pendingOpenCode = createOpenCodePendingService({
    restart: () => runtimes.restartAll?.() ?? Promise.resolve(0),
  });
  const configApplier = createDeferredConfigApplier(directConfigApplier, pendingOpenCode);
  let refreshSafeBehavior: () => Promise<void> = async () => {};
  const secureSafe = createSecureSafeService({
    dataDir,
    onChanged: () => refreshSafeBehavior(),
  });
  const decorateBehavior = (text: string): string => {
    const base = text.trimEnd();
    const section = secureSafeBehaviorSection(`${dataDir}/forbidden-config.json`, secureSafe.manifest());
    return `${base}${base ? "\n\n" : ""}${section}\n`;
  };
  const behavior = createBehaviorService({
    file: `${dataDir}/behavior.md`,
    applier: configApplier,
    decorate: decorateBehavior,
  });
  refreshSafeBehavior = async () => {
    try {
      await configApplier.applyBehavior(decorateBehavior((await behavior.get()).text));
    } catch (err) {
      console.warn("[polyth] Secure Safe behavior refresh skipped", err);
    }
  };
  await secureSafe.syncForbiddenConfig();
  await refreshSafeBehavior();
  const mcp = createMcpConfigService({ file: `${dataDir}/mcp.json`, applier: configApplier });

  // Provider/model visibility: seeds from opencode.json (disabled_providers +
  // provider blacklists), then mirrors every toggle back to it.
  const visibility = createModelVisibilityService({ file: `${dataDir}/model-visibility.json`, applier: configApplier });
  await visibility.seed();

  // An empty Polyth MCP store adopts whatever OpenCode already has configured,
  // so the settings page reflects reality instead of an empty list.
  if (mcp.list().length === 0) {
    try {
      for (const entry of mcpEntriesFromBackendConfig(await configApplier.readConfig())) {
        await mcp.create(entry).catch((err: unknown) =>
          console.warn(`[polyth] MCP seed skipped for "${entry.name}"`, err));
      }
    } catch (err) {
      console.warn("[polyth] MCP seed from backend config skipped", err);
    }
  }
  // Boot reconciliation happens before any runtime can be created. From this
  // point on, user mutations are staged until the unified apply/restart action.
  configApplier.enableStaging();

  // Infrastructure seams consumed by discovered packages.
  provideService("secure-safe", secureSafe);
  provideService("plugins.config", configApplier);
  // The probe stays bound here so no feature package ever imports
  // backend-opencode; routes consuming it never learn OpenCode specifics.
  provideService("ssh.probe-runtime", async (connectionId: string) => {
    const ssh = svc<SshTransportService>("ssh");
    if (!ssh) {
      throw Object.assign(new Error("SSH support unavailable: the ssh package did not load"), { code: "unavailable" });
    }
    return probeRemoteOpenCode(ssh.host(connectionId));
  });

  // --- F18: web push (VAPID keys minted once into the data dir) + the
  // notifier bridging the session service's attention/turn-stopped seam.
  // Auto-accepted permissions never reach this seam, so they never push.
  const push = createPushService({ file: `${dataDir}/push.json` });
  // NTF-01: durable inbox recorded at the ONE transition-tight seam — the
  // notifier's send sink, after buildPushPayload. Order per record: JSON
  // store commit → unfiltered WS broadcast → web-push attempt. A push
  // failure keeps the durable row; a store failure emits neither (contained
  // by the notifier's fire-and-forget boundary). /api/push/test calls
  // push.send directly and therefore never creates a centre row.
  const notifications = createNotificationStore({ file: `${dataDir}/notifications.json` });
  const pushNotifier = createPushNotifier({
    send: async (payload) => {
      const { key, projectId } = payload;
      if (!key || !payload.sessionId || !projectId) {
        throw Object.assign(new Error("notification payload missing key/session/project"), { code: "invalid-input" });
      }
      // Ownership: the target session (when it still exists) must belong to
      // the payload's project before the record is published.
      const target = await store.projection(payload.sessionId);
      if (target && target.projectId !== projectId) {
        throw Object.assign(new Error("notification target belongs to another project"), { code: "invalid-input" });
      }
      const record = await notifications.add({
        key, kind: payload.kind, sessionId: payload.sessionId, projectId,
        title: payload.title, body: payload.body,
      });
      broadcast.notification?.(record);
      return push.send(payload);
    },
    projection: (sessionId) => store.projection(sessionId),
    attention: async (sessionId) => (await store.attentionFor([sessionId]))[sessionId],
  });

  // --- multirun/fusion/goals resolve the parent session's project/runtime
  // lazily through this binding, so they work for any session.
  const resolveSessionRuntime = (sessionId: string) =>
    resolveSessionRuntimeBinding(sessionId, { store, projects, runtimes });

  // --- autonomous package discovery. The session service is composed AFTER
  // the packages load (it consumes their services: permissions, git
  // worktrees, terminal shell, command expansion, attachment stat). Packages
  // capture this stable delegate; invoking it before composition finishes is
  // a package bug surfaced with an explicit error.
  let sessionsImpl: SessionService | null = null;
  const lazySessions: SessionService = new Proxy({} as SessionService, {
    get(_target, property) {
      if (!sessionsImpl) {
        throw new Error(
          `session service accessed during package load (property "${String(property)}"); resolve it lazily inside onEnable or route handlers`,
        );
      }
      const value = Reflect.get(sessionsImpl, property) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(sessionsImpl)
        : value;
    },
  });

  // WS upgrade channels registered by packages (e.g. the terminal channel)
  // attach through this seam once the HTTP server exists — always BEFORE the
  // core session gateway, which aborts upgrades whose path it does not match.
  const httpServerCallbacks: Array<(ctx: HttpServerContext) => void> = [];
  let httpServerContext: HttpServerContext | null = null;
  const onHttpServer = (cb: (ctx: HttpServerContext) => void): void => {
    if (httpServerContext) {
      cb(httpServerContext);
      return;
    }
    httpServerCallbacks.push(cb);
  };

  const packageHost: Omit<ServerPackageHost, "pluginId"> = {
    storageDir: dataDir,
    routes: routeRegistry,
    root,
    projects,
    sessions: lazySessions,
    store,
    broadcast,
    runtimes,
    services,
    events: {
      append: async (sessionId, type, data, eventOpts) => {
        const ev = await store.append(sessionId, type, data, eventOpts);
        broadcast.event(ev);
        return ev;
      },
    },
    oneShot,
    smallModel,
    resolveSessionRuntime,
    loadPlugin: (plugin) => loadPlugin(root, plugin, {}),
    onHttpServer,
  };
  const discoveredPackages = await registerDiscoveredPackages({
    packagesDir,
    discovered: discoveredPackageManifests,
    host: packageHost,
    lifecycle: packageLifecycle,
    routes: routeRegistry,
    onError: (id, error) => console.error(`[polyth] server package "${id}" failed to load`, error),
  });
  if (discoveredPackages.length > 0) {
    console.log(`[polyth] discovered server packages: ${discoveredPackages.join(", ")}`);
  }

  // --- browser-tool bridge: only backend-opencode may talk to the OpenCode
  // process, so the bridge is composed here from the browser package's service.
  const browserForBridge = svc<Parameters<typeof createBrowserToolBridge>[0]["browser"]>("browser");
  if (browserForBridge) {
    browserToolBridge = createBrowserToolBridge({
      browser: browserForBridge,
      canonicalSessionId: (backendSessionId) => {
        for (const [canonical, backend] of sessionIdMap) {
          if (backend === backendSessionId) return canonical;
        }
        return undefined;
      },
    });
    provideService("browser.tool-bridge", browserToolBridge);
  } else {
    console.error("[polyth] browser package unavailable; agent browser tool disabled");
  }

  // --- session service composition. Package-owned dependencies come from the
  // registry; optional seams degrade honestly when a package failed to load.
  const gitService = svc<TrackWorkflowDeps["git"]>("git");
  const terminalService = svc<TrackWorkflowDeps["terminals"]>("terminal");
  const commandService = svc<CommandExpandService>("commands");
  const attachmentGuard = svc<NonNullable<SessionDeps["attachments"]>>("files.attachments");
  const autoAcceptStore = svc<NonNullable<SessionDeps["autoAccept"]>>("permissions.auto-accept");

  const sessions = createSessionService({
    store, projects, runtimes, broadcast, queue: store, org: store, profiles: store, behavior, secureSafe,
    permissions: requireSvc<SessionDeps["permissions"]>("permissions"),
    ...(gitService ? { worktrees: gitService.worktrees } : {}),
    ...(terminalService ? { shell: terminalService } : {}),
    // F18: server-owned per-session auto-accept policy (nearest-parent
    // resolution for subagents; session-scoped only, never a global default).
    ...(autoAcceptStore ? { autoAccept: autoAcceptStore } : {}),
    notify: pushNotifier,
    ...(attachmentGuard ? { attachments: attachmentGuard } : {}),
    ...(commandService ? {
      expand: async (projectId: string, text: string) => {
        const project = await projects.get(projectId);
        const r = await commandService.expand(project?.path ?? process.cwd(), text);
        return {
          text: r.text, raw: r.raw,
          ...(r.agent ? { agent: r.agent } : {}),
          ...(parseModel(r.model) ? { model: parseModel(r.model)! } : {}),
        };
      },
    } : {}),
    hooks: {
      beforeTurn: async (sessionId, events) => {
        const compactionSeq = unrestoredCompactionSeq(events);
        if (compactionSeq === null) return null;
        const goal = await ensureGoalState(sessionId);
        const objective = goal?.status === "active" ? goal.objective : undefined;
        const pinned = activePinnedMessages(events);
        if (!objective && pinned.length === 0) return null;
        return {
          recoveryContext: compactionRecoveryText({ compactionSeq, objective, pinned }),
          compactionSeq,
          goalRestored: objective !== undefined,
          pinnedSourceSeqs: pinned.map((item) => item.sourceEventSeq),
        };
      },
      onTurnCompleted: (sessionId, text) => {
        void (async () => {
          const goals = goalService();
          const state = await ensureGoalState(sessionId);
          if (state?.status === "active") {
            await goals?.onTurnCompleted(sessionId, text);
            if (goals?.get(sessionId)?.status === "completed") {
              await trackWorkflow?.completeForSession(sessionId);
            }
          }
        })().catch((err: unknown) => console.error("[polyth] goal/track completion failed", err));
        assist?.onTurnCompleted(sessionId);
      },
      onUsage: (sessionId, tokens) => goalService()?.recordUsage(sessionId, { ...tokens, cacheRead: 0, cacheWrite: 0 }),
    },
  });
  sessionsImpl = sessions;
  root.provide(CAP.sessions, sessions);

  // --- F9 idle assist: after N quiet seconds past turn/stopped, a small-model
  // recap + ONE suggestion lands on the projection (never the event log) keyed
  // to the log tail seq — any newer event makes it stale. Hard off by default.
  const assistSettings = createAssistSettings({ file: `${dataDir}/assist.json` });
  const assistTranscript = async (sessionId: string): Promise<string> => {
    const msgs = deriveMessages(await store.events(sessionId));
    const lines: string[] = [];
    for (const m of msgs.slice(-40)) {
      if (m.role === "tool") continue;
      const text = m.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text).join("\n").trim();
      if (text) lines.push(`${m.role === "user" ? "User" : "Assistant"}: ${text}`);
    }
    return lines.join("\n\n").slice(-16_000);
  };
  const assistComplete = async (sessionId: string, prompt: string): Promise<string> => {
    const proj = await store.projection(sessionId);
    const project = proj ? await projects.get(proj.projectId) : null;
    const rt = await runtimes.forProject(proj?.projectId ?? "__default__");
    return oneShot(rt, {
      cwd: project?.path ?? process.cwd(), prompt,
      ...(smallModel() ? { model: smallModel()! } : proj?.model ? { model: proj.model } : {}),
    });
  };
  assist = createAssistService({
    settings: () => assistSettings.get(),
    latestSeq: (sessionId) => store.latestSeq(sessionId),
    transcript: assistTranscript,
    complete: assistComplete,
    save: async (sessionId, a) => {
      const current = await store.projection(sessionId);
      if (!current) return;
      const next = { ...current, assist: a, updatedAt: Date.now() };
      await store.upsertProjection(next);
      broadcast.projection(next);
    },
    onError: (sessionId, err) => console.error(`[polyth] assist generation failed for ${sessionId}`, err),
  });

  // --- spec-driven track orchestration: a genuinely cross-cutting workflow
  // (knowledge tracks + goals + schedule + git + terminal + sessions), so the
  // composition root wires it from package-published services and publishes
  // it back for the knowledge package's routes.
  try {
    trackWorkflow = createTrackWorkflow({
      tracks: requireSvc<TrackWorkflowDeps["tracks"]>("tracks.store"),
      goals: requireSvc<TrackWorkflowDeps["goals"]>("goals"),
      schedule: requireSvc<TrackWorkflowDeps["schedule"]>("schedule"),
      git: requireSvc<TrackWorkflowDeps["git"]>("git"),
      terminals: requireSvc<TrackWorkflowDeps["terminals"]>("terminal"),
      projects,
      sessions,
      append: async (sessionId, type, data) => {
        const ev = await store.append(sessionId, type, data, { ignorable: true, producerPlugin: "tracks" });
        broadcast.event(ev);
        return ev;
      },
    });
    provideService("tracks.workflow", trackWorkflow);
  } catch (error) {
    console.error("[polyth] track workflow unavailable (a package it depends on did not load)", error);
  }

  // --- F16 access control: OFF unless a password is configured. When on,
  // every /api + /ws answer requires the polyth_auth session cookie; login is
  // rate-limited per client IP; sessions persist in data/auth.json so devices
  // stay remembered across restarts.
  const auth = createAuthService({
    file: `${dataDir}/auth.json`,
    envPassword: process.env.POLYTH_UI_PASSWORD,
    localhostOptional: process.env.POLYTH_UI_PASSWORD_LOCALHOST === "optional",
  });

  const registerPackageRoute = (
    id: string,
    handler: RouteHandler,
    hooks: { onEnable?: () => void | Promise<void>; onDisable?: () => void | Promise<void> } = {},
  ): void => {
    let route: Disposable | null = null;
    packageLifecycle.register(id, {
      async onEnable() {
        await hooks.onEnable?.();
        route = routeRegistry.add(id, handler);
      },
      async onDisable() {
        await route?.dispose();
        route = null;
        try {
          await hooks.onDisable?.();
        } catch (error) {
          route = routeRegistry.add(id, handler);
          throw error;
        }
      },
    });
  };
  const settingsRoute = settingsRoutes({
    behavior, mcp,
    saveRole: async (name, role) => {
      await configApplier.applyAgent(name, role);
      const current = (await runtimeCatalog.agents()).find((agent) => agent.name === name);
      const saved = {
        name,
        ...(current?.description ? { description: current.description } : {}),
        mode: role.mode,
        ...(role.prompt ? { prompt: role.prompt } : {}),
        ...(role.model ? { model: role.model } : {}),
      };
      runtimeCatalog.patchAgent(saved);
      return saved;
    },
    systemInfo: (local) => ({
      version: "0.1.0",
      applicationUrl: `http://${opts.hostname ?? "127.0.0.1"}:${port}`,
      tunnelUrl: process.env.POLYTH_TUNNEL_URL ?? null,
      dataDirLabel: local ? dataDir : "Polyth data directory",
      capabilities: allCapabilities(),
    }),
  });

  // Server-internal packages (no packages/<dir> counterpart) stay hand-wired.
  registerPackageRoute("projects", projectRoutes(projects));
  registerPackageRoute("mcp", async (request) =>
    request.path.startsWith("/api/mcp/") ? settingsRoute(request) : false);

  const staticCoreRoutes: RouteHandler[] = [
    authRoutes(auth),
    opencodePendingRoutes(pendingOpenCode),
    packageRoutes(packageRegistry),
    contextRoutes(sessions),
    orgRoutes({ projects, sessions, store }),
    assistRoutes({
      settings: assistSettings,
      projection: (sessionId) => store.projection(sessionId),
      latestSeq: (sessionId) => store.latestSeq(sessionId),
      distill: async (sessionId) => {
        const transcript = await assistTranscript(sessionId);
        if (!transcript.trim()) {
          throw Object.assign(new Error("nothing to distill — the session has no messages"), { code: "invalid-input" });
        }
        return parseNoteReply(await assistComplete(sessionId, buildNotePrompt(transcript)));
      },
    }),
    sessionRetentionRoutes(sessions),
    controlRoutes(sessions),
    agentSessionRoutes({
      sessions,
      projects,
      store,
      capabilities: () => allCapabilities(),
      goals: () => svc<AgentGoalService>("goals"),
      version: "0.1.0",
    }),
    queueRoutes(sessions),
    pushRoutes(push),
    notificationRoutes(notifications),
    browseRoutes(),
    async (request) => {
      if (request.path.startsWith("/api/mcp/") || request.path.startsWith("/api/plugins")) return false;
      return settingsRoute(request);
    },
  ];
  const routes: RouteHandler[] = [...staticCoreRoutes, routeRegistry.handler];

  const allCapabilities = () => [...SERVER_CAPABILITY_IDS];

  await packageLifecycle.startEnabled(packageRegistry);

  const server = createHttpServer({
    sessions, projects, runtimes, routes, visibility, auth, catalog: runtimeCatalog,
    capabilities: allCapabilities,
    webDist: resolve(opts.webDist ?? resolve(__dirname, "../../../apps/web/dist")),
    version: "0.1.0",
  });
  // order matters: /ws (session gateway) aborts upgrades whose path it does
  // not match, so package channels (terminal: /ws/terminal/:id) claim their
  // upgrades first through the onHttpServer seam.
  const wsAuthorize = (req: import("node:http").IncomingMessage) => auth.authorized(req);
  httpServerContext = { server, authorize: wsAuthorize };
  for (const cb of httpServerCallbacks.splice(0)) cb(httpServerContext);
  live = attachWs(server, sessions, svc<BrowserForWs>("browser"), svc<DictationForWs>("dictation"), wsAuthorize);

  await new Promise<void>((res) => opts.hostname
    ? server.listen(port, opts.hostname, res)
    : server.listen(port, res));
  console.log(`[polyth] server on http://${opts.hostname ?? "127.0.0.1"}:${port}  data=${dataDir}`);

  const shutdown = async () => {
    for (const descriptor of packageRegistry.list().toReversed()) {
      await packageLifecycle.disable(descriptor.id).catch((error: unknown) => {
        console.error(`[polyth] package "${descriptor.id}" failed to disable during shutdown`, error);
      });
    }
    // Package services hold OS resources even while their routes are disabled
    // (a disabled package's onDisable never ran), so shutdown closes them
    // through the registry. Every call is idempotent.
    svc<{ stop(): void }>("schedule")?.stop();
    svc<{ stop(): void }>("usage")?.stop();
    assist?.stop();
    svc<{ close(): void }>("knowledge")?.close();
    await svc<{ closeAll(): Promise<void> }>("browser")?.closeAll().catch(() => {});
    await svc<{ closeAll(): Promise<void> }>("terminal")?.closeAll().catch(() => {});
    for (const p of runtimesByProject.values()) await (await p.catch(() => null))?.dispose().catch(() => {});
    await svc<SshTransportService>("ssh")?.disconnectAll().catch(() => {});
    await root.dispose();
    await store.close();
    server.close();
  };
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  return { server, sessions, shutdown };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void boot();
}
