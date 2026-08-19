// Polyth server boot. Composition root: kernel context + plugins + gateway.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext } from "@polyth/kernel";
import { createStore } from "@polyth/session";
import { CAP, type AgentRuntime, type RuntimeEvent, type SessionEvent, type SessionProjection } from "@polyth/contracts";
import { createOpenCodeRuntime, type OpenCodeAdapterOptions } from "@polyth/backend-opencode";
import { createPermissionService } from "@polyth/permissions";
import { createGoalService, type GoalService } from "@polyth/goals";
import { createFileService } from "@polyth/files";
import { createCommandService } from "@polyth/commands";
import { createGitService } from "@polyth/git";
import { createTerminalService } from "@polyth/terminal";
import { createPreviewService } from "@polyth/preview";
import { createMultirunService } from "@polyth/multirun";
import { createFusionService, synthesisPrompt } from "@polyth/fusion";
import { createScheduleService } from "@polyth/schedule";
import { createGithubService } from "@polyth/github";
import { createProjectService } from "./projects.ts";
import { createSessionService, type Broadcaster, type RuntimePool } from "./sessions.ts";
import { createHttpServer, type RouteHandler } from "./http.ts";
import { goalRoutes } from "./routes/goals.ts";
import { workspaceRoutes } from "./routes/workspace.ts";
import { gitRoutes } from "./routes/git.ts";
import { terminalRoutes, attachTerminalWs } from "./routes/terminal.ts";
import { previewRoutes } from "./routes/preview.ts";
import { multirunRoutes } from "./routes/multirun.ts";
import { fusionRoutes } from "./routes/fusion.ts";
import { walkthroughRoutes } from "./routes/walkthrough.ts";
import { scheduleRoutes } from "./routes/schedule.ts";
import { githubRoutes } from "./routes/github.ts";
import { controlRoutes } from "./routes/control.ts";
import { snippetRoutes } from "./routes/snippets.ts";
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
  const parseModel = (raw?: string) => {
    if (!raw || !raw.includes("/")) return undefined;
    const i = raw.indexOf("/");
    return { providerID: raw.slice(0, i), modelID: raw.slice(i + 1) };
  };

  const sessions = createSessionService({
    store, projects, permissions, runtimes, broadcast,
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

  // --- scheduled prompts: due tasks send into an existing session or spawn a
  // fresh one in the target project (all model-visible flow stays in sessions)
  const schedule = createScheduleService({
    file: `${dataDir}/schedule.json`,
    runner: {
      run: async (task) => {
        let sessionId = task.sessionId;
        if (!sessionId) {
          const ref = await sessions.create({
            projectId: task.projectId,
            title: task.title ?? `Scheduled: ${task.prompt.slice(0, 48)}`,
          });
          sessionId = ref.id;
        }
        await sessions.send(sessionId, { text: task.prompt });
      },
    },
  });
  schedule.start();

  const github = createGithubService();

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
    workspaceRoutes({ projects, files, commands }),
    gitRoutes({
      projects, git,
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
      projects, terminals,
      // invariant #4: terminals spawned from a session context are logged
      events: {
        append: async (sessionId, type, data) => {
          const ev = await store.append(sessionId, type, data, { ignorable: true, producerPlugin: "terminal" });
          broadcast.event(ev);
          return ev;
        },
      },
    }),
    previewRoutes({ projects, preview }),
    multirunRoutes(multirun),
    fusionRoutes(fusion),
    walkthroughRoutes({ store, broadcast }),
    scheduleRoutes(schedule),
    githubRoutes({ projects, github }),
    controlRoutes(sessions),
    snippetRoutes({ projects, commands }),
  ];

  const server = createHttpServer({
    sessions, projects, runtimes, routes,
    capabilities: () => ["polyth.sessions", "polyth.sessionPersistence", "polyth.projects", "polyth.agentRuntime", "polyth.goals", "polyth.files", "polyth.commands", "polyth.git", "polyth.worktrees", "polyth.terminal", "polyth.preview", "polyth.multirun", "polyth.fusion", "polyth.walkthrough", "polyth.schedule", "polyth.github", "polyth.control"],
    webDist: resolve(__dirname, "../../../apps/web/dist"),
    version: "0.1.0",
  });
  // order matters: /ws (session gateway) aborts upgrades whose path it does
  // not match, so the terminal channel must claim /ws/terminal/:id first
  attachTerminalWs(server, { terminals });
  live = attachWs(server, sessions);

  await new Promise<void>((res) => server.listen(port, res));
  console.log(`[polyth] server on http://127.0.0.1:${port}  data=${dataDir}`);

  const shutdown = async () => {
    schedule.stop();
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
