// Polyth server boot. Composition root: kernel context + plugins + gateway.
//
// Feature packages are NOT imported here. Every workspace package that
// declares a polyth.serverEntry marker is discovered at boot, constructs its
// own services, and publishes them in the shared service registry
// (serverServiceKey). This file only composes infrastructure (session store,
// runtime pool, HTTP/WS gateway) plus the few genuinely cross-cutting seams
// (session service wiring and track workflow).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCapabilityContributionRegistry, createHarnessPool, createHarnessRegistry, releaseProcessExecution } from "@polyth/harness-runtime";
import { createContext, loadPlugin } from "@polyth/kernel";
import {
  activePinnedMessages,
  compactionRecoveryText,
  createStore,
  deriveMessages,
  unrestoredCompactionSeq,
} from "@polyth/session";
import {
  CAP,
  SERVER_CAPABILITY_IDS,
  type AgentRuntime,
  type Disposable,
  type HarnessConfigurationMetadata,
  type HarnessContext,
  type HarnessProvider,
  type PackageDescriptorDto,
  type RemoteHost,
  type RuntimeEndpoint,
  type RuntimeEvent,
  type RuntimeSessionBinding,
  type RuntimeSnapshot,
  type SessionEvent,
  type SessionProjection,
  type SessionService,
} from "@polyth/contracts";
import {
  createConfigApplier,
  createOpenCodeRuntime,
  createRemoteOpenCodeRuntime,
  installRemoteOpenCode,
  inspectOpenCodeEngine,
  probeRemoteOpenCode,
  resolveOpenCodeBinary,
  sweepOpenCodeRuntimes,
  type OpenCodeAdapterOptions,
} from "@polyth/backend-opencode";
import {
  bindPackageServices,
  createServerServiceRegistry,
  discoverServerPackages,
  PairedSocketRegistry,
  serverServiceKey,
  type HttpServerContext,
  type ServerPackageFactory,
  type ServerPackageHost,
} from "@polyth/plugins";
import { createProjectService } from "./projects.ts";
import {
  createSpaceGateway,
  spaceCookieHeader,
  type SpaceGateway,
} from "./spaces.ts";
import { spaceRoutes } from "./routes/spaces.ts";
import { createSpaceStorage, spaceStorageDir } from "@polyth/tenancy";
import { projectRoutes } from "./routes/projects.ts";
import { createPackageRegistry } from "./packages.ts";
import {
  createSessionService,
  type Broadcaster,
  type RuntimeEpochSessionService,
  type RuntimePool,
} from "./sessions.ts";
import { resolveSessionRuntimeBinding } from "./sessionRuntime.ts";
import { createRuntimeCatalog } from "./runtimeCatalog.ts";
import { createHttpHandler, createInternalControlServer, createPublicHttpServer, createTunnelIngress, type RouteHandler } from "./http.ts";
import { drainAndCloseServer, HTTP_DRAIN_MS } from "./httpDrain.ts";
import { createHttpAdmission } from "./httpAdmission.ts";
import { packageRoutes } from "./routes/packages.ts";
import { contextRoutes } from "./routes/context.ts";
import { orgRoutes } from "./routes/org.ts";
import { sessionRetentionRoutes } from "./routes/sessionRetention.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { opencodePendingRoutes } from "./routes/opencodePending.ts";
import { browseRoutes } from "./routes/browse.ts";
import { createAuthService, publicHttpIngress } from "./auth.ts";
import { authRoutes } from "./routes/auth.ts";
import { createPushNotifier, createPushService } from "./push.ts";
import { pushRoutes } from "./routes/push.ts";
import { createNotificationStore } from "./notifications.ts";
import { notificationRoutes } from "./routes/notifications.ts";
import { createNativePushService, nativePushRoutes } from "./nativePush.ts";
import { registerDiscoveredPackages, registerServerPackage } from "./packageDiscovery.ts";
import { queueRoutes } from "./routes/queue.ts";
import { createBehaviorService } from "./behavior.ts";
import { createClientSettings } from "./clientSettings.ts";
import { createMcpConfigService, mcpEntriesFromBackendConfig } from "./mcp.ts";
import { createCapabilityProvisioningController, reconcilePinnedHarness } from "./capabilityProvisioning.ts";
import { AGENT_TOOLS_PATH, createAgentToolBridge, redactToolInput } from "./agentTools.ts";
import { createSecureSafeService, secureSafeBehaviorSection } from "./secureSafe.ts";
import { createModelVisibilityService } from "./modelVisibility.ts";
import { createVoiceSettings } from "./voice.ts";
import {
  buildNotePrompt,
  buildPromptImprovementPrompt,
  createAssistService,
  createAssistSettings,
  createManualSuggestionService,
  parseNoteReply,
  PROMPT_IMPROVEMENT_OUTPUT_MAX_CHARS,
  sanitizeNextActionReply,
  type AssistService,
} from "./assist.ts";
import { assistRoutes } from "./routes/assist.ts";
import { promptHistoryRoutes } from "./routes/promptHistory.ts";
import { oneShot } from "./oneshot.ts";
import {
  createSmallModelService,
  smallModelExecutionRoute,
  smallModelPreference,
} from "./smallModel.ts";
import { createWsGateway, type WsGateway } from "./ws.ts";
import { createTrackWorkflow, type TrackWorkflow, type TrackWorkflowDeps } from "./tracks.ts";
import { createRouteRegistry } from "./routeRegistry.ts";
import { createPackageLifecycle } from "./packageLifecycle.ts";
import { createDeferredConfigApplier, createOpenCodePendingService, inspectOpenCodeConfiguration, physicalRestartKeysFor } from "./opencodePending.ts";
import { agentSessionRoutes, type AgentGoalService } from "./routes/agentSessions.ts";
import { runtimeEpochRoutes } from "./routes/runtimeEpoch.ts";
import { runtimeDiagnosticsRoutes } from "./routes/runtimeDiagnostics.ts";
import { createRuntimeDiagnostics } from "./runtimeDiagnostics.ts";
import { settleAllOrThrow } from "./settle.ts";
import {
  createRuntimeIdleController,
  type RuntimeIdleController,
} from "./runtimeIdle.ts";
import {
  createKeyedRuntimeOwner,
  type SharedRuntimeOccupancy,
} from "./runtimeOccupancy.ts";

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
  /** Optional packages root override used only for built web assets. */
  webPackagesDir?: string;
  /**
   * Statically bundled feature entries. Packaged hosts use this because their
   * server code lives in one bundle and cannot be found through filesystem
   * discovery. Omit it for the normal workspace package scan.
   */
  serverPackages?: readonly ServerPackageRegistration[];
}

/** Keep protocol identity behind the runtime pool's stable facade, including
 * lifecycle-backed runtimes and generation replacement. */
export function createRuntimeProtocolForwarder(
  current: () => AgentRuntime,
): NonNullable<AgentRuntime["protocol"]> {
  return async () => {
    const runtime = current();
    if (typeof runtime.protocol === "function") return runtime.protocol();
    const lifecycle = (
      runtime as AgentRuntime & {
        lifecycle?: Pick<Required<AgentRuntime>, "protocol">;
      }
    ).lifecycle;
    if (typeof lifecycle?.protocol === "function") return lifecycle.protocol();
    throw Object.assign(new Error("runtime protocol identity is unavailable"), {
      code: "unsupported",
    });
  };
}

/** A feature package entry supplied by a bundled host such as Electron. */
export interface ServerPackageRegistration {
  id: string;
  descriptor: PackageDescriptorDto;
  factory: ServerPackageFactory;
}

export { isPackageEnabled } from "./packages.ts";

export function openCodeRuntimeId(projectId: string, cwd: string): string {
  return createHash("sha256")
    .update(projectId)
    .update("\0")
    .update(resolve(cwd))
    .digest("hex")
    .slice(0, 24);
}

export function openCodeRemoteRuntimeId(
  connectionIdentity: string,
  projectId: string,
  cwd: string,
): string {
  return createHash("sha256")
    .update(connectionIdentity)
    .update("\0")
    .update(projectId)
    .update("\0")
    .update(posix.normalize(cwd))
    .digest("hex")
    .slice(0, 24);
}

export interface DataDirectoryLease {
  canonicalDataDir: string;
  release(): Promise<void>;
}

export interface RuntimeAdmissionBarrier {
  fenced(): boolean;
  admit<T>(action: () => Promise<T>): Promise<T>;
  run<T>(action: () => Promise<T>): Promise<T>;
  trackTurn(sessionId: string, active: boolean): void;
  drain<T>(action: () => Promise<T>): Promise<T>;
}

/** Reader/exclusive gate for turn admission versus config replacement.
 * Admissions join synchronously before their first await. An exclusive caller
 * fences new admissions, waits for current admissions to settle, then holds
 * the fence through its complete critical section. */
export function createRuntimeAdmissionBarrier(options?: {
  isShuttingDown?: () => boolean;
}): RuntimeAdmissionBarrier {
  let fenceDepth = 0;
  let activeAdmissions = 0;
  let exclusiveTail = Promise.resolve();
  const idleWaiters = new Set<() => void>();
  const activeTurns = new Set<string>();
  const turnIdleWaiters = new Set<() => void>();

  const waitForIdle = (): Promise<void> => {
    if (activeAdmissions === 0) return Promise.resolve();
    return new Promise<void>((resolveIdle) => {
      idleWaiters.add(resolveIdle);
    });
  };

  const waitForTurnsIdle = (): Promise<void> => {
    if (activeTurns.size === 0) return Promise.resolve();
    return new Promise<void>((resolveIdle) => {
      turnIdleWaiters.add(resolveIdle);
    });
  };

  const runExclusive = async <T,>(
    action: () => Promise<T>,
    waitForTurns: boolean,
  ): Promise<T> => {
    const previous = exclusiveTail;
    let releaseExclusive!: () => void;
    exclusiveTail = new Promise<void>((resolveExclusive) => {
      releaseExclusive = resolveExclusive;
    });
    fenceDepth += 1;
    try {
      await previous;
      await waitForIdle();
      if (waitForTurns) await waitForTurnsIdle();
      return await action();
    } finally {
      fenceDepth -= 1;
      releaseExclusive();
    }
  };

  return {
    fenced: () => fenceDepth > 0,
    async admit<T>(action: () => Promise<T>): Promise<T> {
      if (options?.isShuttingDown?.()) {
        throw Object.assign(
          new Error("runtime admission is fenced for shutdown"),
          { code: "shutting_down" },
        );
      }
      if (fenceDepth > 0) {
        throw Object.assign(
          new Error("runtime admission is fenced for configuration restart"),
          { code: "restart-deferred" },
        );
      }
      activeAdmissions += 1;
      try {
        return await action();
      } finally {
        activeAdmissions -= 1;
        if (activeAdmissions === 0) {
          for (const resolveIdle of idleWaiters) resolveIdle();
          idleWaiters.clear();
        }
      }
    },
    run: (action) => runExclusive(action, false),
    trackTurn(sessionId, active) {
      if (active) {
        activeTurns.add(sessionId);
      } else {
        activeTurns.delete(sessionId);
        if (activeTurns.size === 0) {
          for (const resolveIdle of turnIdleWaiters) resolveIdle();
          turnIdleWaiters.clear();
        }
      }
    },
    drain: (action) => runExclusive(action, true),
  };
}

/** Hold a kernel advisory lock through a tiny child whose stdin is owned by
 * this process. A stale file is harmless: exclusivity belongs to flock's open
 * file description and is released by the kernel when the process exits. */
export async function acquireDataDirectoryLease(dataDir: string): Promise<DataDirectoryLease> {
  mkdirSync(dataDir, { recursive: true });
  const canonicalDataDir = realpathSync.native(dataDir);
  const lockPath = join(canonicalDataDir, ".polyth-writer.lock");
  const holder: ChildProcessWithoutNullStreams = spawn(
    "flock",
    [
      "--exclusive",
      "--nonblock",
      lockPath,
      process.execPath,
      "-e",
      "process.stdout.write('locked\\n');process.stdin.resume()",
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      // Electron exposes its own binary as process.execPath. Running that
      // binary with -e starts another desktop instance unless Node mode is
      // explicit, causing the nested server to contend for this same lease.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  let holderInputError: Error | undefined;
  holder.stdin.on("error", (error) => { holderInputError = error; });

  await new Promise<void>((resolveLock, rejectLock) => {
    let output = "";
    let errorOutput = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectLock(error);
      else resolveLock();
    };
    const timer = setTimeout(() => {
      holder.kill();
      finish(new Error(`timed out acquiring the Polyth writer lease for ${canonicalDataDir}`));
    }, 5_000);
    holder.stdout.setEncoding("utf8");
    holder.stderr.setEncoding("utf8");
    holder.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes("locked\n")) finish();
    });
    holder.stderr.on("data", (chunk: string) => {
      if (errorOutput.length < 4_096) errorOutput += chunk;
    });
    holder.stdout.on("error", (error) => {
      if (!settled) {
        holder.kill();
        finish(new Error(`Polyth writer lease output failed: ${error.message}`));
      }
    });
    holder.stderr.on("error", (error) => {
      if (!settled) {
        holder.kill();
        finish(new Error(`Polyth writer lease diagnostics failed: ${error.message}`));
      }
    });
    holder.once("error", (error) => {
      finish(new Error(`OS advisory locking is unavailable: ${error.message}`));
    });
    holder.once("exit", (code) => {
      if (!settled) {
        finish(Object.assign(
          new Error(
            code === 1
              ? `another Polyth server already owns data directory ${canonicalDataDir}`
              : `failed to acquire the Polyth writer lease for ${canonicalDataDir}${errorOutput.trim() ? `: ${errorOutput.trim()}` : ""}`,
          ),
          { code: "data-directory-locked" },
        ));
      }
    });
  });

  let released = false;
  const waitForHolderExit = (timeoutMs: number): Promise<void> =>
    new Promise<void>((resolveExit, rejectExit) => {
      if (holder.exitCode !== null || holder.signalCode !== null) {
        resolveExit();
        return;
      }
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        holder.off("exit", onExit);
        holder.off("close", onExit);
        if (error) rejectExit(error);
        else resolveExit();
      };
      const onExit = (): void => finish();
      const timer = setTimeout(
        () => finish(new Error("timed out releasing the Polyth writer lease")),
        timeoutMs,
      );
      holder.once("exit", onExit);
      holder.once("close", onExit);
    });
  return {
    canonicalDataDir,
    async release() {
      if (released) return;
      released = true;
      if (holder.exitCode !== null || holder.signalCode !== null) return;
      if (!holderInputError && !holder.stdin.destroyed && !holder.stdin.writableEnded) {
        holder.stdin.end();
      } else {
        holder.kill("SIGTERM");
      }
      try {
        await waitForHolderExit(5_000);
      } catch (error) {
        holder.kill("SIGKILL");
        try {
          await waitForHolderExit(5_000);
        } catch (killError) {
          throw new AggregateError(
            [error, killError],
            "Polyth writer lease process could not be confirmed exited",
          );
        }
      }
    },
  };
}

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

type BrowserForWs = NonNullable<Parameters<typeof createWsGateway>[1]>;
type DictationForWs = NonNullable<Parameters<typeof createWsGateway>[2]>;
type ChatWorkspaceForWs = NonNullable<Parameters<typeof createWsGateway>[4]>;

export async function boot(opts: BootOptions = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 4400);
  opts.hostname ??= process.env.HOST;
  const requestedDataDir = resolve(opts.dataDir ?? process.env.POLYTH_DATA_DIR ?? "./data");
  const writerLease = await acquireDataDirectoryLease(requestedDataDir);
  const dataDir = writerLease.canonicalDataDir;
  try {
  // Warm the engine identity cache while the rest of boot (sweep, packages,
  // HTTP) runs so the first owned spawn does not wait on `--version`/`db path`
  // / hashing the OpenCode binary.
  void resolveOpenCodeBinary({
    ...(opts.opencode?.bin ? { bin: opts.opencode.bin } : {}),
    ...(opts.opencode?.binarySource
      ? { binarySource: opts.opencode.binarySource }
      : {}),
  })
    .then((binary) => inspectOpenCodeEngine(binary.executablePath))
    .catch(() => {});
  const openCodeRuntimesDir = join(dataDir, "runtimes", "opencode");
  await sweepOpenCodeRuntimes(openCodeRuntimesDir);
  const packagesDir = opts.packagesDir ?? resolve(__dirname, "../..");
  const bundledServerPackages = opts.serverPackages;
  const discoveredPackageManifests = bundledServerPackages
    ? []
    : await discoverServerPackages(packagesDir);
  const packageDescriptors = bundledServerPackages?.map((pkg) => pkg.descriptor)
    ?? discoveredPackageManifests.map((pkg) => pkg.descriptor);
  const routeRegistry = createRouteRegistry();
  const packageLifecycle = createPackageLifecycle(routeRegistry);
  let capabilityController: ReturnType<typeof createCapabilityProvisioningController> | null = null;

  // Sessions and package transitions can emit before WS attaches. This box
  // starts forwarding as soon as the live broadcaster is installed.
  let live: WsGateway | null = null;
  const broadcast: Broadcaster = {
    event: (e: SessionEvent) => live?.event(e),
    projection: (p: SessionProjection) => live?.projection(p),
    notification: (n, recipient) => live?.notification?.(n, recipient),
    pluginChanged: (packageId) => live?.pluginChanged?.(packageId),
    packageChanged: (pkg) => live?.packageChanged?.(pkg),
    clientSettingsChanged: (settings) => live?.clientSettingsChanged?.(settings),
    worktreesChanged: (projectId) => live?.worktreesChanged?.(projectId),
  };
  const packageRegistry = createPackageRegistry({
    file: `${dataDir}/packages.json`,
    descriptors: packageDescriptors,
    onSetEnabled: (id, enabled) => enabled
      ? packageLifecycle.enable(id)
      : packageLifecycle.disable(id),
    onChanged: (pkg) => {
      broadcast.packageChanged?.(pkg);
      if (capabilityController) {
        void capabilityController.reconcileAllActiveTargets().catch((error) => {
          console.warn("[polyth] capability reconcile after package change failed", error);
        });
      }
    },
  });

  // --- kernel composition root
  const root = createContext("root");
  const store = createStore(`${dataDir}/sessions.db`);
  await store.recoverExecutingOperations();
  for (const projection of await store.projections()) {
    const interrupted = (await store.operations(projection.id))
      .some((operation) => operation.state === "unknown");
    if (!interrupted || projection.status === "unknown" || projection.status === "archived") continue;
    await store.upsertProjection({
      ...projection,
      status: "unknown",
      updatedAt: Date.now(),
    });
  }
  root.provide(CAP.sessionPersistence, store);
  let shuttingDown = false;
  const isShuttingDown = (): boolean => shuttingDown;
  const beginShutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[polyth] server.shutdown.quiescing reason=signal");
  };
  const admissionBarrier = createRuntimeAdmissionBarrier({
    isShuttingDown,
  });
  let cleanupProjectCapabilities: (project: import("@polyth/contracts").Project) => void | Promise<void> = () => {};
  const projects = createProjectService(dataDir, {
    onRemoved: (project) => cleanupProjectCapabilities(project),
  });
  root.provide(CAP.projects, projects);

  // --- tenancy boundary. Built as early as possible so that package hosts,
  // route wiring, and the WS gateway can only ever be handed SCOPED services.
  // `sessions` is captured lazily: the session service is composed further
  // down from package-owned dependencies.
  let sessionsRef: SessionService | null = null;
  const { gateway: spaceGateway } = await createSpaceGateway({
    dataDir,
    registry: projects,
    store,
    sessions: () => {
      if (!sessionsRef) throw new Error("session service is not composed yet");
      return sessionsRef;
    },
  });
  const spaceServices = (ctx: Parameters<SpaceGateway["services"]>[0]) =>
    spaceGateway.services(ctx);


  // --- cross-package service seam. Discovered packages publish the services
  // they construct here; the composition root publishes the infrastructure
  // seams packages consume. Everything cross-package resolves lazily.
  const services = createServerServiceRegistry();
  const harnesses = createHarnessRegistry();
  services.provide(serverServiceKey("harnesses"), harnesses);
  const capabilityContributions = createCapabilityContributionRegistry();
  services.provide(serverServiceKey("harness.capabilities"), capabilityContributions);
  const provideService = <T,>(name: string, service: T): void =>
    services.provide(serverServiceKey<T>(name), service);
  const svc = <T,>(name: string): T | undefined => services.get(serverServiceKey<T>(name));
  const requireSvc = <T,>(name: string): T => services.require(serverServiceKey<T>(name));
  // The bootstrap owner exists even when local password auth is disabled.
  // Secondary account existence is wired to the auth store later in boot;
  // until then notification delivery for them fails closed.
  let notificationAccountExists = (userId: string): boolean => userId === "usr_owner";
  const notificationAccess = ({ userId, spaceId }: { userId: string; spaceId: string }): boolean =>
    notificationAccountExists(userId) && Boolean(spaceGateway.store.roleOf(userId, spaceId));
  provideService("tenancy.membership", {
    hasAccess: (userId: string, spaceId: string) => notificationAccess({ userId, spaceId }),
  });

  // --- per-project opencode runtime pool (lazy spawn, one serve process per project)
  const runtimeDiagnostics = createRuntimeDiagnostics();
  const openCodeRuntimes = createKeyedRuntimeOwner<AgentRuntime>();
  const occupancyByFacade = new WeakMap<AgentRuntime, SharedRuntimeOccupancy>();
  const runtimeRestarters = new Map<string, {
    runtime: AgentRuntime;
    restart(): Promise<void>;
    withConfigRestart<T>(
      action: (restart: () => Promise<void>) => Promise<T>,
    ): Promise<T>;
  }>();
  const runtimeRestartListeners = new Set<(runtime: AgentRuntime) => Promise<void>>();
  const runtimeEvictionListeners = new Set<
    (runtime: AgentRuntime) => void | Promise<void>
  >();
  let canEvictRuntime = async (
    _runtime: AgentRuntime,
    _inspectionRuntime: AgentRuntime,
    _expected: { authorityId: string; generation: number },
    _liveStreamSessionIds: readonly string[],
  ): Promise<{ safe: true } | { safe: false; reason: string }> => ({
    safe: false,
    reason: "runtime eviction safety is not initialized",
  });
  let runtimeCreationFenceDepth = 0;
  const sessionIdMap = new Map<string, string>(); // canonical -> backend
  const configDir = opts.opencode?.configDir ?? opts.opencode?.dataDir;
  const configIdentityProbe = createConfigApplier({
    ...(configDir ? { configDir } : {}),
  });
  const localConfigTargetId =
    opts.opencode?.configTargetId ?? configIdentityProbe.configTargetId!();
  const directConfigApplier = createConfigApplier({
    ...(configDir ? { configDir } : {}),
    targetId: localConfigTargetId,
    // Local configuration is writable only while an exact owned-local lease
    // for this target is live. SSH/borrowed-only pools remain read-only.
    authority: () => runtimeRestarters.size > 0
      ? { kind: "writable", targetId: localConfigTargetId }
      : { kind: "read-only" },
  });
  let refreshSafeBehavior: () => Promise<void> = async () => {};

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
    resolve(cwd ?? (await projects.get(projectId))?.path ?? process.cwd());

  // In-memory lifecycle key. Disk identity stays `openCodeRuntimeId` /
  // `openCodeRemoteRuntimeId` and must not change. Remote scope includes the
  // SSH connection; local does not.
  const sharedRuntimePoolKey = (
    projectId: string,
    cwd: string,
    connectionId?: string,
  ): string => `opencode:${connectionId ?? "local"}:${projectId}:${cwd}`;

  const spawnRuntime = async (projectId: string, cwd: string): Promise<AgentRuntime> => {
    // Remote-bound projects run `opencode serve` ON the remote host through
    // the SSH transport (one multiplexed channel + one forwarded port).
    const remoteBinding = (await projects.get(projectId))?.remote;
    if (remoteBinding?.kind === "ssh") {
      const ssh = svc<SshTransportService>("ssh");
      if (!ssh) {
        throw Object.assign(new Error("SSH support unavailable: the ssh package did not load"), { code: "unavailable" });
      }
      const remoteStateKey = openCodeRemoteRuntimeId(
        remoteBinding.connectionId,
        projectId,
        cwd,
      );
      return createRemoteOpenCodeRuntime({
        host: ssh.host(remoteBinding.connectionId),
        connectionIdentity: remoteBinding.connectionId,
        projectId,
        remotePath: cwd,
        remoteStateKey,
        ...(opts.opencode?.runtimeDir
          ? { runtimeDir: posix.join(opts.opencode.runtimeDir, remoteStateKey) }
          : {}),
        leaseStateFile: join(dataDir, "opencode-ssh", `${remoteStateKey}.lease.json`),
        sessionIdMap,
      });
    }
    const project = await projects.get(projectId);
    const spaceId = project ? spaceGateway.resolveInternal(project.spaceId).spaceId : undefined;
    const localStateKey = openCodeRuntimeId(projectId, cwd);
    return createOpenCodeRuntime({
        projectId, cwd, sessionIdMap,
        ...(spaceId ? { spaceId } : {}),
        ...(opts.opencode?.port ? { port: opts.opencode.port } : {}),
        ...(opts.opencode?.bin ? { bin: opts.opencode.bin } : {}),
        ...(opts.opencode?.binarySource
          ? { binarySource: opts.opencode.binarySource }
          : {}),
        ...(opts.opencode?.hostname ? { hostname: opts.opencode.hostname } : {}),
        ...(configDir ? { configDir } : {}),
        runtimeDir: join(openCodeRuntimesDir, localStateKey),
        stateFile: opts.opencode?.stateFile
          ?? join(dataDir, "opencode-local", `${localStateKey}.lease.json`),
        ...(opts.opencode?.protocol ? { protocol: opts.opencode.protocol } : {}),
        ...(opts.opencode?.startupDeadlineMs
          ? { startupDeadlineMs: opts.opencode.startupDeadlineMs }
          : {}),
        ...(opts.opencode?.probeDeadlineMs
          ? { probeDeadlineMs: opts.opencode.probeDeadlineMs }
          : {}),
        configTargetId: localConfigTargetId,
      });
  };

  // Stable facade per pool key. Neither queries nor mutations destructively
  // respawn it: owned replacement is admitted only through the pool restart
  // barrier, while lifecycle disconnect handling owns natural-death recovery.
  const facadeFor = (
    key: string,
    projectId: string,
    cwd: string,
    first: AgentRuntime,
    configRestartable: boolean,
    occupancy: SharedRuntimeOccupancy,
  ): { facade: AgentRuntime; dispose: () => Promise<void> } => {
    let inner = first;
    let idleController: RuntimeIdleController | undefined;
    const liveStreamSessionIds = new Set<string>();
    const setTurnActive = (sessionId: string, active: boolean): void => {
      const transient = sessionId.startsWith("oneshot-");
      if (active) {
        if (liveStreamSessionIds.has(sessionId)) return;
        if (!(transient
          ? occupancy.beginTransientExecution(sessionId)
          : occupancy.beginExecution(sessionId))) {
          throw Object.assign(
            new Error(`runtime ${occupancy.key} is not accepting executions`),
            { code: "unavailable" },
          );
        }
        liveStreamSessionIds.add(sessionId);
      } else if (!liveStreamSessionIds.delete(sessionId)) {
        return;
      } else {
        if (transient) occupancy.endTransientExecution(sessionId);
        else occupancy.endExecution(sessionId);
      }
      admissionBarrier.trackTurn(sessionId, active);
    };
    const clearActiveTurns = (): void => {
      for (const sessionId of liveStreamSessionIds) {
        admissionBarrier.trackTurn(sessionId, false);
        if (sessionId.startsWith("oneshot-")) occupancy.endTransientExecution(sessionId);
        else occupancy.endExecution(sessionId);
      }
      liveStreamSessionIds.clear();
    };
    const listeners = new Set<(sessionId: string, ev: RuntimeEvent) => void>();
    const observationListeners = new Set<
      Parameters<NonNullable<AgentRuntime["onObservation"]>>[0]
    >();
    const lifecycleListeners = new Set<
      Parameters<NonNullable<AgentRuntime["onLifecycle"]>>[0]
    >();
    const observeRuntimeEvent = (sessionId: string, ev: RuntimeEvent): void => {
      if (ev.type === "turn/started") setTurnActive(sessionId, true);
      else if (ev.type === "turn/stopped") setTurnActive(sessionId, false);
      idleController?.touch();
    };
    const fanout = (sessionId: string, ev: RuntimeEvent) => {
      observeRuntimeEvent(sessionId, ev);
      for (const cb of listeners) cb(sessionId, ev);
    };
    const fanoutObservation: Parameters<NonNullable<AgentRuntime["onObservation"]>>[0] =
      (sessionId, observation) => {
        for (const event of observation.events) observeRuntimeEvent(sessionId, event);
        for (const cb of observationListeners) cb(sessionId, observation);
      };
    const fanoutLifecycle: Parameters<NonNullable<AgentRuntime["onLifecycle"]>>[0] =
      (notification) => {
        idleController?.touch();
        for (const cb of lifecycleListeners) cb(notification);
      };
    const subscribeInner = (): Disposable[] => [
      inner.onEvent(fanout),
      ...(inner.onObservation ? [inner.onObservation(fanoutObservation)] : []),
      ...(inner.onLifecycle ? [inner.onLifecycle(fanoutLifecycle)] : []),
    ];
    let innerSubs = subscribeInner();
    let restarting: Promise<void> | null = null;

    type RuntimeReliabilityBridge = {
      endpoint(): Promise<RuntimeEndpoint>;
      protocol?(): Promise<"legacy" | "v2">;
      reconcile(
        binding: RuntimeSessionBinding & {
          protocol?: "legacy" | "v2";
          reconciliationOrdinal?: number;
        },
        after?: string,
      ): Promise<RuntimeSnapshot>;
    };
    const directReliability = (): Partial<RuntimeReliabilityBridge> =>
      inner as AgentRuntime & Partial<RuntimeReliabilityBridge>;
    const lifecycleReliability = (): Partial<RuntimeReliabilityBridge> | undefined =>
      (inner as AgentRuntime & { lifecycle?: Partial<RuntimeReliabilityBridge> }).lifecycle;
    const endpoint = async (): Promise<RuntimeEndpoint> => {
      const direct = directReliability();
      if (typeof direct.endpoint === "function") return direct.endpoint();
      const lifecycle = lifecycleReliability();
      if (typeof lifecycle?.endpoint === "function") return lifecycle.endpoint();
      throw Object.assign(new Error("runtime endpoint identity is unavailable"), {
        code: "unsupported",
      });
    };
    const protocol = createRuntimeProtocolForwarder(() => inner);
    const reconcile = async (
      binding: RuntimeSessionBinding & { reconciliationOrdinal?: number },
      after?: string,
    ): Promise<RuntimeSnapshot> => {
      const direct = directReliability();
      let snapshot: RuntimeSnapshot;
      if (typeof direct.reconcile === "function") {
        snapshot = await direct.reconcile(binding, after);
      } else {
        const lifecycle = lifecycleReliability();
        if (typeof lifecycle?.reconcile !== "function") {
          throw Object.assign(new Error("runtime reconciliation is unavailable"), {
            code: "unsupported",
          });
        }
        snapshot = await lifecycle.reconcile({ ...binding, protocol: await protocol() }, after);
      }
      if (snapshot.state.value === "running") setTurnActive(binding.canonicalSessionId, true);
      else if (snapshot.state.value !== "unknown") setTurnActive(binding.canonicalSessionId, false);
      return snapshot;
    };

    const respawnOnce = async (): Promise<void> => {
      for (const subscription of innerSubs) subscription.dispose();
      await inner.dispose().catch(() => {});
      inner = await spawnRuntime(projectId, cwd);
      clearActiveTurns();
      innerSubs = subscribeInner();
      await settleAllOrThrow(
        [...runtimeRestartListeners].map((listener) => listener(facade)),
      );
    };
    const replaceGeneration = async (): Promise<void> => {
      const lifecycle = (
        inner as AgentRuntime & {
          lifecycle?: {
            control: RuntimeEndpoint["control"];
            restart?(reason: "crash" | "config" | "manual"): Promise<RuntimeEndpoint>;
          };
        }
      ).lifecycle;
      if (lifecycle?.control.kind === "owned" && lifecycle.restart) {
        await lifecycle.restart("config");
        await settleAllOrThrow(
          [...runtimeRestartListeners].map((listener) => listener(facade)),
        );
        return;
      }
      // Compatibility runtimes without the lifecycle seam are replaced as a
      // unit. Production OpenCode runtimes always take the generation path.
      await respawnOnce();
    };
    const withConfigRestart = async <T,>(
      action: (restart: () => Promise<void>) => Promise<T>,
    ): Promise<T> => {
      const lifecycle = (
        inner as AgentRuntime & {
          lifecycle?: {
            control: RuntimeEndpoint["control"];
            withConfigRestart?<R>(
              action: (restart: () => Promise<RuntimeEndpoint>) => Promise<R>,
            ): Promise<R>;
          };
        }
      ).lifecycle;
      if (lifecycle?.control.kind === "owned" && lifecycle.withConfigRestart) {
        return lifecycle.withConfigRestart(async (restartGeneration) =>
          action(async () => {
            await restartGeneration();
            await settleAllOrThrow(
              [...runtimeRestartListeners].map((listener) => listener(facade)),
            );
          }));
      }
      // Compatibility runtimes have no autonomous lifecycle replacement path,
      // so the server-owned facade restart itself is the complete interlock.
      return action(restart);
    };
    const restart = (): Promise<void> => {
      if (!restarting) {
        restarting = replaceGeneration().finally(() => { restarting = null; });
      }
      return restarting;
    };

    const useRuntime = <T,>(action: () => Promise<T>): Promise<T> =>
      idleController ? idleController.use(action) : action();
    let disposal: Promise<void> | undefined;
    const teardownPhysical = (): Promise<void> => {
      if (disposal) return disposal;
      disposal = (async () => {
        for (const subscription of innerSubs) subscription.dispose();
        innerSubs = [];
        clearActiveTurns();
        await inner.dispose();
      })();
      return disposal;
    };
    const facade: AgentRuntime = {
      capabilities: () => useRuntime(() => inner.capabilities()),
      models: () => useRuntime(() => inner.models()),
      agents: () => useRuntime(() => inner.agents()),
      ...(inner.listAllProviders
        ? { listAllProviders: () => useRuntime(() => inner.listAllProviders!()) }
        : {}),
      ...(inner.providerAuthMethods
        ? { providerAuthMethods: () => useRuntime(() => inner.providerAuthMethods!()) }
        : {}),
      ...(inner.providerAuthorize
        ? {
            providerAuthorize: (providerID: string, method: number, inputs?: Record<string, string>) =>
              useRuntime(() => inner.providerAuthorize!(providerID, method, inputs)),
          }
        : {}),
      ...(inner.providerAuthCallback
        ? {
            providerAuthCallback: (providerID: string, method: number, code?: string) =>
              useRuntime(() => inner.providerAuthCallback!(providerID, method, code)),
          }
        : {}),
      ...(inner.setProviderApiKey
        ? {
            setProviderApiKey: (providerID: string, key: string, metadata?: Record<string, string>) =>
              useRuntime(() => inner.setProviderApiKey!(providerID, key, metadata)),
          }
        : {}),
      ...(inner.setProviderAuth
        ? {
            setProviderAuth: (providerID: string, info: import("@polyth/contracts").ProviderAuthWrite) =>
              useRuntime(() => inner.setProviderAuth!(providerID, info)),
          }
        : {}),
      ...(inner.removeProviderAuth
        ? { removeProviderAuth: (providerID: string) => useRuntime(() => inner.removeProviderAuth!(providerID)) }
        : {}),
      sessions: () => useRuntime(() => inner.sessions()),
      history: (sessionId) => useRuntime(() => inner.history(sessionId)),
      ensureSession: (canonical) => useRuntime(() => inner.ensureSession(canonical)),
      createSessionOperation: (canonical, operationId) =>
        useRuntime(() => inner.createSessionOperation
          ? inner.createSessionOperation(canonical, operationId)
          : Promise.resolve({
              kind: "unknown",
              operationId,
              message: "runtime lacks operation-aware session creation",
            })),
      async resetSession(canonical) {
        return useRuntime(async () => {
          if (!inner.resetSession) throw Object.assign(new Error("runtime cannot reset session history"), { code: "unsupported" });
          const backendSessionId = await inner.resetSession(canonical);
          setTurnActive(canonical.sessionId, false);
          return backendSessionId;
        });
      },
      resetSessionOperation: (canonical, operationId) =>
        useRuntime(async () => {
          const outcome = inner.resetSessionOperation
          ? inner.resetSessionOperation(canonical, operationId)
          : Promise.resolve({
              kind: "rejected" as const,
              code: "capability-unsupported",
              message: "runtime lacks operation-aware session reset",
            });
          const result = await outcome;
          if (result.kind === "confirmed") setTurnActive(canonical.sessionId, false);
          return result;
        }),
      // UX-MSG-ACTIONS: exact-history branching passes through the facade so
      // the session service never learns backend/OpenCode details.
      async branchSession(request) {
        return useRuntime(async () => {
          if (!inner.branchSession) throw Object.assign(new Error("runtime cannot branch exact history"), { code: "unsupported" });
          const backendSessionId = await inner.branchSession(request);
          setTurnActive(request.target.sessionId, false);
          return backendSessionId;
        });
      },
      branchSessionOperation: (request, operationId) =>
        useRuntime(async () => {
          const outcome = inner.branchSessionOperation
          ? inner.branchSessionOperation(request, operationId)
          : Promise.resolve({
              kind: "rejected" as const,
              code: "capability-unsupported",
              message: "runtime lacks operation-aware session branching",
            });
          const result = await outcome;
          if (result.kind === "confirmed") setTurnActive(request.target.sessionId, false);
          return result;
        }),
      async discardSession(sessionId) {
        await useRuntime(async () => {
          await inner.discardSession?.(sessionId);
          setTurnActive(sessionId, false);
        });
      },
      discardSessionOperation: (sessionId, operationId) =>
        useRuntime(async () => {
          const outcome = inner.discardSessionOperation
          ? inner.discardSessionOperation(sessionId, operationId)
          : Promise.resolve({
              kind: "unknown" as const,
              operationId,
              message: "runtime lacks operation-aware session deletion",
            });
          const result = await outcome;
          if (result.kind === "confirmed") setTurnActive(sessionId, false);
          return result;
        }),
      startTurn: (req) => useRuntime(async () => {
        setTurnActive(req.sessionId, true);
        try {
          await inner.startTurn(req);
        } catch (error) {
          setTurnActive(req.sessionId, false);
          throw error;
        }
      }),
      startTurnOperation: (req, operationId) =>
        useRuntime(async () => {
          setTurnActive(req.sessionId, true);
          const outcome = inner.startTurnOperation
          ? inner.startTurnOperation(req, operationId)
          : Promise.resolve({
              kind: "unknown" as const,
              operationId,
              message: "runtime lacks operation-aware turn submission",
            });
          const result = await outcome;
          if (result.kind === "rejected") setTurnActive(req.sessionId, false);
          return result;
        }),
      ...(inner.completeSmallModel
        ? { completeSmallModel: (request: Parameters<NonNullable<AgentRuntime["completeSmallModel"]>>[0]) =>
            useRuntime(() => inner.completeSmallModel!(request)) }
        : {}),
      steer: (sessionId, text) =>
        useRuntime(() => inner.steer?.(sessionId, text) ?? Promise.resolve(false)),
      steerOperation: (sessionId, text, operationId) =>
        useRuntime(() => inner.steerOperation
          ? inner.steerOperation(sessionId, text, operationId)
          : Promise.resolve({
              kind: "unknown",
              operationId,
              message: "runtime lacks operation-aware steering",
            })),
      abort: (sessionId) => useRuntime(() => inner.abort(sessionId)),
      abortOperation: (sessionId, operationId) =>
        useRuntime(() => inner.abortOperation
          ? inner.abortOperation(sessionId, operationId)
          : Promise.resolve({
              kind: "unknown",
              operationId,
              message: "runtime lacks operation-aware abort",
            })),
      replyPermission: (sessionId, requestId, reply) =>
        useRuntime(() => inner.replyPermission(sessionId, requestId, reply)),
      replyPermissionOperation: (sessionId, requestId, reply, operationId) =>
        useRuntime(() => inner.replyPermissionOperation
          ? inner.replyPermissionOperation(sessionId, requestId, reply, operationId)
          : Promise.resolve({
              kind: "unknown",
              operationId,
              message: "runtime lacks operation-aware permission reply",
            })),
      replyQuestion: (sessionId, requestId, answers) =>
        useRuntime(() => inner.replyQuestion(sessionId, requestId, answers)),
      replyQuestionOperation: (sessionId, requestId, answers, operationId) =>
        useRuntime(() => inner.replyQuestionOperation
          ? inner.replyQuestionOperation(sessionId, requestId, answers, operationId)
          : Promise.resolve({
              kind: "unknown",
              operationId,
              message: "runtime lacks operation-aware question reply",
            })),
      ...(inner.replySecret
        ? { replySecret: (sessionId: string, requestId: string, result: Parameters<NonNullable<AgentRuntime["replySecret"]>>[2]) =>
            useRuntime(() => inner.replySecret!(sessionId, requestId, result)) }
        : {}),
      ...(inner.replySecretOperation
        ? {
            replySecretOperation: (
              sessionId: string,
              requestId: string,
              result: Parameters<NonNullable<AgentRuntime["replySecretOperation"]>>[2],
              operationId: string,
            ) => useRuntime(() =>
              inner.replySecretOperation!(sessionId, requestId, result, operationId)),
          }
        : {}),
      releaseExecution: (binding, operationId) => admissionBarrier.run(async () => {
        if (!inner.releaseExecution) {
          return {
            kind: "unknown" as const,
            operationId,
            message: "This harness cannot prove execution has stopped",
          };
        }
        const outcome = await inner.releaseExecution(binding, operationId);
        if (outcome.kind !== "confirmed") return outcome;
        if (
          outcome.value.authorityId !== binding.authorityId
          || outcome.value.generation !== binding.generation
          || outcome.value.backendSessionId !== binding.backendSessionId
        ) {
          return {
            kind: "unknown" as const,
            operationId,
            message: "release proof does not name this execution incarnation",
          };
        }
        setTurnActive(binding.canonicalSessionId, false);
        return outcome;
      }),
      endpoint: () => useRuntime(endpoint),
      protocol: () => useRuntime(protocol),
      reconcile: (binding, after) => useRuntime(() => reconcile(binding, after)),
      onObservation(cb) {
        observationListeners.add(cb);
        return { dispose: () => { observationListeners.delete(cb); } };
      },
      onLifecycle(cb) {
        lifecycleListeners.add(cb);
        return { dispose: () => { lifecycleListeners.delete(cb); } };
      },
      onEvent(cb) {
        listeners.add(cb);
        return { dispose: () => { listeners.delete(cb); } };
      },
      dispose: async () => {
        await openCodeRuntimes.dispose(key);
      },
    };
    idleController = createRuntimeIdleController({
      withAdmissionBarrier: (action) => admissionBarrier.run(action),
      canEvict: async () => {
        const counters = occupancy.snapshot();
        if (counters.bindings > 0 || counters.executions > 0) return false;
        const expected = await endpoint();
        return (await canEvictRuntime(
          facade,
          inner,
          {
            authorityId: expected.authorityId,
            generation: expected.generation,
          },
          [...liveStreamSessionIds],
        )).safe;
      },
      evict: async () => {
        await facade.dispose();
      },
    });
    if (configRestartable) {
      runtimeRestarters.set(key, {
        runtime: facade,
        restart,
        withConfigRestart,
      });
    }
    stampRuntimeIdentity(facade, projectId, cwd);
    occupancyByFacade.set(facade, occupancy);
    return {
      facade,
      dispose: async () => {
        idleController?.stop();
        runtimeRestarters.delete(key);
        await teardownPhysical();
        await settleAllOrThrow(
          [...runtimeEvictionListeners].map(async (listener) => listener(facade)),
        );
      },
    };
  };

  const stampRuntimeIdentity = (runtime: AgentRuntime, projectId: string, cwd: string) => {
    Object.defineProperty(runtime, "projectId", { value: projectId, configurable: true });
    Object.defineProperty(runtime, "cwd", { value: cwd, configurable: true });
  };

  type RuntimeRestartFingerprint = {
    authorityId: string;
    generation: number;
  };
  type RuntimeRestartState = Map<string, RuntimeRestartFingerprint>;
  let reconcileRuntimeForConfigRestart = async (
    sessionId: string,
    _runtime: AgentRuntime,
    _expected: RuntimeRestartFingerprint,
  ): Promise<{ safe: true } | { safe: false; reason: string }> => ({
    safe: false,
    reason: `session ${sessionId} restart reconciliation is not initialized`,
  });

  const captureRuntimeRestartState = async (keys?: ReadonlySet<string>): Promise<RuntimeRestartState> => {
    const state: RuntimeRestartState = new Map();
    const entries = keys ? [...runtimeRestarters].filter(([key]) => keys.has(key)) : [...runtimeRestarters];
    await settleAllOrThrow(entries.map(async ([key, restarter]) => {
      const endpoint = await restarter.runtime.endpoint?.();
      if (!endpoint) {
        throw Object.assign(
          new Error(`runtime ${key} endpoint identity is unavailable for config restart`),
          { code: "restart-deferred" },
        );
      }
      state.set(key, {
        authorityId: endpoint.authorityId,
        generation: endpoint.generation,
      });
    }));
    return state;
  };

  const restartRuntimeEntries = async (
    expected?: RuntimeRestartState,
    keys?: ReadonlySet<string>,
  ): Promise<number> => {
    const entries = keys ? [...runtimeRestarters].filter(([key]) => keys.has(key)) : [...runtimeRestarters];
    const restarted = await settleAllOrThrow(entries.map(async ([key, restarter]) => {
      const prior = expected?.get(key);
      if (expected && !prior) {
        throw Object.assign(
          new Error(`runtime ${key} materialized after config restart capture`),
          { code: "restart-deferred" },
        );
      }
      if (prior) {
        const current = await restarter.runtime.endpoint?.().catch(() => undefined);
        if (
          current
          && (
            current.authorityId !== prior.authorityId
            || current.generation !== prior.generation
          )
        ) {
          // The config transaction holds every owned lifecycle replacement
          // lock, so drift here means the interlock was not established. A
          // generation number alone cannot prove which config was loaded.
          throw Object.assign(
            new Error(`runtime ${key} changed generation during config apply`),
            { code: "restart-deferred" },
          );
        }
      }
      const restart = activeConfigRestartCapabilities?.get(key);
      if (activeConfigRestartCapabilities && !restart) {
        throw Object.assign(
          new Error(`runtime ${key} is outside the config replacement interlock`),
          { code: "restart-deferred" },
        );
      }
      await (restart ?? restarter.restart)();
      return true;
    }));
    return restarted.filter(Boolean).length;
  };

  let activeConfigRestartCapabilities: ReadonlyMap<
    string,
    () => Promise<void>
  > | null = null;
  const withRuntimeReplacementInterlock = async <T,>(
    action: () => Promise<T>,
  ): Promise<T> => {
    runtimeCreationFenceDepth += 1;
    try {
      // A pool promise created before the synchronous fence may still be
      // installing its facade. Let it finish so it is included below.
      await openCodeRuntimes.settleCreates();
      const entries = [...runtimeRestarters];
      const capabilities = new Map<string, () => Promise<void>>();
      const acquire = async (index: number): Promise<T> => {
        const entry = entries[index];
        if (!entry) {
          activeConfigRestartCapabilities = capabilities;
          try {
            return await action();
          } finally {
            activeConfigRestartCapabilities = null;
          }
        }
        const [key, restarter] = entry;
        return restarter.withConfigRestart(async (restart) => {
          capabilities.set(key, restart);
          try {
            return await acquire(index + 1);
          } finally {
            capabilities.delete(key);
          }
        });
      };
      return await acquire(0);
    } finally {
      runtimeCreationFenceDepth -= 1;
    }
  };

  // Cold-boot `/api/models` (and the eager catalog warm-up below) fans out to
  // every project with Promise.allSettled. Spawning all `opencode serve`
  // processes at once OOMs/swap-thrashes the host — the Node event loop then
  // stalls in memory reclaim and HTTP stops answering. Cap concurrent first
  // spawns; cached lookups still share the same Promise.
  const maxConcurrentSpawns = Math.max(
    1,
    Number(process.env.POLYTH_RUNTIME_SPAWN_CONCURRENCY ?? 2) || 2,
  );
  let activeSpawns = 0;
  const spawnWaiters: Array<() => void> = [];
  const withSpawnSlot = async <T>(work: () => Promise<T>): Promise<T> => {
    // Re-check after every wake: a single release can race with a fresh
    // caller that saw the free slot first.
    while (activeSpawns >= maxConcurrentSpawns) {
      await new Promise<void>((resolve) => { spawnWaiters.push(resolve); });
    }
    activeSpawns += 1;
    try {
      return await work();
    } finally {
      activeSpawns -= 1;
      spawnWaiters.shift()?.();
    }
  };

  const occupancyOf = (runtime: AgentRuntime): SharedRuntimeOccupancy | undefined =>
    occupancyByFacade.get(runtime);

  const openCodePool: RuntimePool = {
    async forProject(projectId, cwd) {
      const dir = await cwdFor(projectId, cwd);
      const project = await projects.get(projectId);
      const connectionId = project?.remote?.kind === "ssh" ? project.remote.connectionId : undefined;
      const key = sharedRuntimePoolKey(projectId, dir, connectionId);
      if (isShuttingDown()) {
        const existing = openCodeRuntimes.peek(key);
        if (!existing) {
          throw Object.assign(
            new Error("runtime creation is fenced for shutdown"),
            { code: "shutting_down" },
          );
        }
        return existing.value;
      }
      if (runtimeCreationFenceDepth > 0 && !openCodeRuntimes.busy(key)) {
        throw Object.assign(
          new Error("runtime creation is fenced for configuration restart"),
          { code: "restart-deferred" },
        );
      }
      const record = await runtimeDiagnostics.observe(key, { projectId, cwd: dir }, () =>
        openCodeRuntimes.acquire(key, async (occupancy) => withSpawnSlot(async () => {
          // Physical creation flight. Harness-cache beforeCreate may have run
          // before this acquire waited out a previous dispose; that dispose's
          // onEvict drops the overlay. Reconcile here so spawn sees the overlay
          // for THIS generation.
          if (capabilityController) {
            const project = await projects.get(projectId);
            const space = spaceGateway.resolveInternal(project?.spaceId);
            const context = {
              projectId,
              spaceId: space.spaceId,
              space,
              cwd: dir,
              remote: Boolean(project?.remote),
            };
            await reconcilePinnedHarness(capabilityController, harnesses, "opencode", context);
          }
          const configRestartable = !(await projects.get(projectId))?.remote;
          const spawn = async () => {
            const built = facadeFor(
              key,
              projectId,
              dir,
              await spawnRuntime(projectId, dir),
              configRestartable,
              occupancy,
            );
            if (configRestartable) await refreshSafeBehavior();
            return { value: built.facade, dispose: built.dispose };
          };
          try {
            return await spawn();
          } catch (err) {
            if (!isTransportError(err)) throw err;
            return spawn();
          }
        })));
      return record.value;
    },
    async restartAll() {
      return restartRuntimeEntries();
    },
    onRestart(listener) {
      runtimeRestartListeners.add(listener);
      return { dispose: () => { runtimeRestartListeners.delete(listener); } };
    },
    onEvict(listener) {
      runtimeEvictionListeners.add(listener);
      return { dispose: () => { runtimeEvictionListeners.delete(listener); } };
    },
    bindSession(sessionId, runtime) {
      occupancyOf(runtime)?.acquireBinding(sessionId);
    },
    unbindSession(sessionId, runtime) {
      const occupancy = occupancyOf(runtime);
      if (!occupancy) return;
      occupancy.releaseBinding(sessionId, {
        abandonExecution: !occupancy.snapshot().accepting,
      });
    },
  };
  services.provide(serverServiceKey("opencode.runtime"), (context: import("@polyth/contracts").HarnessContext) =>
    openCodePool.forProject(context.projectId, context.cwd));
  services.provide(
    serverServiceKey<NonNullable<HarnessProvider["releaseExecution"]>>("opencode.runtime.release-execution"),
    async (context, binding, operationId) => {
      if (context.remote || process.platform !== "linux") {
        return { kind: "rejected", code: "unsupported", message: "local Linux runtime authority required" };
      }
      const localStateKey = openCodeRuntimeId(context.projectId, context.cwd);
      return releaseProcessExecution(
        join(openCodeRuntimesDir, localStateKey, "opencode.pid.json.supervisor.json"),
        binding,
        operationId,
      );
    },
  );
  services.provide(serverServiceKey<{
    onRestart(listener: (runtime: AgentRuntime) => void | Promise<void>): Disposable;
  }>("opencode.runtime.events"), {
    onRestart: (listener) => openCodePool.onRestart?.(async (runtime) => { await listener(runtime); })
      ?? { dispose() {} },
  });
  const harnessPool = createHarnessPool({
    registry: harnesses,
    legacyHarnessId: "opencode",
    async context(projectId, cwd, sessionId) {
      const project = await projects.get(projectId);
      const space = spaceGateway.resolveInternal(project?.spaceId);
      return { projectId, spaceId: space.spaceId, space, cwd: await cwdFor(projectId, cwd), sessionId, remote: Boolean(project?.remote) };
    },
    async releaseRuntime(runtime, dispose) {
      const occupancy = occupancyOf(runtime)?.snapshot();
      if (occupancy && (occupancy.bindings > 0 || occupancy.executions > 0)) return;
      await dispose();
    },
    async beforeCreate(provider, context) {
      if (!capabilityController) return;
      await capabilityController.reconcile(provider, context);
    },
  });
  const runtimes: RuntimePool = {
    ...harnessPool,
    restartAll: openCodePool.restartAll,
    onRestart: openCodePool.onRestart,
    onEvict: openCodePool.onEvict,
    bindSession: openCodePool.bindSession,
    unbindSession: openCodePool.unbindSession,
  };
  openCodePool.onEvict?.(async (runtime) => {
    try {
      harnessPool.forgetRuntime(runtime);
    } catch (err) {
      console.warn("[polyth] harness pool forgetRuntime on evict skipped", err);
    }
    if (!capabilityController) return;
    const projectId = (runtime as AgentRuntime & { projectId?: string }).projectId;
    const cwd = (runtime as AgentRuntime & { cwd?: string }).cwd;
    if (!projectId || !cwd) return;
    try {
      const project = await projects.get(projectId);
      const space = spaceGateway.resolveInternal(project?.spaceId);
      // Physical OpenCode eviction — not a session occupancy release.
      capabilityController.release({
        spaceId: space.spaceId,
        space,
        projectId,
        cwd,
        remote: Boolean(project?.remote),
      }, "opencode");
    } catch (err) {
      console.warn("[polyth] capability overlay release on evict skipped", err);
    }
  });
  // The server catalog cache and the harness snapshot cache both hold model
  // lists, so they are invalidated as one: a stale half is what makes "only
  // some models show up" survive until a restart.
  let invalidateModelCatalog = (): void => {};
  openCodePool.onRestart?.(async () => { harnesses.invalidate({ harnessId: "opencode" }); invalidateModelCatalog(); });
  const runtimeCatalog = createRuntimeCatalog({
    projects,
    runtimes,
    onModelsInvalidated: () => harnesses.invalidate({ harnessId: "opencode" }),
  });
  invalidateModelCatalog = () => runtimeCatalog.invalidateModels();
  services.provide(serverServiceKey<{
    invalidateModels(): void;
    models(): Promise<import("@polyth/contracts").ModelDescriptor[]>;
  }>("runtime.catalog"), {
    invalidateModels: () => runtimeCatalog.invalidateModels(),
    models: () => runtimeCatalog.models(),
  });

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
  const pendingOpenCode = createOpenCodePendingService({
    canRestart: async (captured, keys) => {
      const expected = captured as RuntimeRestartState | undefined;
      const assessments = await settleAllOrThrow((await store.projections()).map(async (projection) => {
        const project = await projects.get(projection.projectId);
        const cwd = projection.worktreePath ?? project?.path ?? process.cwd();
        const connectionId = project?.remote?.kind === "ssh" ? project.remote.connectionId : undefined;
        const key = sharedRuntimePoolKey(projection.projectId, cwd, connectionId);
        // A scoped restart (runtime-capabilities for one physical target)
        // must not be blocked by an unrelated project's live session — only
        // sessions on the restarting target(s) need to be safety-checked.
        if (keys && !keys.has(key)) return { safe: true as const };
        const restarter = runtimeRestarters.get(key);
        if (!restarter) return { safe: true as const };
        const fingerprint = expected?.get(key);
        if (!fingerprint) {
          return {
            safe: false as const,
            reason: `runtime ${key} was not captured before config restart`,
          };
        }
        return reconcileRuntimeForConfigRestart(
          projection.id,
          restarter.runtime,
          fingerprint,
        );
      }));
      const unsafe = assessments.find((assessment) => !assessment.safe);
      if (unsafe && !unsafe.safe) return unsafe;
      return { safe: true as const };
    },
    withAdmissionBarrier: (action) =>
      admissionBarrier.run(() => withRuntimeReplacementInterlock(action)),
    captureRestartState: (keys) => captureRuntimeRestartState(keys),
    restart: (state, keys) => restartRuntimeEntries(state as RuntimeRestartState | undefined, keys),
  });
  const configApplier = createDeferredConfigApplier(directConfigApplier, pendingOpenCode);
  provideService(
    "opencode.configuration-status",
    (context: HarnessContext): HarnessConfigurationMetadata | undefined =>
      inspectOpenCodeConfiguration(pendingOpenCode, context),
  );
  const secureSafe = createSecureSafeService({
    dataDir,
    onChanged: () => refreshSafeBehavior(),
  });
  const decorateBehavior = (text: string): string => {
    const base = text.trimEnd();
    const section = secureSafeBehaviorSection(`${dataDir}/forbidden-config.json`, secureSafe.manifest());
    return `${base}${base ? "\n\n" : ""}${section}\n`;
  };
  const reconcileLive = async (): Promise<void> => {
    if (!capabilityController) return;
    await capabilityController.reconcileAllActiveTargets();
  };
  const behavior = createBehaviorService({
    file: `${dataDir}/behavior.md`,
    policyFile: `${dataDir}/behavior-policy.json`,
    onChanged: reconcileLive,
    decorate: decorateBehavior,
  });
  refreshSafeBehavior = async () => {
    try {
      await reconcileLive();
    } catch (err) {
      console.warn("[polyth] Secure Safe behavior refresh skipped", err);
    }
  };
  await secureSafe.syncForbiddenConfig();
  const mcp = createMcpConfigService({
    dataDir,
    deployment: spaceGateway.deployment,
    defaultSpaceId: spaceGateway.resolveInternal().spaceId,
    assertProject: (space, projectId) => {
      if (projects.spaceOfProject(projectId) !== space.spaceId) {
        throw Object.assign(new Error("project not found"), { code: "not-found" });
      }
    },
    onChanged: async (space) => {
      await capabilityController?.reconcileSpace(space);
    },
  });
  cleanupProjectCapabilities = (project) => {
    if (!project.spaceId) return;
    const space = spaceGateway.resolveInternal(project.spaceId);
    mcp.removeProject(space, project.id);
    svc<{ removeProject(space: import("@polyth/contracts").SpaceContext, projectId: string): void }>("skills")
      ?.removeProject(space, project.id);
  };

  // Provider/model visibility: seeds from opencode.json (disabled_providers +
  // provider blacklists), then mirrors every toggle back to it.
  const visibility = createModelVisibilityService({ file: `${dataDir}/model-visibility.json`, applier: configApplier });
  await visibility.seed();

  // An empty Polyth MCP store adopts whatever OpenCode already has configured,
  // so the settings page reflects reality instead of an empty list. Adoption is
  // default-Space + local-trusted only.
  const defaultSpace = spaceGateway.resolveInternal();
  if (spaceGateway.deployment === "local-trusted" && mcp.list(defaultSpace).length === 0) {
    try {
      for (const entry of mcpEntriesFromBackendConfig(await configApplier.readConfig())) {
        await mcp.create(defaultSpace, entry).catch((err: unknown) =>
          console.warn(`[polyth] MCP seed skipped for "${entry.name}"`, err));
      }
    } catch (err) {
      console.warn("[polyth] MCP seed from backend config skipped", err);
    }
  }
  let requestAgentToolPermission:
    RuntimeEpochSessionService["requestAgentToolPermission"] | undefined;
  let resolveAgentToolSession: RuntimeEpochSessionService["resolveAgentToolSession"] | undefined;
  const agentTools = createAgentToolBridge({
    executor: (id) => capabilityContributions.executor(id),
    contribution: (id) => capabilityContributions.contribution(id),
    resolveSession: (grant) => resolveAgentToolSession?.(grant) ?? Promise.resolve(undefined),
    requested: async (tool, grant) => {
      const event = await store.append(grant.sessionId!, "package-tool/requested", {
        toolId: tool.id, toolName: tool.name, owner: tool.owner,
      }, { ignorable: true, producerPlugin: tool.owner });
      broadcast.event(event);
    },
    authorize: async (tool, grant, signal) => {
      const ownerAllowed = (() => {
        if (tool.owner === "polyth") return true;
        try {
          const space = spaceGateway.resolveInternal(grant.spaceId);
          const context = {
            spaceId: grant.spaceId,
            projectId: grant.projectId,
            cwd: grant.cwd,
            space,
            ...(grant.sessionId ? { sessionId: grant.sessionId } : {}),
          };
          const managed = svc<import("@polyth/plugins").PluginRegistry>("plugins.managed");
          if (managed?.has(tool.owner)) {
            const storage = createSpaceStorage(space.storageDir);
            if (managed.detail(tool.owner, storage).runtimeKind === "sandboxed") return false;
            return managed.isEnabled(tool.owner, storage);
          }
          const known = packageRegistry.get(tool.owner);
          return known ? known.enabled : true;
        } catch {
          return false;
        }
      })();
      if (!ownerAllowed) return "deny";
      const permissions = svc<{
        evaluate(permission: string, patterns: string[], projectId?: string, sessionId?: string): "allow" | "deny" | "ask";
      }>("permissions");
      if (tool.trust === "pure" && tool.mutating === false) {
        return permissions?.evaluate("package-tool", [tool.id], grant.projectId, grant.sessionId) === "deny"
          ? "deny"
          : "allow";
      }
      const verdict = permissions?.evaluate("package-tool", [tool.id], grant.projectId, grant.sessionId) ?? "ask";
      if (verdict === "allow") return "allow";
      if (verdict === "deny") return "deny";
      if (!requestAgentToolPermission) return "permission-required";
      try {
        return await requestAgentToolPermission({
          spaceId: grant.spaceId,
          projectId: grant.projectId,
          cwd: grant.cwd,
          ...(grant.harnessId ? { harnessId: grant.harnessId } : {}),
          ...(grant.sessionId ? { sessionId: grant.sessionId } : {}),
          signal,
          toolId: tool.id,
          toolName: tool.name,
          owner: tool.owner,
        });
      } catch {
        return "deny";
      }
    },
  });
  capabilityController = createCapabilityProvisioningController({
    contributions: capabilityContributions,
    harnesses,
    behavior,
    mcp,
    file: `${dataDir}/capability-status.json`,
    contributionAllowed: (owner, context) => {
      if (owner === "polyth") return true;
      const managed = svc<import("@polyth/plugins").PluginRegistry>("plugins.managed");
      if (managed?.has(owner)) {
        if (!context.space) return false;
        const storage = createSpaceStorage(context.space.storageDir);
        const detail = managed.detail(owner, storage);
        if (detail.runtimeKind === "sandboxed") return false;
        return managed.isEnabled(owner, storage);
      }
      const known = packageRegistry.get(owner);
      return known ? known.enabled : true;
    },
    onOpenCodeCapabilityRestart: (context, desiredRevision) => {
      // Stage synchronously. pending-restart is only raised for a live
      // physical generation, so `runtimeRestarters` already holds the exact
      // pool key (local or remote). An async `projects.get` here used to
      // leave applyAndRestart racing an empty queue.
      const fallback = sharedRuntimePoolKey(context.projectId, context.cwd);
      pendingOpenCode.stage({
        id: `runtime-capabilities:${context.spaceId}:${context.projectId}:${context.cwd}`,
        kind: "runtime-capabilities",
        label: "OpenCode runtime capabilities",
        desiredRevision,
        restartKeys: physicalRestartKeysFor(
          runtimeRestarters.keys(),
          context.projectId,
          context.cwd,
          fallback,
        ),
        apply: async () => {},
      });
    },
    onOpenCodeCapabilitySettled: (input) => {
      pendingOpenCode.settleRuntimeCapabilities(input);
    },
    tools: agentTools,
    toolsEndpoint: () => `http://127.0.0.1:${port}${AGENT_TOOLS_PATH}`,
  });
  provideService("harness.provisioning", {
    status: (context: import("@polyth/contracts").HarnessContext, harnessId?: string) =>
      capabilityController!.status(context, harnessId),
    reconcileSpace: (space: Pick<import("@polyth/contracts").SpaceContext, "spaceId">) =>
      capabilityController!.reconcileSpace(space),
  });

  // Infrastructure seams consumed by discovered packages.
  provideService("secure-safe", secureSafe);
  provideService("plugins.config", configApplier);
  provideService("models.visibility", visibility);
  provideService("models.invalidate-catalog", () => { runtimeCatalog.invalidateModels(); });
  // The probe stays bound here so no feature package ever imports
  // backend-opencode; routes consuming it never learn OpenCode specifics.
  provideService("ssh.probe-runtime", async (connectionId: string) => {
    const ssh = svc<SshTransportService>("ssh");
    if (!ssh) {
      throw Object.assign(new Error("SSH support unavailable: the ssh package did not load"), { code: "unavailable" });
    }
    return probeRemoteOpenCode(ssh.host(connectionId));
  });
  provideService("ssh.install-runtime", async (connectionId: string) => {
    const ssh = svc<SshTransportService>("ssh");
    if (!ssh) {
      throw Object.assign(new Error("SSH support unavailable: the ssh package did not load"), { code: "unavailable" });
    }
    await installRemoteOpenCode(ssh.host(connectionId));
  });

  // --- F18: web push (VAPID keys minted once into the data dir) + the
  // notifier bridging the session service's attention/turn-stopped seam.
  // Auto-accepted permissions never reach this seam, so they never push.
  const push = createPushService({
    file: `${dataDir}/push.json`,
    hasAccess: notificationAccess,
  });
  // NTF-01: durable inbox recorded at the ONE transition-tight seam — the
  // notifier's send sink, after buildPushPayload. Order per record: JSON
  // store commit → recipient-filtered WS broadcast → independent Web/native
  // push attempts. A transport failure keeps the durable row; a store failure
  // emits nothing (contained by the notifier's fire-and-forget boundary). /api/push/test calls
  // push.send directly and therefore never creates a centre row.
  const notifications = createNotificationStore({
    file: `${dataDir}/notifications.json`,
    hasAccess: notificationAccess,
  });
  const nativePush = createNativePushService({
    file: `${dataDir}/native-push.json`,
    relayOrigin: process.env.POLYTH_NATIVE_PUSH_RELAY_ORIGIN,
    authority: () => svc<import("./nativePush.ts").NativePushAuthority>("tunnel.native-push"),
  });
  const pushNotifier = createPushNotifier({
    send: async (payload) => {
      const { key, projectId } = payload;
      if (!key || !payload.sessionId || !projectId) {
        throw Object.assign(new Error("notification payload missing key/session/project"), { code: "invalid-input" });
      }
      // Ownership: the target session (when it still exists) must belong to
      // the payload's project before the record is published.
      const target = await store.projection(payload.sessionId);
      if (!target || target.projectId !== projectId || !target.spaceId) {
        throw Object.assign(new Error("notification target belongs to another project"), { code: "invalid-input" });
      }
      const recipient = await notifications.recipientForSession(payload.sessionId, { spaceId: target.spaceId });
      if (!recipient) return;
      const record = await notifications.add(recipient, {
        key, kind: payload.kind, sessionId: payload.sessionId, projectId,
        title: payload.title, body: payload.body,
      });
      if (!record) return;
      broadcast.notification?.(record, recipient);
      // Delivery transports are independent best-effort legs after the
      // durable row + WS fan-out. A failed or stalled leg cannot suppress the
      // other, and this whole sink remains behind the notifier's detached fire.
      await Promise.allSettled([
        push.send(recipient, payload),
        nativePush.send({
          userId: recipient.userId, spaceId: recipient.spaceId,
          notificationId: record.id, kind: record.kind, transitionKey: record.key,
        }),
      ]);
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
  const httpAdmission = createHttpAdmission();
  const lazySessions: SessionService = new Proxy({} as SessionService, {
    get(_target, property) {
      httpAdmission.assertLive();
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
  const attachedHttpServers = new WeakSet<import("node:http").Server>();
  let httpHandlerRef: import("./http.ts").HttpHandler | null = null;
  const pairedSockets = new PairedSocketRegistry();
  const attachHttpChannels = (ctx: HttpServerContext): void => {
    if (attachedHttpServers.has(ctx.server)) return;
    attachedHttpServers.add(ctx.server);
    for (const cb of httpServerCallbacks) cb(ctx);
    live?.attach(ctx.server, {
      authorize: ctx.authorize,
      identity: ctx.identity,
      refreshPrincipal: ctx.refreshPrincipal,
      pairedSockets: ctx.pairedSockets,
    });
  };
  const onHttpServer = (cb: (ctx: HttpServerContext) => void): void => {
    httpServerCallbacks.push(cb);
    if (httpServerContext) cb(httpServerContext);
  };
  const startTunnelIngress = async (opts: {
    socketPath: string;
    secret: string;
    lookup(connectionId: string): Extract<import("@polyth/contracts").RequestIngress, { kind: "polyth-link" }> | null;
  }) => {
    if (!httpHandlerRef) {
      throw Object.assign(new Error("HTTP handler not ready"), { code: "unavailable" });
    }
    const handle = createTunnelIngress({
      handler: httpHandlerRef,
      secret: opts.secret,
      socketPath: opts.socketPath,
      lookup: opts.lookup,
      resolve: (request, ingress) => auth.resolve(request, ingress),
      attachChannels: attachHttpChannels,
      pairedSockets,
    });
    await handle.listen();
    return { close: () => handle.close() };
  };
  const queuedPairedResolvers: Array<(ingress: Extract<import("@polyth/contracts").RequestIngress, { kind: "polyth-link" }>) => import("@polyth/contracts").AuthPrincipal | null> = [];
  type PairedDeviceResolverFn = typeof queuedPairedResolvers[number];
  let attachLivePairedResolver: ((resolver: PairedDeviceResolverFn) => void) | null = null;
  const attachPairedDeviceResolver = (
    resolver: (ingress: Extract<import("@polyth/contracts").RequestIngress, { kind: "polyth-link" }>) => import("@polyth/contracts").AuthPrincipal | null,
  ): void => {
    queuedPairedResolvers.push(resolver);
    attachLivePairedResolver?.(resolver);
  };

  const smallModels = createSmallModelService(store);

  // Server-persisted, cross-device client preferences. Created here (ahead of
  // the settings route) so small-model generation can honour the model the user
  // picked in Settings → Sessions → Small Model, not just POLYTH_SMALL_MODEL.
  const clientSettings = createClientSettings({ file: `${dataDir}/client-settings.json` });
  const resolveSmallModel = (userId?: string): ({ providerID: string; modelID: string } & { harnessId?: string }) | undefined =>
    (userId ? smallModelPreference(clientSettings.get(userId).settings) : undefined)
    ?? smallModel();

  const packageSpaces = () =>
    spaceGateway.store.allSpaces().map((space) => ({
      spaceId: space.id,
      storage: createSpaceStorage(spaceStorageDir(dataDir, space)),
    }));

  const hostFor = (id: string): ServerPackageHost => ({
    ...packageHost,
    pluginId: id,
    services: bindPackageServices(services, id),
    ...(id === "plugins" ? { packageSpaces } : {}),
  });

  const packageHost: Omit<ServerPackageHost, "pluginId"> = {
    forSpace: spaceServices,
    storageDir: dataDir,
    deployment: spaceGateway.deployment,
    spaceStorage: (ctx) => createSpaceStorage(ctx.storageDir),
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
    oneShot: (runtime, options) => oneShot(runtime, options, store),
    smallModelComplete: (runtime, options) => smallModels.complete(runtime, options),
    smallModelInputBudget: (runtime, model, maxOutputTokens) => smallModels.inputBudget(runtime, model, maxOutputTokens),
    smallModel: resolveSmallModel,
    resolveSessionRuntime,
    loadPlugin: (plugin) => loadPlugin(root, plugin, {}),
    onHttpServer,
    attachHttpChannels,
    startTunnelIngress,
    remotePolicies: () => routeRegistry.policies(),
    attachPairedDeviceResolver,
    closePairedDevice: (deviceId: string) => pairedSockets.closeDevice(deviceId),
    pairedSockets,
  };
  const discoveredPackages = await (bundledServerPackages
    ? (async () => {
      const registered: string[] = [];
      for (const source of bundledServerPackages) {
        try {
          const pkg = await source.factory(hostFor(source.id));
          registerServerPackage({ lifecycle: packageLifecycle, routes: routeRegistry }, source.id, pkg);
          registered.push(source.id);
        } catch (error) {
          console.error(`[polyth] server package "${source.id}" failed to load`, error);
        }
      }
      return registered;
    })()
    : registerDiscoveredPackages({
      packagesDir,
      discovered: discoveredPackageManifests,
      host: packageHost,
      hostFor,
      lifecycle: packageLifecycle,
      routes: routeRegistry,
      onError: (id, error) => console.error(`[polyth] server package "${id}" failed to load`, error),
    }));
  if (discoveredPackages.length > 0) {
    console.log(`[polyth] discovered server packages: ${discoveredPackages.join(", ")}`);
  }

  // --- session service composition. Package-owned dependencies come from the
  // registry; optional seams degrade honestly when a package failed to load.
  const gitService = svc<TrackWorkflowDeps["git"]>("git");
  const terminalService = svc<TrackWorkflowDeps["terminals"]>("terminal");
  const commandService = svc<CommandExpandService>("commands");
  // Attachment preparation seam (stat + `_inbox/*` materialize). Optional: if
  // the files package failed to load it is absent and the session service
  // raises a typed error for any staged `_inbox/*` attachment.
  const attachmentGuard = svc<NonNullable<SessionDeps["attachments"]>>("files.attachments");
  const workspaceInstructions = svc<NonNullable<SessionDeps["workspaceInstructions"]>>(
    "files.workspace-instructions",
  );
  // Workspace policy is fail-closed when its opt-in setting is enabled:
  // without the files-owned reader Polyth cannot establish that AGENTS.md is
  // absent, so it must not admit a turn as though no repository instructions
  // existed.
  const requiredWorkspaceInstructions: NonNullable<SessionDeps["workspaceInstructions"]> =
    workspaceInstructions ?? {
      async read() {
        throw Object.assign(new Error("Workspace instructions are unavailable"), { code: "unavailable" });
      },
    };
  const autoAcceptStore = svc<NonNullable<SessionDeps["autoAccept"]>>("permissions.auto-accept");
  const browserArtifactsDir = join(dataDir, "browser-artifacts");
  const resolveBrowserArtifact = async (id: string) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(id)) return null;
    const mimeFor = (ext: string) =>
      ext === "png" ? "image/png"
        : ext === "webp" ? "image/webp"
          : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
            : "application/octet-stream";
    const { stat } = await import("node:fs/promises");
    const folders = ["draft", "committed", ""] as const;
    for (const folder of folders) {
      for (const ext of ["jpg", "jpeg", "png", "webp", "bin"] as const) {
        const localPath = folder
          ? join(browserArtifactsDir, folder, `${id}.${ext}`)
          : join(browserArtifactsDir, `${id}.${ext}`);
        try {
          const st = await stat(localPath);
          if (!st.isFile()) continue;
          return { id, mime: mimeFor(ext), size: st.size, localPath };
        } catch {
          // try next location
        }
      }
    }
    return null;
  };
  const commitBrowserArtifacts = async (ids: ReadonlyArray<string>) => {
    const { mkdir, rename } = await import("node:fs/promises");
    const committedDir = join(browserArtifactsDir, "committed");
    await mkdir(committedDir, { recursive: true });
    for (const id of ids) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(id)) continue;
      for (const ext of ["jpg", "jpeg", "png", "webp", "bin"] as const) {
        try {
          await rename(
            join(browserArtifactsDir, "draft", `${id}.${ext}`),
            join(committedDir, `${id}.${ext}`),
          );
        } catch {
          // already committed or never a draft
        }
      }
    }
  };

  const sessions = createSessionService({
    store,
    redactToolInput: (toolName, input) => {
      const descriptor = capabilityContributions.list().map((item) => item.descriptor).find((item) =>
        item.kind === "tool" && (item.name === toolName || toolName.endsWith(`__${item.name}`) || toolName.endsWith(`_${item.name}`)));
      return descriptor?.kind === "tool" ? redactToolInput(input, descriptor.inputSchema) : input;
    },
    projects, runtimes, broadcast, queue: store, org: store, profiles: store, behavior, secureSafe,
    harnesses: {
      staticFeatures: (harnessId) =>
        harnesses.providers().find((provider) => provider.descriptor.id === harnessId)?.staticFeatures,
      displayName: (harnessId) =>
        harnesses.providers().find((provider) => provider.descriptor.id === harnessId)?.descriptor.name,
    },
    admission: admissionBarrier,
    isShuttingDown,
    permissions: requireSvc<SessionDeps["permissions"]>("permissions"),
    instructionProvisioned: async (sessionId, harnessId) => {
      if (!capabilityController) return false;
      const proj = await store.projection(sessionId);
      if (!proj) return false;
      const project = await projects.get(proj.projectId);
      const space = spaceGateway.resolveInternal(project?.spaceId);
      return capabilityController.instructionState({
        space,
        spaceId: space.spaceId,
        projectId: proj.projectId,
        cwd: proj.worktreePath ?? project?.path ?? process.cwd(),
        sessionId,
        remote: Boolean(project?.remote),
      }, harnessId);
    },
    onSessionReleased: async ({ sessionId, projectId, cwd }) => {
      const project = await projects.get(projectId);
      const space = spaceGateway.resolveInternal(project?.spaceId);
      // Session occupancy ended. Physical-runtime targets stay until eviction.
      capabilityController?.release({
        spaceId: space.spaceId,
        space,
        projectId,
        cwd,
        sessionId,
        remote: Boolean(project?.remote),
      });
    },
    onHarnessTargetReleased: async ({ sessionId, projectId, cwd, harnessId }) => {
      const project = await projects.get(projectId);
      const space = spaceGateway.resolveInternal(project?.spaceId);
      // Session released this harness's execution occupancy. Physical OpenCode
      // overlays remain while sibling sessions still occupy the runtime.
      capabilityController?.release({
        spaceId: space.spaceId,
        space,
        projectId,
        cwd,
        sessionId,
        remote: Boolean(project?.remote),
      }, harnessId);
    },
    ...(gitService ? { worktrees: gitService.worktrees } : {}),
    ...(terminalService ? { shell: terminalService } : {}),
    // Legacy F18 JSON is supplied only for one-way migration. New explicit
    // choices live with the canonical session projection.
    ...(autoAcceptStore ? { autoAccept: autoAcceptStore } : {}),
    notify: pushNotifier,
    ...(attachmentGuard ? { attachments: attachmentGuard } : {}),
    workspaceInstructions: requiredWorkspaceInstructions,
    workspaceInstructionsEnabled: async () => {
      try {
        return (await behavior.workspaceInstructionsPolicy()).enabled;
      } catch {
        // A missing or unreadable setting must not turn an opt-in feature on.
        return false;
      }
    },
    browserArtifacts: { resolve: resolveBrowserArtifact, commit: commitBrowserArtifacts },
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
      runtimeEpochContext: async (sessionId, events) => {
        const goal = await ensureGoalState(sessionId);
        const objective = goal?.status === "active" ? goal.objective : undefined;
        return {
          ...(objective ? { objective } : {}),
          pinned: activePinnedMessages(events),
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
        const isolation = svc<{ onTurnCompleted(sessionId: string, events: readonly import("@polyth/contracts").SessionEvent[]): Promise<unknown> }>("isolation");
        if (isolation) {
          void store.events(sessionId)
            .then((events) => isolation.onTurnCompleted(sessionId, events))
            .catch((err: unknown) => console.error("[polyth] isolation turn completion failed", err));
        }
      },
      onUsage: (sessionId, tokens) => goalService()?.recordUsage(sessionId, { ...tokens, cacheRead: 0, cacheWrite: 0 }),
    },
  });
  requestAgentToolPermission = sessions.requestAgentToolPermission.bind(sessions);
  resolveAgentToolSession = sessions.resolveAgentToolSession.bind(sessions);
  sessionsImpl = sessions;
  reconcileRuntimeForConfigRestart = (sessionId, runtime, expected) =>
    sessions.reconcileForRuntimeRestart(sessionId, runtime, expected);
  canEvictRuntime = (runtime, inspectionRuntime, expected, liveStreamSessionIds) =>
    sessions.canEvictRuntime(
      runtime,
      inspectionRuntime,
      expected,
      liveStreamSessionIds,
    );
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
  const assistComplete = async (
    sessionId: string,
    prompt: string,
    maxOutputTokens = 1_024,
    userId?: string,
  ): Promise<string> => {
    const proj = await store.projection(sessionId);
    const project = proj ? await projects.get(proj.projectId) : null;
    // Prefer the configured small model, then the session's own known-good
    // model. Direct provider transport is tried first with a session fallback.
    const route = smallModelExecutionRoute(resolveSmallModel(userId), proj);
    const rt = await runtimes.forProject(proj?.projectId ?? "__default__", project?.path, route.harnessId);
    const { text } = await smallModels.complete(rt, {
      cwd: project?.path ?? process.cwd(),
      prompt,
      ...(route.model ? { model: route.model } : {}),
      maxOutputTokens,
      timeoutMs: 90_000,
    });
    return text;
  };
  const manualSuggestion = createManualSuggestionService({
    latestSeq: (sessionId) => store.latestSeq(sessionId),
    events: (sessionId) => store.events(sessionId),
    complete: assistComplete,
  });
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
    cookieName: `polyth_auth_p${port}`,
  });
  notificationAccountExists = (userId) => userId === "usr_owner" || auth.hasCredential(userId);
  attachLivePairedResolver = (resolver) => auth.attachPairedDeviceResolver(resolver);
  for (const resolver of queuedPairedResolvers) auth.attachPairedDeviceResolver(resolver);

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
    clientSettings,
    broadcastClientSettings: (state) => broadcast.clientSettingsChanged?.(state),
    saveRole: async (name, role) => {
      await configApplier.applyAgent(name, role);
      const current = (await runtimeCatalog.agents()).find((agent) =>
        agent.name === name && (!agent.harnessId || agent.harnessId === "opencode"));
      const saved = {
        harnessId: "opencode",
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

  sessionsRef = sessions;

  // Server-internal packages (no packages/<dir> counterpart) stay hand-wired.
  registerPackageRoute("projects", projectRoutes(spaceServices));
  registerPackageRoute("mcp", async (request) =>
    request.path.startsWith("/api/mcp/") ? settingsRoute(request) : false);

  const staticCoreRoutes: RouteHandler[] = [
    async (request) => agentTools.route(request),
    authRoutes(auth, {
      onAccountRemoved: async (userId) => {
        // Purge all durable delivery ownership before removing the credential;
        // recreating the same stable account id must never adopt stale routes.
        await notifications.removeAccount(userId);
        push.removeAccount(userId);
        await nativePush.removeAccount(userId);
      },
    }),
    spaceRoutes({
      store: spaceGateway.store,
      resolver: spaceGateway.resolver,
      audit: spaceGateway.audit,
      setActiveSpaceCookie: (rc, spaceId) => rc.res.setHeader(
        "set-cookie",
        spaceCookieHeader({
          name: spaceGateway.cookieName,
          spaceId,
          secure: rc.ingress.kind === "public-http" ? rc.ingress.secure : true,
        }),
      ),
    }),
    opencodePendingRoutes(pendingOpenCode),
    packageRoutes(packageRegistry),
    contextRoutes(spaceServices),
    orgRoutes({ spaces: spaceServices, store }),
    assistRoutes({
      settings: assistSettings,
      projection: (sessionId) => store.projection(sessionId),
      latestSeq: (sessionId) => store.latestSeq(sessionId),
      suggestion: (space, sessionId, draft) => manualSuggestion.generate(sessionId, draft, space.userId),
      improve: async (space, projectId, draft) => {
        const project = await spaceServices(space).projects.get(projectId);
        if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
        const model = resolveSmallModel(space.userId);
        const runtime = await runtimes.forProject(projectId, project.path, model?.harnessId);
        const { text } = await smallModels.complete(runtime, {
          cwd: project.path,
          prompt: buildPromptImprovementPrompt(draft),
          ...(model ? { model } : {}),
          maxOutputTokens: 1_024,
          timeoutMs: 90_000,
          purpose: "prompt-generation",
        });
        return sanitizeNextActionReply(text, PROMPT_IMPROVEMENT_OUTPUT_MAX_CHARS);
      },
      distill: async (space, sessionId) => {
        const transcript = await assistTranscript(sessionId);
        if (!transcript.trim()) {
          throw Object.assign(new Error("nothing to distill — the session has no messages"), { code: "invalid-input" });
        }
        return parseNoteReply(await assistComplete(sessionId, buildNotePrompt(transcript), 1_024, space.userId));
      },
      taskBrief: async (space, sessionId: string) => {
        const messages = deriveMessages(await store.events(sessionId));
        const latest = [...messages].reverse().find((message) => message.role === "user");
        const prompt = latest?.parts
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text).join("\n").trim();
        if (!prompt) throw Object.assign(new Error("nothing to summarize — the session has no user prompt"), { code: "invalid-input" });
        const proj = await store.projection(sessionId);
        const project = proj ? await projects.get(proj.projectId) : null;
        const route = smallModelExecutionRoute(resolveSmallModel(space.userId), proj);
        const runtime = await runtimes.forProject(proj?.projectId ?? "__default__", project?.path, route.harnessId);
        const { text: brief } = await smallModels.complete(runtime, {
          cwd: project?.path ?? process.cwd(),
          ...(route.model ? { model: route.model } : {}),
          maxOutputTokens: 128,
          timeoutMs: 90_000,
          prompt: [
            "Summarize this user task in at most 20 words. Return only the summary, no label or punctuation flourish.",
            "<prompt>", prompt.slice(0, 12_000), "</prompt>",
          ].join("\n"),
        });
        return brief.trim().split(/\s+/).slice(0, 20).join(" ");
      },
    }),
    sessionRetentionRoutes(spaceServices),
    promptHistoryRoutes({ spaces: spaceServices, store }),
    agentSessionRoutes({
      spaces: spaceServices,
      store,
      capabilities: () => allCapabilities(),
      goals: () => svc<AgentGoalService>("goals"),
      version: "0.1.0",
      onSessionCreated: async (sessionId, space, parentSessionId) => {
        if (parentSessionId) await notifications.inheritSessionRecipient(parentSessionId, sessionId, space);
        else await notifications.registerSessionRecipient(sessionId, space);
      },
      onSessionsImported: async (sessionIds, space) => {
        for (const sessionId of sessionIds) await notifications.registerSessionRecipient(sessionId, space);
      },
      onSessionForked: async (parentSessionId, sessionId, space) => {
        await notifications.inheritSessionRecipient(parentSessionId, sessionId, space);
      },
    }),
    queueRoutes(spaceServices),
    runtimeEpochRoutes(spaceServices),
    runtimeDiagnosticsRoutes(runtimeDiagnostics),
    pushRoutes(push),
    nativePushRoutes(nativePush),
    notificationRoutes(notifications),
    browseRoutes(),
    async (request) => {
      if (request.path.startsWith("/api/mcp/") || request.path.startsWith("/api/plugins")) return false;
      return settingsRoute(request);
    },
  ];
  const routes: RouteHandler[] = [...staticCoreRoutes, routeRegistry.handler];

  const allCapabilities = () => [...SERVER_CAPABILITY_IDS];

  const httpHandler = createHttpHandler({
    spaces: spaceGateway, runtimes, routes, visibility, auth, catalog: runtimeCatalog,
    capabilities: allCapabilities,
    webDist: resolve(opts.webDist ?? resolve(__dirname, "../../../apps/web/dist")),
    packagesDir: resolve(opts.webPackagesDir ?? packagesDir),
    version: "0.1.0",
    remotePolicies: () => routeRegistry.policies(),
    listenerId: "public",
    admission: httpAdmission,
    notificationRecipients: {
      created: async (sessionId, account) => { await notifications.registerSessionRecipient(sessionId, account); },
      forked: async (parentSessionId, sessionId, account) => { await notifications.inheritSessionRecipient(parentSessionId, sessionId, account); },
    },
  });
  httpHandlerRef = httpHandler;
  const server = createPublicHttpServer(httpHandler, "public");
  const controlSocketPath = process.env.POLYTH_CONTROL_SOCKET
    ?? (process.platform === "win32"
      ? `\\\\.\\pipe\\polyth-control-${createHash("sha256").update(dataDir).digest("hex").slice(0, 12)}`
      : join(dataDir, "control.sock"));
  if (process.platform !== "win32") rmSync(controlSocketPath, { force: true });
  const controlServer = createInternalControlServer(httpHandler);
  live = createWsGateway(
    sessions,
    svc<BrowserForWs>("browser"),
    svc<DictationForWs>("dictation"),
    spaceGateway,
    svc<ChatWorkspaceForWs>("chat-workspace.frames"),
  );
  const publicIngress = (req: import("node:http").IncomingMessage) =>
    publicHttpIngress(req, { listenerId: "public" });
  const wsAuthorize = (req: import("node:http").IncomingMessage) =>
    auth.resolve(req, publicIngress(req)).authenticated;
  const wsIdentity = (req: import("node:http").IncomingMessage) =>
    auth.resolve(req, publicIngress(req));
  httpServerContext = {
    server,
    listenerId: "public",
    dispatch: httpHandler,
    resolve: (request, ingress) => auth.resolve(request, ingress),
    authorize: wsAuthorize,
    identity: wsIdentity,
    refreshPrincipal: (principal) => principal.kind === "paired-device" ? null : principal,
    pairedSockets,
  };
  attachHttpChannels(httpServerContext);
  await packageLifecycle.startEnabled(packageRegistry);
  try {
    await refreshSafeBehavior();
  } catch (err) {
    console.warn("[polyth] initial capability reconcile skipped", err);
  }
  // User mutations from this point stage until the unified apply/restart
  // action. Boot reconciliation above wrote immediately so a no-op MCP apply
  // cannot enqueue a spurious pending restart.
  configApplier.enableStaging();
  // Providers register in package lifecycle hooks; warm only after discovery.
  void runtimeCatalog.models().catch(() => {});

  await new Promise<void>((res) => opts.hostname
    ? server.listen(port, opts.hostname, res)
    : server.listen(port, res));
  await new Promise<void>((res, reject) => {
    controlServer.once("error", reject);
    controlServer.listen(controlSocketPath, () => {
      controlServer.off("error", reject);
      res();
    });
  });
  if (process.platform !== "win32") chmodSync(controlSocketPath, 0o600);
  console.log(`[polyth] server on http://${opts.hostname ?? "127.0.0.1"}:${port}  data=${dataDir}`);
  console.log(`[polyth] agent control on ${controlSocketPath}`);

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    beginShutdown();
    // Fence new turn admission first, then let every accepted runtime turn
    // finish before disposing its OpenCode process. This keeps watcher-driven
    // source reloads from truncating unrelated agent sessions.
    shutdownPromise = admissionBarrier.drain(async () => {
      // Ingress owners first, then HTTP drain, then package/store disposal.
      // Destroying a TCP socket is not handler completion: admission tracks
      // request JS and fences leftovers before services go away.
      live?.close();
      await packageLifecycle.stopIngress();
      httpAdmission.stop();
      await Promise.all([
        drainAndCloseServer(controlServer, { timeoutMs: HTTP_DRAIN_MS }),
        drainAndCloseServer(server, {
          timeoutMs: HTTP_DRAIN_MS,
          untilIdle: (ms) => httpAdmission.waitIdle(ms),
        }),
      ]);
      httpAdmission.fence();
      // Leave the control socket path for the next boot to remove. An older
      // graceful shutdown can finish after a replacement server has already
      // claimed this path; unlinking here would silently disable the new
      // control socket.
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
      const physicalErrors = await openCodeRuntimes.disposeAll({ force: true }).then(
        () => undefined,
        (error: unknown) => error,
      );
      const harnessErrors = await harnessPool.dispose().then(
        () => undefined,
        (error: unknown) => error,
      );
      if (physicalErrors) {
        console.error("[polyth] runtime physical disposal failed during shutdown", physicalErrors);
      }
      if (harnessErrors) {
        console.error("[polyth] harness runtime disposal failed during shutdown", harnessErrors);
      }
      capabilityController?.dispose();
      await svc<SshTransportService>("ssh")?.disconnectAll().catch(() => {});
      await root.dispose();
      await store.close();
      await writerLease.release();
    });
    return shutdownPromise;
  };
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
  return { server, sessions, shutdown };
  } catch (error) {
    await writerLease.release();
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void boot();
}
