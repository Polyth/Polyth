/**
 * OC-REAL-069 (H): force EQUAL backend session/message/request/event IDs
 * across the root endpoint and the worktree endpoint. Authority/location/
 * binding must prevent collisions: no dedup swallow, no routing cross, no
 * cross-session binding damage.
 *
 * Harness: two `fakeOpenCode` real-socket servers (one per location) under the
 * exact production wiring — one SHARED sessionIdMap, one facade per location
 * created lazily (worktree facade after the root session exists, mirroring the
 * production runtime pool), one session service.
 */
import { join } from "node:path";
import { stat } from "node:fs/promises";

import {
  attachRuntimeLifecycle,
  createOpenCodeRuntimeFacade,
  createOpenCodeRuntimeLifecycle,
} from "@polyth/backend-opencode";
import type {
  AgentRuntime,
  Project,
  ProjectService,
  RuntimeEndpoint,
  RuntimeEndpointLease,
  SessionEvent,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createFakeOpenCode } from "../../packages/backend-opencode/test/fakeOpenCode.ts";
import { createSessionService } from "../../packages/server/src/sessions.ts";

import {
  FIXTURE, OPENCODE_VERSION,
  appendNdjson, databaseSnapshot, errorCode, makeScratch, manifest,
  resetFixture, sleep, waitFor, writeJson, writeVerdict,
  type Scratch, type Verdict,
} from "./phase6lib.ts";

const ID = "OC-REAL-069";

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
  await manifest(scratch, {
    engine: "H",
    harness: "fakeOpenCode real-socket backend x2, production sessionIdMap wiring",
    locations: { root: FIXTURE.aRoot, worktree: FIXTURE.aFeature },
  });
  const polythLog = join(scratch.logsDir, "polyth.ndjson");
  const failures: string[] = [];
  let blocker = false;
  const details: Record<string, unknown> = {};

  const rootFake = await createFakeOpenCode();
  const worktreeFake = await createFakeOpenCode();
  const sharedSessionIdMap = new Map<string, string>(); // canonical -> backend (production-shared)

  const makeRuntime = async (
    fake: Awaited<ReturnType<typeof createFakeOpenCode>>,
    directory: string,
    label: string,
  ): Promise<AgentRuntime> => {
    const endpoint: RuntimeEndpoint = {
      authorityId: `phase6:${label}`,
      continuity: "verified",
      generation: 1,
      url: fake.baseUrl,
      location: { directory },
      control: { kind: "borrowed", source: "external" },
      config: { kind: "read-only" },
      authentication: { kind: "none" },
    };
    const lease = {
      control: endpoint.control,
      async endpoint() { return endpoint; },
      async refresh() { return endpoint; },
      async dispose() {},
    } satisfies RuntimeEndpointLease;
    const lifecycle = await createOpenCodeRuntimeLifecycle({
      lease,
      protocol: "legacy",
      protocolDeadlineMs: 2_000,
      startupDeadlineMs: 2_000,
      probeDeadlineMs: 500,
      transport: { queryAttempts: 1 },
    });
    const facade = createOpenCodeRuntimeFacade({
      cwd: directory,
      lifecycle,
      sessionIdMap: sharedSessionIdMap,
      log: (level, message, data) => {
        void appendNdjson(polythLog, { t: Date.now(), label, level, message, data });
      },
    });
    const disposeFacade = facade.dispose.bind(facade);
    facade.dispose = async () => {
      await disposeFacade();
      await lifecycle.dispose();
    };
    return attachRuntimeLifecycle(facade, lifecycle);
  };

  const project: Project = { id: "project-a", name: "project-a", path: FIXTURE.aRoot, createdAt: 1 };
  const store = createStore(scratch.dbPath);
  const durableEvents: SessionEvent[] = [];
  let rootRuntime: AgentRuntime | undefined;
  let worktreeRuntime: AgentRuntime | undefined;
  try {
    // Production pool creates a facade lazily at the first session for a cwd.
    rootRuntime = await makeRuntime(rootFake, FIXTURE.aRoot, "root");
    const sessions = createSessionService({
      store,
      projects: projectService(project),
      permissions: permissionService,
      queue: store,
      broadcast: {
        event(event) {
          durableEvents.push(event);
          void appendNdjson(polythLog, { t: Date.now(), kind: "event", event });
        },
        projection(projection) {
          void appendNdjson(polythLog, { t: Date.now(), kind: "projection", projection });
        },
      },
      worktrees: {
        list: async () => [{ path: FIXTURE.aFeature, branch: "feature" }],
      },
      attachments: {
        maxBytes: 1_000_000,
        stat: async (root: string, path: string) => {
          const s = await stat(join(root, path));
          return { kind: s.isFile() ? "file" as const : "dir" as const, size: s.size };
        },
      },
      runtimes: {
        forProject: async (_projectId, cwd) => {
          if (cwd === FIXTURE.aFeature) {
            worktreeRuntime ??= await makeRuntime(worktreeFake, FIXTURE.aFeature, "worktree");
            return worktreeRuntime;
          }
          return rootRuntime!;
        },
      },
    });
    const eventsOf = async (sessionId: string) => store.events(sessionId);
    const waitEvent = async (sessionId: string, predicate: (event: SessionEvent) => boolean, label: string) => {
      await waitFor(async () => (await eventsOf(sessionId)).some(predicate), 10_000, 100, label);
    };

    // 1. root session binds first: shared map gains R -> ses_1.
    const rootSession = await sessions.create({ projectId: project.id, title: "069 root" });
    const rootProjection = await store.projection(rootSession.id);
    const rootBackend = String(rootProjection?.backendSessionId ?? "");

    // 2. worktree facade is constructed AFTER the root binding exists — its
    // reverse map is seeded from the shared forward map (production hazard).
    // Force the worktree fake to assign the SAME backend id space: fresh fake
    // sequences also start at ses_1, and we pre-probe an event for ses_1 on
    // the WORKTREE endpoint before any worktree session exists.
    const worktreeSession = await sessions.create({
      projectId: project.id,
      title: "069 worktree",
      worktreePath: FIXTURE.aFeature,
    });
    const worktreeProjection = await store.projection(worktreeSession.id);
    const worktreeBackend = String(worktreeProjection?.backendSessionId ?? "");
    details.backendIds = { rootBackend, worktreeBackend };
    if (rootBackend !== worktreeBackend) {
      failures.push(`expected forced-equal backend ids, got ${rootBackend} vs ${worktreeBackend}`);
    }
    details.sharedMap = Object.fromEntries(sharedSessionIdMap);

    // 3. equal EVENT ids + equal backend session id on both endpoints, with
    // location-distinct payloads. Neither may be dedup-swallowed or cross.
    rootFake.emitSse({
      id: "evt-collide-1",
      data: {
        type: "message.part.updated",
        properties: {
          sessionID: rootBackend,
          part: {
            id: "part-collide-1", messageID: "msg-collide-1", type: "tool",
            tool: "bash", callID: "call-collide-1",
            state: { status: "running", input: { command: "echo ROOT-ONLY-069" } },
          },
        },
      },
    });
    worktreeFake.emitSse({
      id: "evt-collide-1",
      data: {
        type: "message.part.updated",
        properties: {
          sessionID: worktreeBackend,
          part: {
            id: "part-collide-1", messageID: "msg-collide-1", type: "tool",
            tool: "bash", callID: "call-collide-1",
            state: { status: "running", input: { command: "echo WORKTREE-ONLY-069" } },
          },
        },
      },
    });
    await waitEvent(rootSession.id, (event) =>
      JSON.stringify(event.data).includes("ROOT-ONLY-069"), "root collide event");
    await waitEvent(worktreeSession.id, (event) =>
      JSON.stringify(event.data).includes("WORKTREE-ONLY-069"), "worktree collide event");
    const rootLog = JSON.stringify(await eventsOf(rootSession.id));
    const worktreeLog = JSON.stringify(await eventsOf(worktreeSession.id));
    if (rootLog.includes("WORKTREE-ONLY-069")) {
      failures.push("worktree endpoint payload crossed into the root session log");
      blocker = true;
    }
    if (worktreeLog.includes("ROOT-ONLY-069")) {
      failures.push("root endpoint payload crossed into the worktree session log");
      blocker = true;
    }

    // 4. equal REQUEST ids: one open permission per endpoint, same id.
    rootFake.lifecycle.addPermission(rootBackend, {
      id: "per-collide", permission: "bash", patterns: ["root-cmd"],
    });
    worktreeFake.lifecycle.addPermission(worktreeBackend, {
      id: "per-collide", permission: "bash", patterns: ["worktree-cmd"],
    });
    await waitEvent(rootSession.id, (event) =>
      event.type === "permission/requested"
      && (event.data as { requestId?: string }).requestId === "per-collide", "root permission");
    await waitEvent(worktreeSession.id, (event) =>
      event.type === "permission/requested"
      && (event.data as { requestId?: string }).requestId === "per-collide", "worktree permission");

    // Answer ONLY the root request; the worktree twin must stay open and the
    // reply must reach only the root endpoint.
    await sessions.replyPermission(rootSession.id, "per-collide", "once");
    await sleep(400);
    const replyPath = `/session/${rootBackend}/permissions/per-collide`;
    const rootReplies = rootFake.requestCount("POST", replyPath);
    const worktreeReplies = worktreeFake.requestCount("POST", replyPath);
    details.permissionReplies = { rootReplies, worktreeReplies };
    if (rootReplies !== 1) failures.push(`root endpoint expected exactly 1 permission reply, saw ${rootReplies}`);
    if (worktreeReplies !== 0) {
      failures.push(`permission reply crossed to the worktree endpoint (${worktreeReplies} POSTs)`);
      blocker = true;
    }
    const worktreeResolved = (await eventsOf(worktreeSession.id))
      .some((event) => event.type === "permission/resolved");
    if (worktreeResolved) {
      failures.push("worktree session shows permission/resolved for the root reply (dedup crossed)");
      blocker = true;
    }
    await sessions.replyPermission(worktreeSession.id, "per-collide", "reject");
    await sleep(400);
    details.permissionRepliesAfterBoth = {
      root: rootFake.requestCount("POST", replyPath),
      worktree: worktreeFake.requestCount("POST", replyPath),
    };
    if (worktreeFake.requestCount("POST", replyPath) !== 1) {
      failures.push("worktree reply did not reach exactly its own endpoint once");
    }

    // 5. equal MESSAGE ids: send one prompt per session; both fakes assign
    // msg_1 in their own id space. Each endpoint must see exactly its own
    // prompt text once.
    await sessions.send(rootSession.id, { text: "prompt ROOT-TEXT-069" });
    await sessions.send(worktreeSession.id, { text: "prompt WORKTREE-TEXT-069" });
    await sleep(300);
    const rootMessages = rootFake.lifecycle.session(rootBackend)?.messages ?? [];
    const worktreeMessages = worktreeFake.lifecycle.session(worktreeBackend)?.messages ?? [];
    details.upstreamMessages = {
      root: rootMessages.map((message) => ({ id: message.id, body: message.body })),
      worktree: worktreeMessages.map((message) => ({ id: message.id, body: message.body })),
    };
    const rootBodies = JSON.stringify(rootMessages);
    const worktreeBodies = JSON.stringify(worktreeMessages);
    if (!rootBodies.includes("ROOT-TEXT-069") || rootBodies.includes("WORKTREE-TEXT-069")) {
      failures.push("root endpoint upstream prompt set is wrong");
      blocker = blocker || rootBodies.includes("WORKTREE-TEXT-069");
    }
    if (!worktreeBodies.includes("WORKTREE-TEXT-069") || worktreeBodies.includes("ROOT-TEXT-069")) {
      failures.push("worktree endpoint upstream prompt set is wrong");
      blocker = blocker || worktreeBodies.includes("ROOT-TEXT-069");
    }
    const rootMessageIds = rootMessages.map((message) => String(message.id));
    const worktreeMessageIds = worktreeMessages.map((message) => String(message.id));
    details.equalMessageIds = { rootMessageIds, worktreeMessageIds };
    if (JSON.stringify(rootMessageIds) !== JSON.stringify(worktreeMessageIds)) {
      details.equalMessageIdsNote = "message id sequences diverged; collision pressure reduced";
    }

    // 6. shared-map hazard: deleting the ROOT session must not damage the
    // WORKTREE session that carries the SAME backend id on another endpoint.
    rootFake.lifecycle.finishTurn(rootBackend);
    worktreeFake.lifecycle.finishTurn(worktreeBackend);
    await waitEvent(rootSession.id, (event) => event.type === "turn/stopped", "root turn stop");
    await waitEvent(worktreeSession.id, (event) => event.type === "turn/stopped", "worktree turn stop");
    const mapBeforeDelete = Object.fromEntries(sharedSessionIdMap);
    let deleteError = "";
    try {
      await sessions.delete!(rootSession.id);
    } catch (error) {
      deleteError = errorCode(error);
    }
    const mapAfterDelete = Object.fromEntries(sharedSessionIdMap);
    details.sharedMapBeforeDelete = mapBeforeDelete;
    details.sharedMapAfterDelete = mapAfterDelete;
    details.deleteError = deleteError;
    if (mapBeforeDelete[worktreeSession.id] && !mapAfterDelete[worktreeSession.id]) {
      failures.push("deleting the ROOT session removed the WORKTREE session's canonical->backend binding from the shared sessionIdMap");
    }
    // The worktree session must still be able to work upstream.
    let postDeleteSendError = "";
    try {
      await sessions.send(worktreeSession.id, { text: "prompt AFTER-DELETE-069" });
    } catch (error) {
      postDeleteSendError = errorCode(error);
    }
    await sleep(300);
    const worktreeAfterDelete = JSON.stringify(worktreeFake.lifecycle.session(worktreeBackend)?.messages ?? []);
    details.postDeleteSend = {
      error: postDeleteSendError,
      upstreamHasPrompt: worktreeAfterDelete.includes("AFTER-DELETE-069"),
    };
    if (postDeleteSendError || !worktreeAfterDelete.includes("AFTER-DELETE-069")) {
      failures.push(`worktree session broken after deleting the colliding root session: sendError=${postDeleteSendError || "none"}, upstreamHasPrompt=${worktreeAfterDelete.includes("AFTER-DELETE-069")}`);
    }
    const worktreeFinalProjection = await store.projection(worktreeSession.id);
    details.worktreeFinalProjection = worktreeFinalProjection;
    if (worktreeFinalProjection?.status === "failed") {
      failures.push("worktree session projection regressed to failed after the root delete");
    }
    // Root delete must not have deleted the WORKTREE endpoint's ses_1.
    if (!worktreeFake.lifecycle.session(worktreeBackend)) {
      failures.push("worktree endpoint's backend session disappeared after root delete");
      blocker = true;
    }
    // Post-delete SSE loss probe: removeMapping also clears the worktree
    // session's reconciliation ordinal; a model-visible SSE event emitted now
    // must still reach the worktree session's durable log.
    worktreeFake.emitSse({
      id: "evt-after-delete-1",
      data: {
        type: "message.part.updated",
        properties: {
          sessionID: worktreeBackend,
          part: {
            id: "part-after-delete", messageID: "msg-after-delete", type: "tool",
            tool: "bash", callID: "call-after-delete",
            state: { status: "running", input: { command: "echo WORKTREE-AFTER-DELETE-069" } },
          },
        },
      },
    });
    let postDeleteSseArrived = true;
    try {
      await waitEvent(worktreeSession.id, (event) =>
        JSON.stringify(event.data).includes("WORKTREE-AFTER-DELETE-069"), "post-delete worktree SSE");
    } catch {
      postDeleteSseArrived = false;
    }
    details.postDeleteSseArrived = postDeleteSseArrived;
    if (!postDeleteSseArrived) {
      failures.push("SSE event for the worktree session was silently dropped after the colliding root delete (reconciliation ordinal wiped by shared-map removeMapping)");
    }

    await databaseSnapshot(scratch, "db-after");
    await writeJson(join(scratch.artifactsDir, "details.json"), details);
    // A shared-map binding wipe that functionally self-heals (send + SSE both
    // still work) is graded partial; any observable cross/loss is a fail.
    const mapWipeOnly = failures.length > 0 && failures.every((failure) =>
      failure.includes("shared sessionIdMap"));
    const verdict: Verdict = {
      id: ID,
      verdict: failures.length === 0 ? "pass" : mapWipeOnly ? "partial" : "fail",
      engine: "H",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy",
      observed: failures.length === 0
        ? "equal backend session/message/request/event ids across root and worktree endpoints never crossed: SSE payloads, permission replies, and prompts stayed endpoint-bound; deleting the colliding root session left the worktree session functional"
        : `collision damage: ${failures.slice(0, 3).join(" | ")}`,
      expected: "authority/location/binding prevent collisions; dedup or routing never crosses sessions",
      attribution: failures.length === 0 ? "NONE" : "POLYTH",
      crossTreeLeakBlocker: blocker,
      identifiers: {
        rootSession: rootSession.id,
        worktreeSession: worktreeSession.id,
        rootBackend,
        worktreeBackend,
      },
      evidence: [
        "artifacts/opencode-real-world/phase-6/OC-REAL-069/details.json",
        "logs/opencode-real-world/phase-6/OC-REAL-069/polyth.ndjson",
        "logs/opencode-real-world/phase-6/OC-REAL-069/db-after.json",
      ],
      failures,
    };
    await writeVerdict(scratch, verdict);
  } finally {
    await rootRuntime?.dispose().catch(() => undefined);
    await worktreeRuntime?.dispose().catch(() => undefined);
    await rootFake.close().catch(() => undefined);
    await worktreeFake.close().catch(() => undefined);
    store.close();
  }
};

await run();
process.exit(0);
