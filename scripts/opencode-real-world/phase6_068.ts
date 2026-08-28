/**
 * OC-REAL-068 (R): root plus worktrees run concurrently with distinct marker
 * files and the SAME prompt text. Every request/event/config lookup must stay
 * in its own resolved cwd; no marker or session may cross locations.
 *
 * Locations: project-a root, project-a/worktree-feature, project-b root,
 * project-b/worktree-feature — four concurrent sessions, one identical prompt.
 */
import { join, resolve } from "node:path";

import {
  FIXTURE, MARKERS, MODEL, OPENCODE_VERSION,
  appendNdjson, closeRuntime, databaseSnapshot, errorCode, foreignMarkers,
  fixtureServeProcesses, makeScratch, manifest, messageCwd,
  openRuntime, projectionOf, readEvents, resetFixture,
  restoreEnvironment, seedProjects, serveFor, toolParts, upstreamSessions,
  waitFor, waitUpstreamAssistant, writeJson, writeOpencodeConfig, writeVerdict,
  type RuntimeHandle, type Scratch, type Verdict,
} from "./phase6lib.ts";

const ID = "OC-REAL-068";
const PROMPT = "Read the file IDENTITY.txt in the current directory and reply with exactly its contents and nothing else.";

interface Location {
  key: string;
  projectId: string;
  cwd: string;
  worktreePath?: string;
  marker: string;
}

const LOCATIONS: Location[] = [
  { key: "a-root", projectId: "project-a", cwd: FIXTURE.aRoot, marker: MARKERS.aMain },
  { key: "a-feature", projectId: "project-a", cwd: FIXTURE.aFeature, worktreePath: FIXTURE.aFeature, marker: MARKERS.aFeature },
  { key: "b-root", projectId: "project-b", cwd: FIXTURE.bRoot, marker: MARKERS.bMain },
  { key: "b-feature", projectId: "project-b", cwd: FIXTURE.bFeature, worktreePath: FIXTURE.bFeature, marker: MARKERS.bFeature },
];

const run = async (): Promise<void> => {
  resetFixture();
  const scratch: Scratch = await makeScratch(ID);
  await writeOpencodeConfig(scratch);
  await seedProjects(scratch, [
    { id: "project-a", path: FIXTURE.aRoot },
    { id: "project-b", path: FIXTURE.bRoot },
  ]);
  await manifest(scratch, { engine: "R", locations: LOCATIONS });
  const polythLog = join(scratch.logsDir, "polyth.ndjson");
  const wireLog = join(scratch.logsDir, "wire.ndjson");
  const failures: string[] = [];
  let blocker = false;
  let runtime: RuntimeHandle | undefined;
  const details: Record<string, unknown> = {};
  try {
    runtime = await openRuntime(scratch);
    // 1. create all four sessions (root sessions have no worktreePath override).
    const sessions = new Map<string, { id: string; backendId: string }>();
    for (const location of LOCATIONS) {
      const created = await runtime.app.sessions.create({
        projectId: location.projectId,
        title: `${ID} ${location.key}`,
        model: MODEL,
        ...(location.worktreePath ? { worktreePath: location.worktreePath } : {}),
      });
      const projection = await projectionOf(runtime, created.id);
      sessions.set(location.key, { id: created.id, backendId: String(projection.backendSessionId ?? "") });
      await appendNdjson(polythLog, { t: Date.now(), kind: "created", location: location.key, projection });
      if (location.worktreePath && projection.worktreePath !== location.worktreePath) {
        failures.push(`${location.key}: projection worktreePath=${String(projection.worktreePath)} expected ${location.worktreePath}`);
      }
      if (!projection.backendSessionId) failures.push(`${location.key}: no backendSessionId after create`);
    }

    // 2. F evidence: one owned `opencode serve` per resolved cwd, exact /proc cwd.
    const processes = fixtureServeProcesses();
    details.serveProcesses = processes;
    const endpoints = new Map<string, string>();
    for (const location of LOCATIONS) {
      const serve = serveFor(location.cwd);
      if (!serve || serve.ports.length === 0) {
        failures.push(`${location.key}: no opencode serve process with cwd ${location.cwd}`);
        continue;
      }
      endpoints.set(location.key, `http://127.0.0.1:${serve.ports[0]}`);
    }
    const distinctCwds = new Set(processes.map((process_) => resolve(process_.cwd)));
    details.distinctServeCwds = [...distinctCwds];

    // 3. upstream directory-scoped catalogs contain exactly their own session.
    const catalogChecks: Record<string, unknown> = {};
    for (const location of LOCATIONS) {
      const base = endpoints.get(location.key);
      if (!base) continue;
      const listed = await upstreamSessions(base, location.cwd, wireLog);
      const ids = listed.map((session) => String(session.id ?? ""));
      const own = sessions.get(location.key)!;
      catalogChecks[location.key] = { directory: location.cwd, ids };
      if (!ids.includes(own.backendId)) {
        failures.push(`${location.key}: upstream catalog for ${location.cwd} is missing own backend session ${own.backendId}`);
      }
      for (const [otherKey, other] of sessions) {
        if (otherKey === location.key) continue;
        if (ids.includes(other.backendId)) {
          failures.push(`${location.key}: upstream catalog for ${location.cwd} leaked ${otherKey} session ${other.backendId}`);
          blocker = true;
        }
      }
    }
    details.catalogChecks = catalogChecks;
    await databaseSnapshot(scratch, "db-before-send");

    // 4. send the SAME prompt text to all four sessions concurrently.
    const sendResults = await Promise.all(LOCATIONS.map(async (location) => {
      const own = sessions.get(location.key)!;
      try {
        const result = await runtime!.app.sessions.send(own.id, { text: PROMPT, model: MODEL });
        return { key: location.key, result };
      } catch (error) {
        return { key: location.key, error: errorCode(error) };
      }
    }));
    details.sendResults = sendResults;
    for (const send of sendResults) {
      if ("error" in send) failures.push(`${send.key}: send failed: ${send.error}`);
    }

    // 5. wait for upstream assistant completion per location and check markers.
    const perLocation: Record<string, unknown> = {};
    await Promise.all(LOCATIONS.map(async (location) => {
      const own = sessions.get(location.key)!;
      const base = endpoints.get(location.key);
      if (!base) return;
      const outcome = await waitUpstreamAssistant(base, own.backendId, location.cwd, 180_000, wireLog);
      const cwds = outcome.messages.map((message) => messageCwd(message)).filter(Boolean);
      const tools = toolParts(outcome.messages);
      const reply = outcome.text.trim();
      perLocation[location.key] = {
        completed: outcome.completed,
        reply,
        messageCwds: [...new Set(cwds)],
        tools,
      };
      if (!outcome.completed) {
        failures.push(`${location.key}: upstream assistant did not complete in time`);
        return;
      }
      if (!reply.includes(location.marker)) {
        failures.push(`${location.key}: reply ${JSON.stringify(reply.slice(0, 120))} lacks own marker ${location.marker}`);
      }
      const leaked = foreignMarkers(reply, location.marker);
      if (leaked.length > 0) {
        failures.push(`${location.key}: reply leaked foreign markers ${leaked.join(",")}`);
        blocker = true;
      }
      for (const cwd of cwds) {
        if (resolve(cwd) !== resolve(location.cwd)) {
          failures.push(`${location.key}: upstream message cwd ${cwd} escaped ${location.cwd}`);
          blocker = true;
        }
      }
      for (const tool of tools) {
        const toolLeaks = foreignMarkers(tool.output, location.marker);
        if (toolLeaks.length > 0) {
          failures.push(`${location.key}: tool output leaked ${toolLeaks.join(",")}`);
          blocker = true;
        }
        // The worktree is nested inside the repo root, so containment must be
        // checked on the exact resolved file path, not a prefix of the root.
        for (const pathMatch of tool.output.matchAll(/<path>([^<]+)<\/path>/g)) {
          const filePath = resolve(String(pathMatch[1]));
          const own = resolve(location.cwd);
          const inOwn = filePath === own || filePath.startsWith(`${own}/`);
          const inForeignTree = LOCATIONS.some((other) => {
            if (other.key === location.key) return false;
            const otherCwd = resolve(other.cwd);
            // An ancestor (repo root above own worktree) always prefixes own
            // paths; nested-descendant escape is checked separately below.
            if (own.startsWith(`${otherCwd}/`) || otherCwd.startsWith(`${own}/`)) return false;
            return filePath === otherCwd || filePath.startsWith(`${otherCwd}/`);
          });
          const escapedIntoNestedWorktree = LOCATIONS.some((other) =>
            other.key !== location.key
            && resolve(other.cwd).startsWith(`${own}/`)
            && filePath.startsWith(`${resolve(other.cwd)}/`));
          if (!inOwn || inForeignTree || escapedIntoNestedWorktree) {
            failures.push(`${location.key}: tool read path ${filePath} escaped own cwd ${own}`);
            blocker = true;
          }
        }
      }
    }));
    details.perLocation = perLocation;

    // 6. Polyth durable log per session must carry only its own marker.
    for (const location of LOCATIONS) {
      const own = sessions.get(location.key)!;
      const events = await readEvents(runtime, own.id);
      const text = JSON.stringify(events);
      const leaked = foreignMarkers(text, location.marker);
      if (leaked.length > 0) {
        failures.push(`${location.key}: durable event log leaked ${leaked.join(",")}`);
        blocker = true;
      }
      const projection = await projectionOf(runtime, own.id);
      await appendNdjson(polythLog, {
        t: Date.now(), kind: "final", location: location.key,
        eventCount: events.length, projection,
      });
    }

    // 7. cross-endpoint negative probe: each endpoint queried for a FOREIGN
    // directory must not return this location's session as its own.
    const crossChecks: Record<string, unknown> = {};
    for (const location of LOCATIONS) {
      const base = endpoints.get(location.key);
      if (!base) continue;
      for (const other of LOCATIONS) {
        if (other.key === location.key) continue;
        const listed = await upstreamSessions(base, other.cwd, wireLog);
        const ids = listed.map((session) => String(session.id ?? ""));
        crossChecks[`${location.key}->asks-for->${other.key}`] = ids;
        if (ids.includes(sessions.get(location.key)!.backendId)) {
          failures.push(`endpoint ${location.key}: own session listed under foreign directory ${other.cwd}`);
          blocker = true;
        }
      }
    }
    details.crossDirectoryCatalogs = crossChecks;

    // 8. config lookup evidence: session init file per serve process cwd.
    details.finalServeProcesses = fixtureServeProcesses();
    await databaseSnapshot(scratch, "db-after");
    await writeJson(join(scratch.artifactsDir, "details.json"), details);

    const verdict: Verdict = {
      id: ID,
      verdict: failures.length === 0 ? "pass" : "fail",
      engine: "R",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy",
      observed: failures.length === 0
        ? "four concurrent sessions (2 roots + 2 worktrees) each answered with exactly its own IDENTITY marker; upstream cwd, tool paths, directory catalogs, and durable logs never crossed locations"
        : `isolation violations: ${failures.slice(0, 3).join(" | ")}`,
      expected: "every request/event/config lookup remains in its cwd; no marker or session crosses location",
      attribution: failures.length === 0 ? "NONE" : blocker ? "POLYTH" : "ENV",
      crossTreeLeakBlocker: blocker,
      identifiers: Object.fromEntries([...sessions].map(([key, value]) => [key, value])),
      evidence: [
        "artifacts/opencode-real-world/phase-6/OC-REAL-068/details.json",
        "logs/opencode-real-world/phase-6/OC-REAL-068/wire.ndjson",
        "logs/opencode-real-world/phase-6/OC-REAL-068/polyth.ndjson",
        "logs/opencode-real-world/phase-6/OC-REAL-068/db-after.json",
      ],
      failures,
    };
    await writeVerdict(scratch, verdict);
  } finally {
    await closeRuntime(runtime);
    restoreEnvironment();
  }
};

await run();
process.exit(0);
