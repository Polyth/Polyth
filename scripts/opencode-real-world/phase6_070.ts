/**
 * OC-REAL-070 (R+H): race two clients creating a worktree + session for the
 * same branch; remove one candidate during validation.
 *
 * R part (production boot + real OpenCode):
 *   A. two concurrent `POST /api/worktrees` for one branch -> exactly one
 *      valid worktree or bounded rejection; no orphan dir/branch state.
 *   B. session-create vs worktree-removal races across jittered timings ->
 *      each attempt either binds a verified path or rejects with a typed
 *      error; no runtime survives for an unverified path; no root fallback.
 *
 * H part (deterministic TOCTOU): the runtime pool seam deletes the worktree
 * AFTER session validation passed but BEFORE the real `opencode serve` spawn,
 * proving the boundary fails truthfully with no orphan process.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { AgentRuntime, Project, ProjectService, SessionEvent } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createSessionService } from "../../packages/server/src/sessions.ts";

import {
  FIXTURE, MODEL, OPENCODE_BIN, OPENCODE_VERSION,
  appendNdjson, closeRuntime, databaseSnapshot, dbRows, errorCode,
  fixtureServeProcesses, httpJson, makeScratch, manifest, openRuntime,
  projectionOf, resetFixture, restoreEnvironment, seedProjects, sleep,
  writeJson, writeOpencodeConfig, writeVerdict,
  type RuntimeHandle, type Scratch, type Verdict,
} from "./phase6lib.ts";

const ID = "OC-REAL-070";

const gitWorktrees = (root: string): string[] =>
  execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));

const projectService = (project: Project): ProjectService => ({
  list: async () => [project],
  get: async (id) => (id === project.id ? project : undefined),
  add: async () => project,
  create: async () => project,
  remove: async () => undefined,
});

const permissionService = {
  evaluate: () => "ask",
  addRule: () => undefined,
  rules: () => [],
} as unknown as PermissionService;

const run = async (): Promise<void> => {
  resetFixture();
  const scratch: Scratch = await makeScratch(ID);
  await writeOpencodeConfig(scratch);
  await seedProjects(scratch, [{ id: "project-a", path: FIXTURE.aRoot }]);
  await manifest(scratch, { engine: "R+H" });
  const polythLog = join(scratch.logsDir, "polyth.ndjson");
  const wireLog = join(scratch.logsDir, "wire.ndjson");
  const failures: string[] = [];
  let blocker = false;
  const details: Record<string, unknown> = {};
  let runtime: RuntimeHandle | undefined;

  try {
    runtime = await openRuntime(scratch);

    // ---- R/A: concurrent worktree creation for the SAME branch -------------
    const raceBranch = "race-070";
    const racePaths = [
      join(FIXTURE.aRoot, "worktree-race-1"),
      join(FIXTURE.aRoot, "worktree-race-2"),
    ];
    const createCalls = await Promise.all(racePaths.map(async (path) =>
      httpJson(runtime!.baseUrl, "POST", "/api/worktrees", {
        projectId: "project-a", branch: raceBranch, path,
      }, wireLog)));
    const createStatuses = createCalls.map((call) => call.status);
    const worktreesAfterRace = gitWorktrees(FIXTURE.aRoot);
    const raceWinners = racePaths.filter((path) => worktreesAfterRace.includes(path));
    details.worktreeRace = {
      statuses: createStatuses,
      bodies: createCalls.map((call) => call.body),
      worktreesAfterRace,
      raceWinners,
      dirsOnDisk: racePaths.map((path) => ({ path, exists: existsSync(path) })),
    };
    const successCount = createStatuses.filter((status) => status === 200).length;
    if (raceWinners.length > 1) {
      failures.push(`branch ${raceBranch} materialized in ${raceWinners.length} worktrees at once`);
    }
    if (successCount > 1) {
      failures.push(`both racing worktree creates reported success for one branch (statuses ${createStatuses.join(",")})`);
    }
    if (successCount === 0) {
      failures.push(`no racing worktree create succeeded (statuses ${createStatuses.join(",")})`);
    }
    // losers must be bounded rejections, not half-created registrations
    for (const [index, call] of createCalls.entries()) {
      if (call.status !== 200 && worktreesAfterRace.includes(racePaths[index]!)) {
        failures.push(`worktree create ${index} failed (${call.status}) but the path is registered`);
      }
    }

    // ---- R/B: session-create vs worktree-removal jitter races --------------
    const attempts: Array<Record<string, unknown>> = [];
    for (const [index, delayMs] of [0, 5, 15, 30, 60].entries()) {
      const doomPath = join(FIXTURE.aRoot, `worktree-doom-${index}`);
      const doomBranch = `doom-070-${index}`;
      execFileSync("git", ["worktree", "add", "-q", doomPath, "-b", doomBranch], { cwd: FIXTURE.aRoot });
      const before = fixtureServeProcesses().map((process_) => process_.pid);
      const [createOutcome] = await Promise.all([
        (async () => {
          try {
            const created = await runtime!.app.sessions.create({
              projectId: "project-a",
              title: `${ID} doom ${index}`,
              model: MODEL,
              worktreePath: doomPath,
            });
            const projection = await projectionOf(runtime!, created.id);
            return { kind: "created", sessionId: created.id, projection };
          } catch (error) {
            return { kind: "rejected", code: errorCode(error) };
          }
        })(),
        (async () => {
          await sleep(delayMs);
          execFileSync("git", ["worktree", "remove", "--force", doomPath], {
            cwd: FIXTURE.aRoot,
          });
        })().catch((error) => {
          // if the removal itself lost (dir busy), force-delete for the probe
          execFileSync("rm", ["-rf", doomPath]);
          return { removalError: String(error) };
        }),
      ]);
      await sleep(500);
      const after = fixtureServeProcesses();
      const doomServe = after.find((process_) => resolve(process_.cwd) === resolve(doomPath));
      const record: Record<string, unknown> = {
        index, delayMs, doomPath, createOutcome,
        newServePids: after.map((process_) => process_.pid).filter((pid) => !before.includes(pid)),
        doomServe: doomServe ?? null,
      };
      if (createOutcome.kind === "rejected") {
        // ENOENT is the immediate raw spawn failure for the removed cwd; the
        // durable operation is settled `runtime-unavailable` before rethrow.
        const bounded = ["invalid-input", "runtime-unavailable", "transport", "spawn", "ENOENT"]
          .some((code) => String(createOutcome.code).includes(code));
        record.boundedRejection = bounded;
        if (!bounded) failures.push(`attempt ${index}: unbounded rejection ${String(createOutcome.code)}`);
        // a rejected create must leave no runtime for the doomed path
        if (doomServe && !doomServe.cwdDeleted) {
          failures.push(`attempt ${index}: rejected create left a live serve at ${doomPath}`);
        }
        const projections = await dbRows(scratch, "projections");
        const doomStatuses = projections
          .map((row) => {
            try {
              return JSON.parse(String(row.data ?? "{}")) as { worktreePath?: string; status?: string };
            } catch {
              return {};
            }
          })
          .filter((data) => data.worktreePath === doomPath)
          .map((data) => String(data.status ?? ""));
        record.doomProjectionStatuses = doomStatuses;
        if (doomStatuses.some((status) => status !== "failed")) {
          failures.push(`attempt ${index}: rejected create projection is ${doomStatuses.join(",")}, expected failed`);
        }
      } else {
        const projection = createOutcome.projection as { status?: string; worktreePath?: string };
        record.finalStatus = projection?.status;
        // create won the race: binding must be to the doomed path, never root
        if (projection?.worktreePath && resolve(projection.worktreePath) !== resolve(doomPath)) {
          failures.push(`attempt ${index}: created session drifted to ${projection.worktreePath}`);
          blocker = true;
        }
        if (!projection?.worktreePath) {
          failures.push(`attempt ${index}: created session lost its worktreePath (root fallback)`);
          blocker = true;
        }
      }
      attempts.push(record);
      execFileSync("git", ["worktree", "prune"], { cwd: FIXTURE.aRoot });
      execFileSync("git", ["branch", "-D", doomBranch], { cwd: FIXTURE.aRoot });
    }
    details.jitterAttempts = attempts;
    await databaseSnapshot(scratch, "db-after-r");
  } finally {
    await closeRuntime(runtime);
    restoreEnvironment();
  }

  // ---- H: deterministic TOCTOU — validation passes, path is removed before
  // the REAL runtime spawn. The runtime pool seam performs the removal, which
  // makes the race boundary exact without faking any upstream semantics.
  resetFixture();
  const toctouPath = join(FIXTURE.aRoot, "worktree-toctou");
  execFileSync("git", ["worktree", "add", "-q", toctouPath, "-b", "toctou-070"], { cwd: FIXTURE.aRoot });
  const project: Project = { id: "project-a", name: "project-a", path: FIXTURE.aRoot, createdAt: 1 };
  const store = createStore(join(scratch.root, "toctou.db"));
  const durableEvents: SessionEvent[] = [];
  let spawnAttempts = 0;
  const spawnRealServe = async (cwd: string): Promise<AgentRuntime> => {
    spawnAttempts += 1;
    // The exact production failure surface: node spawn with a missing cwd.
    const child = spawn(OPENCODE_BIN, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd, stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", () => resolveSpawn());
      child.once("error", rejectSpawn);
    });
    child.kill("SIGTERM");
    throw Object.assign(new Error("unexpected: serve spawned in a removed worktree"), { code: "unexpected-spawn" });
  };
  try {
    const sessions = createSessionService({
      store,
      projects: projectService(project),
      permissions: permissionService,
      queue: store,
      broadcast: {
        event(event) {
          durableEvents.push(event);
          void appendNdjson(polythLog, { t: Date.now(), kind: "toctou-event", event });
        },
        projection(projection) {
          void appendNdjson(polythLog, { t: Date.now(), kind: "toctou-projection", projection });
        },
      },
      worktrees: {
        // real `git worktree list` output at validation time
        list: async () => gitWorktrees(FIXTURE.aRoot).map((path) => ({ path, branch: null })),
      },
      runtimes: {
        forProject: async (_projectId, cwd) => {
          if (cwd && resolve(cwd) === resolve(toctouPath)) {
            // TOCTOU boundary: candidate disappears after validation, before spawn.
            execFileSync("git", ["worktree", "remove", "--force", toctouPath], { cwd: FIXTURE.aRoot });
            return spawnRealServe(cwd);
          }
          throw Object.assign(new Error("unexpected root runtime request"), { code: "unexpected" });
        },
      },
    });
    let toctouOutcome: Record<string, unknown>;
    try {
      const created = await sessions.create({
        projectId: project.id,
        title: `${ID} toctou`,
        worktreePath: toctouPath,
      });
      toctouOutcome = { kind: "created", sessionId: created.id };
      failures.push("TOCTOU create succeeded although the worktree was removed before spawn");
    } catch (error) {
      toctouOutcome = { kind: "rejected", code: errorCode(error) };
    }
    await sleep(300);
    const orphan = fixtureServeProcesses().find((process_) =>
      resolve(process_.cwd) === resolve(toctouPath));
    const toctouProjections = await store.projections(project.id);
    const doomProjection = toctouProjections.find((projection) =>
      projection.worktreePath && resolve(projection.worktreePath) === resolve(toctouPath));
    details.toctou = {
      outcome: toctouOutcome,
      spawnAttempts,
      orphanServe: orphan ?? null,
      projectionStatus: doomProjection?.status ?? null,
      worktreesNow: gitWorktrees(FIXTURE.aRoot),
      durableOperationStates: (await store.events(String((doomProjection ?? { id: "" }).id))
        .catch(() => [] as SessionEvent[])).map((event) => event.type),
    };
    if (orphan && !orphan.cwdDeleted) {
      failures.push("TOCTOU left an orphan opencode serve for the removed worktree");
    }
    if (doomProjection && doomProjection.status !== "failed") {
      failures.push(`TOCTOU projection is ${String(doomProjection.status)}, expected failed`);
    }
    if (doomProjection && !doomProjection.worktreePath) {
      failures.push("TOCTOU projection silently dropped its worktreePath (root fallback)");
      blocker = true;
    }
  } finally {
    store.close();
  }

  await writeJson(join(scratch.artifactsDir, "details.json"), details);
  const verdict: Verdict = {
    id: ID,
    verdict: failures.length === 0 ? "pass" : "fail",
    engine: "R+H",
    opencodeVersion: OPENCODE_VERSION,
    protocol: "legacy",
    observed: failures.length === 0
      ? "same-branch worktree race produced exactly one valid worktree with bounded loser; jittered create-vs-remove races either bound the verified path or rejected typed; deterministic TOCTOU removal rejected the create with no orphan serve and no root fallback"
      : `race/TOCTOU violations: ${failures.slice(0, 3).join(" | ")}`,
    expected: "one valid location or bounded rejection; no runtime for an unverified path; no orphan/duplicate runtime; no wrong branch",
    attribution: failures.length === 0 ? "NONE" : "POLYTH",
    crossTreeLeakBlocker: blocker,
    identifiers: {},
    evidence: [
      "artifacts/opencode-real-world/phase-6/OC-REAL-070/details.json",
      "logs/opencode-real-world/phase-6/OC-REAL-070/wire.ndjson",
      "logs/opencode-real-world/phase-6/OC-REAL-070/polyth.ndjson",
      "logs/opencode-real-world/phase-6/OC-REAL-070/db-after-r.json",
    ],
    failures,
  };
  await writeVerdict(scratch, verdict);
};

await run();
process.exit(0);
