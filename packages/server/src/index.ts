// Polyth server boot. Composition root: kernel context + plugins + gateway.
import { mkdirSync, readFileSync } from "node:fs";
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
import { CAP, type AgentRuntime, type Disposable, type JsonObject, type RuntimeEvent, type SessionEvent, type SessionProjection, type WalkthroughSource } from "@polyth/contracts";
import {
  createBrowserToolBridge,
  createConfigApplier,
  createOpenCodeRuntime,
  createRemoteOpenCodeRuntime,
  probeRemoteOpenCode,
  type OpenCodeAdapterOptions,
} from "@polyth/backend-opencode";
import { createSshService } from "@polyth/ssh";
import {
  createPluginRegistry,
  createServerServiceRegistry,
  serverServiceKey,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createAutoAcceptStore, createPermissionService } from "@polyth/permissions";
import { createGoalService, type GoalService } from "@polyth/goals";
import { createFileService, MAX_RAW_BYTES } from "@polyth/files";
import { createCommandService } from "@polyth/commands";
import { createGitService } from "@polyth/git";
import { createTerminalService } from "@polyth/terminal";
import { createMultirunService } from "@polyth/multirun";
import { createWorkflowService } from "@polyth/workflow";
import { createFusionService, synthesisPrompt } from "@polyth/fusion";
import { createScheduleService } from "@polyth/schedule";
import { createKnowledgeStore, createTrackStore } from "@polyth/knowledge";
import { createGithubService } from "@polyth/github";
import {
  createFakeQuotaProvider,
  createHttpQuotaProvider,
  createUsageService,
  discoverQuotaProviders,
  parseQuotaProviderSpecs,
} from "@polyth/usage";
import {
  createBrowserService, createChromiumDriver, createFakeDriver, demoWeb,
  findChromiumExecutable,
} from "@polyth/browser";
import { createDictationService, createWhisperSttAdapter } from "@polyth/dictation";
import { createProjectService } from "./projects.ts";
import { projectRoutes } from "./routes/projects.ts";
import { createPackageRegistry } from "./packages.ts";
import { createSessionService, type Broadcaster, type RuntimePool } from "./sessions.ts";
import { createRuntimeCatalog } from "./runtimeCatalog.ts";
import { createHttpServer, type RouteHandler } from "./http.ts";
import { packageRoutes } from "./routes/packages.ts";
import { pluginAssetRoutes } from "./routes/pluginAssets.ts";
import { goalRoutes } from "./routes/goals.ts";
import { contextRoutes } from "./routes/context.ts";
import { orgRoutes } from "./routes/org.ts";
import { workspaceRoutes } from "./routes/workspace.ts";
import { attachTerminalWs } from "./routes/terminal.ts";
import { sessionRetentionRoutes } from "./routes/sessionRetention.ts";
import { controlRoutes } from "./routes/control.ts";
import { profileRoutes } from "./routes/profiles.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { opencodePluginRoutes } from "./routes/opencodePlugins.ts";
import { opencodePendingRoutes } from "./routes/opencodePending.ts";
import { browseRoutes } from "./routes/browse.ts";
import { createAuthService } from "./auth.ts";
import { authRoutes } from "./routes/auth.ts";
import { createPushNotifier, createPushService } from "./push.ts";
import { pushRoutes } from "./routes/push.ts";
import { createNotificationStore } from "./notifications.ts";
import { notificationRoutes } from "./routes/notifications.ts";
import { registerDiscoveredPackages } from "./packageDiscovery.ts";
import { autoAcceptRoutes } from "./routes/autoAccept.ts";
import { queueRoutes } from "./routes/queue.ts";
import { createBehaviorService } from "./behavior.ts";
import { createMcpConfigService, mcpEntriesFromBackendConfig } from "./mcp.ts";
import { createSecureSafeService, secureSafeBehaviorSection } from "./secureSafe.ts";
import { createModelVisibilityService } from "./modelVisibility.ts";
import { createVoiceSettings } from "./voice.ts";
import { buildNotePrompt, createAssistService, createAssistSettings, parseNoteReply, type AssistService } from "./assist.ts";
import { assistRoutes } from "./routes/assist.ts";
import { trackRoutes } from "./routes/tracks.ts";
import { createPluginContributionHub } from "./pluginContributions.ts";
import { createWalkthroughJobService } from "./walkthroughs.ts";
import { createReviewFlowService, createReviewService } from "./review.ts";
import { createMultirunRunOne } from "./multirunRunner.ts";
import { createWorkflowRunNode } from "./workflowRunner.ts";
import { oneShot } from "./oneshot.ts";
import { attachWs } from "./ws.ts";
import { createTrackWorkflow, type TrackWorkflow } from "./tracks.ts";
import { createRouteRegistry } from "./routeRegistry.ts";
import { createPackageLifecycle } from "./packageLifecycle.ts";
import { createDeferredConfigApplier, createOpenCodePendingService } from "./opencodePending.ts";

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
  opencode?: Partial<OpenCodeAdapterOptions>;
  /** Workspace packages/ directory scanned for polyth.serverEntry markers. */
  packagesDir?: string;
}

export { isPackageEnabled } from "./packages.ts";

export async function boot(opts: BootOptions = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 4400);
  const dataDir = resolve(opts.dataDir ?? process.env.POLYTH_DATA_DIR ?? "./data");
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
  const permissions = createPermissionService(dataDir);

  // --- SSH remotes: connection inventory + multiplexed OpenSSH transport.
  // Remote-bound projects run their agent runtime ON the remote host (see
  // spawnRuntime below); this service never speaks OpenCode itself.
  const ssh = createSshService({ file: `${dataDir}/ssh.json` });

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

  const spawnRuntime = async (projectId: string, cwd: string): Promise<AgentRuntime> => {
    // Remote-bound projects run `opencode serve` ON the remote host through
    // the SSH transport (one multiplexed channel + one forwarded port). The
    // browser-tool bridge is a local loopback endpoint the remote cannot
    // reach, so it is not registered for remote runtimes.
    const remoteBinding = (await projects.get(projectId))?.remote;
    if (remoteBinding?.kind === "ssh") {
      return createRemoteOpenCodeRuntime({
        host: ssh.host(remoteBinding.connectionId),
        remotePath: cwd,
        sessionIdMap,
      });
    }
    const browserTool = browserToolBridge.register({ projectId, cwd });
    try {
      const runtime = await createOpenCodeRuntime({
        cwd, sessionIdMap,
        ...(opts.opencode?.port ? { port: opts.opencode.port } : {}),
        ...(opts.opencode?.bin ? { bin: opts.opencode.bin } : {}),
        ...(opts.opencode?.hostname ? { hostname: opts.opencode.hostname } : {}),
        browserTool: {
          endpoint: `http://127.0.0.1:${port}/internal/opencode/browser-tool`,
          token: browserTool.token,
          pluginDirectory: `${dataDir}/opencode-tools`,
        },
      });
      const dispose = runtime.dispose.bind(runtime);
      runtime.dispose = async () => {
        browserTool.dispose();
        await dispose();
      };
      return runtime;
    } catch (error) {
      browserTool.dispose();
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

  // --- goals workflow plugin (listens on the turn seam, never touches the loop)
  let goals: GoalService | null = null;
  let trackWorkflow: TrackWorkflow | null = null;
  // F9 idle assist: created after `sessions` (it needs the runtime resolver);
  // the turn hook below only pings it, so a late assignment is safe.
  let assist: AssistService | null = null;
  const ensureGoalState = async (sessionId: string) => {
    if (!goals) return null;
    const known = goals.get(sessionId);
    if (known) return known;
    return goals.rehydrate(sessionId, await store.events(sessionId)); // survives restart
  };

  const files = createFileService();
  const git = createGitService();
  const commands = createCommandService();
  // POLYTH_TERM_REPLAY_BYTES caps per-PTY scrollback replay (default 200 KB).
  const terminals = createTerminalService({
    ...(Number(process.env.POLYTH_TERM_REPLAY_BYTES) > 0
      ? { replayBytes: Number(process.env.POLYTH_TERM_REPLAY_BYTES) }
      : {}),
  });

  // --- internal browser: Chromium if configured/found, fake driver behind
  // POLYTH_FAKE_BROWSER=1, otherwise an honest unavailable state.
  const chromiumPath = process.env.POLYTH_FAKE_BROWSER === "1" ? null : await findChromiumExecutable();
  const browserDriver = process.env.POLYTH_FAKE_BROWSER === "1"
    ? createFakeDriver(demoWeb())
    : chromiumPath
      ? createChromiumDriver(chromiumPath)
      : null;
  const browser = createBrowserService({
    driver: browserDriver,
    unavailableReason: "browser engine unavailable: no Chromium executable found (set POLYTH_CHROMIUM_PATH)",
  });
  const browserToolBridge = createBrowserToolBridge({
    browser,
    canonicalSessionId: (backendSessionId) => {
      for (const [canonical, backend] of sessionIdMap) {
        if (backend === backendSessionId) return canonical;
      }
      return undefined;
    },
  });

  // Streaming dictation (WP15/F8): the adapter provider re-reads voice.json on
  // every call, so saving an STT server URL in Settings → Voice flips the
  // capability honestly without a restart; no URL = browser Web Speech.
  const voiceSettings = createVoiceSettings({ file: `${dataDir}/voice.json` });
  const dictation = createDictationService({
    adapter: () => {
      const stt = voiceSettings.get().stt;
      if (!stt.baseUrl) return null;
      const apiKey = voiceSettings.resolveKey("stt");
      return createWhisperSttAdapter({
        baseUrl: stt.baseUrl,
        ...(stt.model ? { model: stt.model } : {}),
        ...(stt.language ? { language: stt.language } : {}),
        ...(apiKey ? { apiKey } : {}),
      });
    },
    unavailableReason: "no speech-to-text engine configured; browser Web Speech is used instead",
  });
  const parseModel = (raw?: string) => {
    if (!raw || !raw.includes("/")) return undefined;
    const i = raw.indexOf("/");
    return { providerID: raw.slice(0, i), modelID: raw.slice(i + 1) };
  };

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
  const pluginHub = createPluginContributionHub();
  const pluginsDir = `${dataDir}/plugins`;
  const pluginRegistry = createPluginRegistry({
    dir: pluginsDir,
    trustedDir: process.env.POLYTH_TRUSTED_PLUGIN_DIR ?? `${dataDir}/trusted-plugins`,
    slots: pluginHub.slots,
    routes: routeRegistry,
    root,
    onChange: (plugin) => broadcast.pluginChanged?.(plugin),
  });

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

  const sessions = createSessionService({
    store, projects, permissions, runtimes, broadcast, queue: store, org: store, profiles: store, behavior, secureSafe,
    worktrees: git.worktrees,
    shell: terminals,
    // F18: server-owned per-session auto-accept policy (nearest-parent
    // resolution for subagents; session-scoped only, never a global default).
    autoAccept: createAutoAcceptStore(`${dataDir}/auto-accept.json`),
    notify: pushNotifier,
    attachments: {
      stat: async (root, rel) => {
        const st = await files.stat(root, rel);
        return { kind: st.kind, size: st.size };
      },
      maxBytes: MAX_RAW_BYTES,
    },
    expand: async (projectId, text) => {
      const project = await projects.get(projectId);
      const r = await commands.expand(project?.path ?? process.cwd(), text);
      return {
        text: r.text, raw: r.raw,
        ...(r.agent ? { agent: r.agent } : {}),
        ...(parseModel(r.model) ? { model: parseModel(r.model)! } : {}),
      };
    },
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
      onUsage: (sessionId, tokens) => goals?.recordUsage(sessionId, { ...tokens, cacheRead: 0, cacheWrite: 0 }),
    },
  });
  root.provide(CAP.sessions, sessions);

  goals = createGoalService({
    append: async (sessionId, type, data) => {
      const ev = await store.append(sessionId, type, data, { ignorable: true });
      broadcast.event(ev);
      return ev;
    },
    send: (sessionId, text) => sessions.send(sessionId, { text }),
    complete: async (sessionId, prompt) => {
      const proj = await store.projection(sessionId);
      const project = proj ? await projects.get(proj.projectId) : null;
      const rt = await runtimes.forProject(proj?.projectId ?? "__default__");
      return oneShot(rt, {
        cwd: project?.path ?? process.cwd(),
        prompt,
        ...(smallModel() ? { model: smallModel()! } : proj?.model ? { model: proj.model } : {}),
      });
    },
  });

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

  // --- multirun/fusion (M3): both resolve the parent session's project/runtime
  // lazily, the same way goals.complete does, so they work for any session.
  const resolveSessionRuntime = async (sessionId: string) => {
    const proj = await store.projection(sessionId);
    const project = proj ? await projects.get(proj.projectId) : null;
    const rt = await runtimes.forProject(proj?.projectId ?? "__default__");
    return { rt, cwd: project?.path ?? process.cwd(), model: proj?.model, agent: proj?.agent };
  };

  const multirun = createMultirunService({
    append: async (sessionId, type, data) => {
      const ev = await store.append(sessionId, type, data, { ignorable: true });
      broadcast.event(ev);
      return ev;
    },
    runOne: createMultirunRunOne(resolveSessionRuntime),
  });

  const workflow = createWorkflowService({
    file: `${dataDir}/workflows.json`,
    append: async (sessionId, type, data) => {
      const ev = await store.append(sessionId, type, data, {
        ignorable: true,
        producerPlugin: "workflow",
      });
      broadcast.event(ev);
      return ev;
    },
    runNode: createWorkflowRunNode(sessions),
  });

  const fusion = createFusionService({
    append: async (sessionId, type, data) => {
      const ev = await store.append(sessionId, type, data, { ignorable: true });
      broadcast.event(ev);
      return ev;
    },
    runModel: async ({ sessionId, model, prompt }) => {
      const { rt, cwd } = await resolveSessionRuntime(sessionId);
      return oneShot(rt, { cwd, prompt, ...(parseModel(model) ? { model: parseModel(model)! } : {}) });
    },
    synthesize: async ({ sessionId, prompt, answers }) => {
      const { rt, cwd, model } = await resolveSessionRuntime(sessionId);
      return oneShot(rt, {
        cwd, prompt: synthesisPrompt(prompt, answers),
        ...(smallModel() ? { model: smallModel()! } : model ? { model } : {}),
      });
    },
  });

  // --- scheduled prompts: every run owns a VISIBLE session per its target
  // mode; schedule/run-started is appended before the prompt so the durable
  // log explains why the message arrived (all model flow stays in sessions).
  const schedule = createScheduleService({
    file: `${dataDir}/schedule.json`,
    runner: {
      run: async (task, runId) => {
        const mode = task.target?.mode ?? (task.sessionId ? "existing-session" : "new-session-per-run");
        let sessionId: string | undefined;
        if (mode === "existing-session") {
          sessionId = task.target?.sessionId ?? task.sessionId;
          if (!sessionId || !(await store.projection(sessionId))) {
            throw Object.assign(new Error("target session no longer exists"), { code: "not-found" });
          }
        } else if (mode === "dedicated-session") {
          if (task.lastSessionId && (await store.projection(task.lastSessionId))) {
            sessionId = task.lastSessionId;
          }
        }
        if (!sessionId) {
          const ref = await sessions.create({
            projectId: task.projectId,
            title: task.title ?? `Scheduled: ${task.prompt.slice(0, 48)}`,
          });
          sessionId = ref.id;
        }
        const started = await store.append(sessionId, "schedule/run-started", {
          taskId: task.id, runId,
          ...(task.title ? { taskTitle: task.title } : {}),
          ...(task.source === "loop-file" ? { source: "loop-file", ...(task.loopId ? { loopId: task.loopId } : {}) } : {}),
        }, { ignorable: true, producerPlugin: "schedule" });
        broadcast.event(started);
        await sessions.send(sessionId, { text: task.prompt });
        return { sessionId };
      },
    },
  });

  const knowledge = createKnowledgeStore(`${dataDir}/knowledge.db`);
  const trackStore = createTrackStore({ file: `${dataDir}/tracks.json`, knowledge });
  trackWorkflow = createTrackWorkflow({
    tracks: trackStore,
    goals,
    schedule,
    git,
    terminals,
    projects,
    sessions,
    append: async (sessionId, type, data) => {
      const ev = await store.append(sessionId, type, data, { ignorable: true, producerPlugin: "tracks" });
      broadcast.event(ev);
      return ev;
    },
  });

  const github = createGithubService();

  // --- WP12: quota telemetry. Built-in adapters discover the same OpenCode,
  // Claude Code, and polyth-managed credentials as polyth. The
  // browser only receives sanitized snapshots. The fake and hand-written HTTP
  // adapter paths remain available for development and private providers.
  const usage = createUsageService({ file: `${dataDir}/quotas.json` });
  if (process.env.POLYTH_FAKE_QUOTAS === "1") usage.register(createFakeQuotaProvider());
  try {
    const specsRaw = readFileSync(`${dataDir}/quota-providers.json`, "utf8");
    for (const spec of parseQuotaProviderSpecs(JSON.parse(specsRaw))) {
      usage.register(createHttpQuotaProvider(spec));
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[usage] quota-providers.json ignored:", e instanceof Error ? e.message : e);
    }
  }
  for (const provider of discoverQuotaProviders()) usage.register(provider);

  // --- WP11: generated walkthroughs, structured reviews, bounded review flow.
  // The source diff is captured through git/gh only; the model call is a
  // one-shot on the project's runtime (never a user session).
  const captureDiff = async (source: WalkthroughSource): Promise<string> => {
    const project = await projects.get(source.projectId);
    if (!project) throw Object.assign(new Error("unknown project"), { code: "not-found" });
    if (source.kind === "working-tree") return git.diffHead(project.path);
    if (source.kind === "range") return git.diffRange(project.path, source.base, source.head);
    const r = await github.prDiff(project.path, source.number);
    if (!r.ok) throw Object.assign(new Error(r.reason), { code: "invalid-input" });
    return r.data;
  };
  const generateForSource = async (source: WalkthroughSource, prompt: string): Promise<string> => {
    const project = await projects.get(source.projectId);
    const rt = await runtimes.forProject(source.projectId);
    return oneShot(rt, {
      cwd: project?.path ?? process.cwd(), prompt,
      ...(smallModel() ? { model: smallModel()! } : {}),
      timeoutMs: 180_000,
    });
  };
  const appendLogged = async (sessionId: string, type: string, data: JsonObject) => {
    const ev = await store.append(sessionId, type, data, { ignorable: true, producerPlugin: "review" });
    broadcast.event(ev);
    return ev;
  };
  const walkthroughJobs = createWalkthroughJobService({
    captureDiff,
    generate: generateForSource,
    append: appendLogged,
    cacheFile: `${dataDir}/walkthroughs.json`,
    ...(smallModel() ? { modelId: `${smallModel()!.providerID}/${smallModel()!.modelID}` } : {}),
  });
  const review = createReviewService({ captureDiff, generate: generateForSource, append: appendLogged });
  const reviewFlow = createReviewFlowService({
    sessionStatus: async (sessionId) => (await store.projection(sessionId))?.status ?? null,
    sessionProject: async (sessionId) => (await store.projection(sessionId))?.projectId ?? null,
    send: async (sessionId, text) => { await sessions.send(sessionId, { text }); },
    review: (sessionId, source) => review.generate(sessionId, source),
    append: appendLogged,
  });

  // --- F16 access control: OFF unless a password is configured. When on,
  // every /api + /ws answer requires the polyth_auth session cookie; login is
  // rate-limited per client IP; sessions persist in data/auth.json so devices
  // stay remembered across restarts.
  const auth = createAuthService({
    file: `${dataDir}/auth.json`,
    envPassword: process.env.POLYTH_UI_PASSWORD,
    localhostOptional: process.env.POLYTH_UI_PASSWORD_LOCALHOST === "optional",
  });

  const chainRoutes = (...handlers: RouteHandler[]): RouteHandler => async (request) => {
    for (const handler of handlers) {
      if (await handler(request)) return true;
    }
    return false;
  };
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
    behavior, mcp, plugins: pluginRegistry,
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
      applicationUrl: `http://127.0.0.1:${port}`,
      tunnelUrl: process.env.POLYTH_TUNNEL_URL ?? null,
      dataDirLabel: local ? dataDir : "Polyth data directory",
      capabilities: allCapabilities(),
    }),
  });
  const pluginRoute = chainRoutes(opencodePluginRoutes(configApplier), settingsRoute);

  // Server-internal packages (no packages/<dir> counterpart) stay hand-wired.
  registerPackageRoute("projects", projectRoutes(projects));
  registerPackageRoute("mcp", async (request) =>
    request.path.startsWith("/api/mcp/") ? settingsRoute(request) : false);
  registerPackageRoute("plugins", async (request) =>
    request.path.startsWith("/api/plugins") ? pluginRoute(request) : false);

  // --- autonomous package discovery: every workspace package that declares a
  // polyth.serverEntry marker registers itself through the same lifecycle the
  // hand-written registrations used. Shared service instances constructed
  // above are published under well-known keys so feature serverEntries can
  // resolve cross-package dependencies without composition-root edits.
  const services = createServerServiceRegistry();
  const provideService = <T,>(name: string, service: T): void =>
    services.provide(serverServiceKey<T>(name), service);
  provideService("permissions", permissions);
  provideService("goals", goals!);
  provideService("files", files);
  provideService("git", git);
  provideService("commands", commands);
  provideService("terminal", terminals);
  provideService("browser", browser);
  provideService("browser.tool-bridge", browserToolBridge);
  provideService("dictation", dictation);
  provideService("voice.settings", voiceSettings);
  provideService("multirun", multirun);
  provideService("workflow", workflow);
  provideService("fusion", fusion);
  provideService("schedule", schedule);
  provideService("knowledge", knowledge);
  provideService("tracks.store", trackStore);
  provideService("github", github);
  provideService("usage", usage);
  provideService("ssh", ssh);
  // The probe stays bound here so no feature package ever imports
  // backend-opencode; routes consuming it never learn OpenCode specifics.
  provideService("ssh.probe-runtime", (connectionId: string) => probeRemoteOpenCode(ssh.host(connectionId)));
  provideService("secure-safe", secureSafe);
  provideService("walkthrough.jobs", walkthroughJobs);
  provideService("review", review);
  provideService("review.flow", reviewFlow);

  const packageHost: Omit<ServerPackageHost, "pluginId"> = {
    storageDir: dataDir,
    routes: routeRegistry,
    root,
    projects,
    sessions,
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
  };
  const discoveredPackages = await registerDiscoveredPackages({
    packagesDir: opts.packagesDir ?? resolve(__dirname, "../.."),
    host: packageHost,
    lifecycle: packageLifecycle,
    routes: routeRegistry,
    onError: (id, error) => console.error(`[polyth] server package "${id}" failed to load`, error),
  });
  if (discoveredPackages.length > 0) {
    console.log(`[polyth] discovered server packages: ${discoveredPackages.join(", ")}`);
  }

  const staticCoreRoutes: RouteHandler[] = [
    authRoutes(auth),
    opencodePendingRoutes(pendingOpenCode),
    packageRoutes(packageRegistry),
    pluginAssetRoutes({ plugins: pluginRegistry, pluginsDir }),
    async (rc) => {
      if (/^\/api\/sessions\/[^/]+\/goal/.test(rc.path)) {
        const id = rc.path.split("/")[3]!;
        await ensureGoalState(id);
      }
      return false;
    },
    goalRoutes(goals),
    contextRoutes(sessions),
    orgRoutes({ projects, sessions, store }),
    workspaceRoutes({ projects, files, sessions }),
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
    trackRoutes(trackWorkflow),
    sessionRetentionRoutes(sessions),
    controlRoutes(sessions),
    autoAcceptRoutes(sessions),
    queueRoutes(sessions),
    pushRoutes(push),
    notificationRoutes(notifications),
    profileRoutes({
      store,
      listModels: () => runtimeCatalog.models(),
      listAgents: () => runtimeCatalog.agents(),
    }),
    browseRoutes(),
    async (request) => {
      if (request.path.startsWith("/api/mcp/") || request.path.startsWith("/api/plugins")) return false;
      return settingsRoute(request);
    },
  ];
  const routes: RouteHandler[] = [...staticCoreRoutes, routeRegistry.handler];

  const allCapabilities = () => ["polyth.sessions", "polyth.sessionPersistence", "polyth.projects", "polyth.agentRuntime", "polyth.goals", "polyth.files", "polyth.commands", "polyth.git", "polyth.worktrees", "polyth.terminal", "polyth.multirun", "polyth.workflow", "polyth.fusion", "polyth.walkthrough", "polyth.schedule", "polyth.tracks", "polyth.github", "polyth.control", "polyth.agentProfiles", "polyth.settings", "polyth.mcp", "polyth.plugins", "polyth.knowledge", "polyth.review", "polyth.usage", "polyth.browser", "polyth.voice", "polyth.assist", "polyth.homeAssistant", "polyth.secureSafe", "polyth.ssh"];

  await packageLifecycle.startEnabled(packageRegistry);

  const server = createHttpServer({
    sessions, projects, runtimes, routes, visibility, auth, catalog: runtimeCatalog,
    capabilities: allCapabilities,
    webDist: resolve(__dirname, "../../../apps/web/dist"),
    version: "0.1.0",
  });
  // order matters: /ws (session gateway) aborts upgrades whose path it does
  // not match, so the terminal channel must claim /ws/terminal/:id first
  const wsAuthorize = (req: import("node:http").IncomingMessage) => auth.authorized(req);
  attachTerminalWs(server, { terminals, authorize: wsAuthorize });
  live = attachWs(server, sessions, browser, dictation, wsAuthorize);

  await new Promise<void>((res) => server.listen(port, res));
  console.log(`[polyth] server on http://127.0.0.1:${port}  data=${dataDir}`);

  const shutdown = async () => {
    schedule.stop();
    usage.stop();
    assist?.stop();
    knowledge.close();
    await browser.closeAll().catch(() => {});
    await pluginRegistry.dispose().catch(() => {});
    await terminals.closeAll().catch(() => {});
    for (const p of runtimesByProject.values()) await (await p.catch(() => null))?.dispose().catch(() => {});
    await ssh.disconnectAll().catch(() => {});
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
