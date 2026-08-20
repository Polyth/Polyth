// Polyth server boot. Composition root: kernel context + plugins + gateway.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext } from "@polyth/kernel";
import { createStore, deriveMessages } from "@polyth/session";
import { CAP, type AgentRuntime, type JsonObject, type RuntimeEvent, type SessionEvent, type SessionProjection, type WalkthroughSource } from "@polyth/contracts";
import { createConfigApplier, createOpenCodeRuntime, type OpenCodeAdapterOptions } from "@polyth/backend-opencode";
import { createPluginRegistry } from "@polyth/plugins";
import { createPermissionService } from "@polyth/permissions";
import { createGoalService, type GoalService } from "@polyth/goals";
import { createFileService, MAX_RAW_BYTES } from "@polyth/files";
import { createCommandService } from "@polyth/commands";
import { createGitService } from "@polyth/git";
import { createTerminalService } from "@polyth/terminal";
import { createPreviewService } from "@polyth/preview";
import { createMultirunService } from "@polyth/multirun";
import { createFusionService, synthesisPrompt } from "@polyth/fusion";
import { createScheduleService, scanLoopsDir } from "@polyth/schedule";
import { createKnowledgeStore } from "@polyth/knowledge";
import { createGithubService } from "@polyth/github";
import { createFakeQuotaProvider, createUsageService } from "@polyth/usage";
import {
  createBrowserService, createChromiumDriver, createFakeDriver, demoWeb,
  findChromiumExecutable, originOf,
} from "@polyth/browser";
import { createDictationService, createWhisperSttAdapter } from "@polyth/dictation";
import { createProjectService } from "./projects.ts";
import { createSessionService, type Broadcaster, type RuntimePool } from "./sessions.ts";
import { createHttpServer, type RouteHandler } from "./http.ts";
import { goalRoutes } from "./routes/goals.ts";
import { orgRoutes } from "./routes/org.ts";
import { workspaceRoutes } from "./routes/workspace.ts";
import { gitRoutes } from "./routes/git.ts";
import { terminalRoutes, attachTerminalWs } from "./routes/terminal.ts";
import { previewRoutes } from "./routes/preview.ts";
import { multirunRoutes } from "./routes/multirun.ts";
import { fusionRoutes } from "./routes/fusion.ts";
import { walkthroughRoutes } from "./routes/walkthrough.ts";
import { scheduleRoutes } from "./routes/schedule.ts";
import { usageRoutes } from "./routes/usage.ts";
import { knowledgeRoutes } from "./routes/knowledge.ts";
import { githubRoutes } from "./routes/github.ts";
import { controlRoutes } from "./routes/control.ts";
import { snippetRoutes } from "./routes/snippets.ts";
import { profileRoutes } from "./routes/profiles.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { browserRoutes } from "./routes/browser.ts";
import { dictationRoutes } from "./routes/dictation.ts";
import { createBehaviorService } from "./behavior.ts";
import { createMcpConfigService } from "./mcp.ts";
import { createVoiceSettings } from "./voice.ts";
import { voiceRoutes } from "./routes/voice.ts";
import { buildNotePrompt, createAssistService, createAssistSettings, parseNoteReply, type AssistService } from "./assist.ts";
import { assistRoutes } from "./routes/assist.ts";
import { createWalkthroughJobService } from "./walkthroughs.ts";
import { createReviewFlowService, createReviewService } from "./review.ts";
import { createMultirunRunOne } from "./multirunRunner.ts";
import { oneShot } from "./oneshot.ts";
import { attachWs } from "./ws.ts";

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
}

export async function boot(opts: BootOptions = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 4400);
  const dataDir = resolve(opts.dataDir ?? process.env.POLYTH_DATA_DIR ?? "./data");
  mkdirSync(dataDir, { recursive: true });

  // --- kernel composition root
  const root = createContext("root");
  const store = createStore(`${dataDir}/sessions.db`);
  root.provide(CAP.sessionPersistence, store);
  const projects = createProjectService(dataDir);
  root.provide(CAP.projects, projects);
  const permissions = createPermissionService(dataDir);

  // --- per-project opencode runtime pool (lazy spawn, one serve process per project)
  const runtimesByProject = new Map<string, Promise<AgentRuntime>>();
  const sessionIdMap = new Map<string, string>(); // canonical -> backend

  const isTransportError = (err: unknown): boolean =>
    /fetch failed|terminated|ECONNRESET|ECONNREFUSED/i.test(
      err instanceof Error ? `${err.message} ${String(err.cause ?? "")}` : String(err),
    );

  const spawnRuntime = async (projectId: string, cwd?: string): Promise<AgentRuntime> => {
    const project = await projects.get(projectId);
    return createOpenCodeRuntime({
      cwd: cwd ?? project?.path ?? process.cwd(), sessionIdMap,
      ...(opts.opencode?.port ? { port: opts.opencode.port } : {}),
      ...(opts.opencode?.bin ? { bin: opts.opencode.bin } : {}),
      ...(opts.opencode?.hostname ? { hostname: opts.opencode.hostname } : {}),
    });
  };

  // Stable facade per pool key: when ensureSession dies with a transport error
  // (serve process gone / poisoned socket), drop the cached promise, respawn,
  // and retry once. Callers keep the same handle, so listeners wired against
  // it keep receiving events from the fresh runtime.
  const facadeFor = (key: string, projectId: string, cwd: string | undefined, first: AgentRuntime): AgentRuntime => {
    let inner = first;
    const listeners = new Set<(sessionId: string, ev: RuntimeEvent) => void>();
    const fanout = (sessionId: string, ev: RuntimeEvent) => { for (const cb of listeners) cb(sessionId, ev); };
    let innerSub = inner.onEvent(fanout);

    const respawn = async (): Promise<void> => {
      runtimesByProject.delete(key);
      innerSub.dispose();
      void inner.dispose().catch(() => {});
      inner = await spawnRuntime(projectId, cwd);
      innerSub = inner.onEvent(fanout);
      runtimesByProject.set(key, Promise.resolve(facade));
    };

    const facade: AgentRuntime = {
      capabilities: () => inner.capabilities(),
      models: () => inner.models(),
      agents: () => inner.agents(),
      sessions: () => inner.sessions(),
      history: (sessionId) => inner.history(sessionId),
      async ensureSession(canonical) {
        try {
          return await inner.ensureSession(canonical);
        } catch (err) {
          if (!isTransportError(err)) throw err;
          console.warn(`[polyth] opencode transport error for ${key}; respawning`, err);
          await respawn();
          return inner.ensureSession(canonical);
        }
      },
      async resetSession(canonical) {
        if (!inner.resetSession) throw Object.assign(new Error("runtime cannot reset session history"), { code: "unsupported" });
        try {
          return await inner.resetSession(canonical);
        } catch (err) {
          if (!isTransportError(err)) throw err;
          console.warn(`[polyth] opencode transport error while resetting ${key}; respawning`, err);
          await respawn();
          if (!inner.resetSession) throw Object.assign(new Error("runtime cannot reset session history"), { code: "unsupported" });
          return inner.resetSession(canonical);
        }
      },
      startTurn: (req) => inner.startTurn(req),
      abort: (sessionId) => inner.abort(sessionId),
      replyPermission: (sessionId, requestId, reply) => inner.replyPermission(sessionId, requestId, reply),
      replyQuestion: (sessionId, requestId, answers) => inner.replyQuestion(sessionId, requestId, answers),
      onEvent(cb) {
        listeners.add(cb);
        return { dispose: () => { listeners.delete(cb); } };
      },
      dispose: () => { runtimesByProject.delete(key); return inner.dispose(); },
    };
    return facade;
  };

  const runtimes: RuntimePool = {
    forProject(projectId, cwd) {
      const key = cwd ? `${projectId}::${cwd}` : projectId;
      let p = runtimesByProject.get(key);
      if (!p) {
        p = (async () => {
          try {
            return facadeFor(key, projectId, cwd, await spawnRuntime(projectId, cwd));
          } catch (err) {
            if (!isTransportError(err)) throw err;
            return facadeFor(key, projectId, cwd, await spawnRuntime(projectId, cwd)); // one respawn retry
          }
        })();
        runtimesByProject.set(key, p);
        p.catch(() => runtimesByProject.delete(key)); // allow retry
      }
      return p;
    },
  };

  // --- broadcast box: sessions service emits before WS attaches; box defers delivery
  let live: Broadcaster | null = null;
  const broadcast: Broadcaster = {
    event: (e: SessionEvent) => live?.event(e),
    projection: (p: SessionProjection) => live?.projection(p),
  };

  // --- goals workflow plugin (listens on the turn seam, never touches the loop)
  let goals: GoalService | null = null;
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
  const terminals = createTerminalService();
  const preview = createPreviewService();

  // --- controlled browser (WP14): Chromium if configured/found, fake driver
  // behind POLYTH_FAKE_BROWSER=1, otherwise an honest "unavailable" state that
  // keeps the iframe preview as the fallback surface.
  const previewOrigins = new Set<string>();
  preview.onStatusChange((_pid, st) => {
    if (st.url) {
      const o = originOf(st.url);
      if (o) previewOrigins.add(o);
    }
  });
  const chromiumPath = process.env.POLYTH_FAKE_BROWSER === "1" ? null : await findChromiumExecutable();
  const browserDriver = process.env.POLYTH_FAKE_BROWSER === "1"
    ? createFakeDriver(demoWeb())
    : chromiumPath
      ? createChromiumDriver(chromiumPath)
      : null;
  const browser = createBrowserService({
    driver: browserDriver,
    unavailableReason: "browser engine unavailable: no Chromium executable found (set POLYTH_CHROMIUM_PATH)",
    allowedOrigins: () => [...previewOrigins],
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
  const configApplier = createConfigApplier();
  const behavior = createBehaviorService({ file: `${dataDir}/behavior.md`, applier: configApplier });
  const mcp = createMcpConfigService({ file: `${dataDir}/mcp.json`, applier: configApplier });
  const pluginRegistry = createPluginRegistry({
    dir: `${dataDir}/plugins`,
    trustedDir: process.env.POLYTH_TRUSTED_PLUGIN_DIR ?? `${dataDir}/trusted-plugins`,
  });

  const sessions = createSessionService({
    store, projects, permissions, runtimes, broadcast, queue: store, org: store, profiles: store, behavior,
    worktrees: git.worktrees,
    shell: terminals,
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
      onTurnCompleted: (sessionId, text) => {
        void (async () => {
          const state = await ensureGoalState(sessionId);
          if (state?.status === "active") await goals?.onTurnCompleted(sessionId, text);
        })().catch((err: unknown) => console.error("[polyth] goal audit failed", err));
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
  schedule.start();

  // Periodic .agents/loops reconciliation (rescan endpoint offers on-demand).
  const loopSync = async () => {
    for (const p of await projects.list()) {
      try {
        schedule.syncLoops(p.id, scanLoopsDir(p.path));
      } catch { /* unreadable project dir */ }
    }
  };
  void loopSync();
  const loopTimer = setInterval(() => void loopSync(), 60_000);
  loopTimer.unref?.();

  const knowledge = createKnowledgeStore(`${dataDir}/knowledge.db`);

  const github = createGithubService();

  // --- WP12: generic quota telemetry. Adapters are registered here on the
  // server; the browser only ever sees sanitized snapshots. No adapters are
  // configured by default — POLYTH_FAKE_QUOTAS=1 enables the demo provider.
  const usage = createUsageService({ file: `${dataDir}/quotas.json` });
  if (process.env.POLYTH_FAKE_QUOTAS === "1") usage.register(createFakeQuotaProvider());
  usage.start();

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
  const flowTimer = setInterval(() => void reviewFlow.tick(), 4_000);
  flowTimer.unref?.();

  const routes: RouteHandler[] = [
    async (rc) => {
      // lazily rehydrate goal state from the log before the goals routes answer
      if (/^\/api\/sessions\/[^/]+\/goal/.test(rc.path)) {
        const id = rc.path.split("/")[3]!;
        await ensureGoalState(id);
      }
      return false;
    },
    goalRoutes(goals),
    orgRoutes({ projects, sessions, store }),
    workspaceRoutes({ projects, files, commands }),
    gitRoutes({
      projects, sessions, git,
      // OC-13-002: AI commit message, generated by the Small Model from the diff
      commitMessage: async (root) => {
        const staged = await git.diff(root, { staged: true });
        const diff = staged.diff.trim() || (await git.diff(root)).diff;
        if (!diff.trim()) throw Object.assign(new Error("nothing to describe"), { code: "invalid-input" });
        const project = (await projects.list()).find((p) => p.path === root);
        const rt = await runtimes.forProject(project?.id ?? "__default__");
        const text = await oneShot(rt, {
          cwd: root,
          ...(smallModel() ? { model: smallModel()! } : {}),
          prompt: [
            "Write a git commit message for the diff below. Output ONLY the message.",
            "Format: a <=72 character imperative subject line; add a short body only if the change is non-obvious.",
            "Do not use tools. Do not wrap the answer in code fences.",
            "", "<diff>", diff.slice(0, 24_000), "</diff>",
          ].join("\n"),
        });
        return text.replace(/^```[a-z]*\n?|```$/g, "").trim();
      },
    }),
    terminalRoutes({
      projects, sessions, terminals,
      // invariant #4: terminals spawned from a session context are logged
      events: {
        append: async (sessionId, type, data) => {
          const ev = await store.append(sessionId, type, data, { ignorable: true, producerPlugin: "terminal" });
          broadcast.event(ev);
          return ev;
        },
      },
    }),
    previewRoutes({ projects, sessions, preview }),
    browserRoutes({ browser, append: appendLogged, shotsDir: `${dataDir}/browser-shots` }),
    dictationRoutes({ dictation }),
    voiceRoutes({
      voice: voiceSettings,
      // OC-2049 seam: summarize long replies before speaking, small model only
      summarize: async (text) => {
        const rt = await runtimes.forProject("__default__");
        return oneShot(rt, {
          cwd: process.cwd(),
          ...(smallModel() ? { model: smallModel()! } : {}),
          prompt: [
            "Summarize the following assistant reply for text-to-speech playback.",
            "Keep it under 3 sentences, plain prose, no markdown, no preamble.",
            "", "<reply>", text.slice(0, 24_000), "</reply>",
          ].join("\n"),
        });
      },
    }),
    assistRoutes({
      settings: assistSettings,
      projection: (sessionId) => store.projection(sessionId),
      latestSeq: (sessionId) => store.latestSeq(sessionId),
      // chat→note: distill with the same small-model seam; the route returns a
      // DRAFT — saving goes through the normal /api/knowledge flow.
      distill: async (sessionId) => {
        const transcript = await assistTranscript(sessionId);
        if (!transcript.trim()) {
          throw Object.assign(new Error("nothing to distill — the session has no messages"), { code: "invalid-input" });
        }
        return parseNoteReply(await assistComplete(sessionId, buildNotePrompt(transcript)));
      },
    }),
    multirunRoutes(multirun),
    fusionRoutes(fusion),
    walkthroughRoutes({ store, broadcast, jobs: walkthroughJobs, review, flow: reviewFlow }),
    scheduleRoutes({ schedule, projects }),
    usageRoutes(usage),
    knowledgeRoutes({
      knowledge,
      events: {
        append: async (sessionId, type, data) => {
          const ev = await store.append(sessionId, type, data, { producerPlugin: "knowledge" });
          broadcast.event(ev);
          return ev;
        },
      },
    }),
    githubRoutes({
      projects, github, append: appendLogged,
      // OC-15-005: AI PR title/body — same Small Model seam as commit messages.
      // Reads the diff via git only; never creates or edits the PR itself.
      describe: async (root, base) => {
        let baseRef = base;
        if (!baseRef) {
          const r = await github.repo(root);
          baseRef = (r.ok && r.data.defaultBranch) || "main";
        }
        const diff = await git.diffRange(root, baseRef, "HEAD");
        if (!diff.trim()) {
          throw Object.assign(new Error(`no commits to describe against ${baseRef}`), { code: "invalid-input" });
        }
        const project = (await projects.list()).find((p) => p.path === root);
        const rt = await runtimes.forProject(project?.id ?? "__default__");
        const text = await oneShot(rt, {
          cwd: root,
          ...(smallModel() ? { model: smallModel()! } : {}),
          prompt: [
            "Write a pull request title and description for the diff below.",
            "Line 1: a <=72 character imperative title. Then a blank line, then a concise",
            "markdown description (what changed and why; a short bullet list is fine).",
            "Do not use tools. Do not wrap the answer in code fences. Output nothing else.",
            "", "<diff>", diff.slice(0, 24_000), "</diff>",
          ].join("\n"),
        });
        const clean = text.replace(/^```[a-z]*\n?|```$/g, "").trim();
        const nl = clean.indexOf("\n");
        return nl === -1
          ? { title: clean.slice(0, 72), body: "" }
          : { title: clean.slice(0, nl).trim().slice(0, 200), body: clean.slice(nl + 1).trim() };
      },
    }),
    controlRoutes(sessions),
    snippetRoutes({ projects, commands }),
    profileRoutes({
      store,
      // Aggregated across live runtimes, same as the /api/models endpoint.
      listModels: async () => {
        const out: Awaited<ReturnType<AgentRuntime["models"]>> = [];
        const seen = new Set<string>();
        for (const p of await projects.list()) {
          try {
            const rt = await runtimes.forProject(p.id);
            for (const m of await rt.models()) {
              const key = `${m.providerID}/${m.modelID}`;
              if (!seen.has(key)) { seen.add(key); out.push(m); }
            }
          } catch { /* runtime unavailable */ }
        }
        return out;
      },
      listAgents: async () => {
        const out: Awaited<ReturnType<AgentRuntime["agents"]>> = [];
        const seen = new Set<string>();
        for (const p of await projects.list()) {
          try {
            const rt = await runtimes.forProject(p.id);
            for (const a of await rt.agents()) {
              if (!seen.has(a.name)) { seen.add(a.name); out.push(a); }
            }
          } catch { /* runtime unavailable */ }
        }
        return out;
      },
    }),
    settingsRoutes({
      behavior, mcp, plugins: pluginRegistry,
      systemInfo: (local) => ({
        version: "0.1.0",
        // Configured bind address only — never derived from the Host header.
        applicationUrl: `http://127.0.0.1:${port}`,
        tunnelUrl: process.env.POLYTH_TUNNEL_URL ?? null,
        dataDirLabel: local ? dataDir : "Polyth data directory",
        capabilities: allCapabilities(),
      }),
    }),
  ];

  const allCapabilities = () => ["polyth.sessions", "polyth.sessionPersistence", "polyth.projects", "polyth.agentRuntime", "polyth.goals", "polyth.files", "polyth.commands", "polyth.git", "polyth.worktrees", "polyth.terminal", "polyth.preview", "polyth.multirun", "polyth.fusion", "polyth.walkthrough", "polyth.schedule", "polyth.github", "polyth.control", "polyth.agentProfiles", "polyth.settings", "polyth.mcp", "polyth.plugins", "polyth.knowledge", "polyth.review", "polyth.usage", "polyth.browser", "polyth.voice", "polyth.assist"];

  const server = createHttpServer({
    sessions, projects, runtimes, routes,
    capabilities: allCapabilities,
    webDist: resolve(__dirname, "../../../apps/web/dist"),
    version: "0.1.0",
  });
  // order matters: /ws (session gateway) aborts upgrades whose path it does
  // not match, so the terminal channel must claim /ws/terminal/:id first
  attachTerminalWs(server, { terminals });
  live = attachWs(server, sessions, browser, dictation);

  await new Promise<void>((res) => server.listen(port, res));
  console.log(`[polyth] server on http://127.0.0.1:${port}  data=${dataDir}`);

  const shutdown = async () => {
    schedule.stop();
    usage.stop();
    assist?.stop();
    clearInterval(loopTimer);
    clearInterval(flowTimer);
    knowledge.close();
    await browser.closeAll().catch(() => {});
    await pluginRegistry.dispose().catch(() => {});
    for (const t of terminals.list()) await terminals.close(t.id).catch(() => {});
    for (const p of await projects.list()) await preview.stop(p.id).catch(() => {});
    for (const p of runtimesByProject.values()) await (await p.catch(() => null))?.dispose().catch(() => {});
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
