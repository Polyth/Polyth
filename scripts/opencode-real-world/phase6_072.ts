/**
 * OC-REAL-072 (R+H): fork and send attachments from a worktree while the
 * project root has the SAME relative file name with different bytes; rotate
 * the endpoint mid-read. The child must stay in the source worktree and every
 * prompt must carry only source-tree bytes/URLs.
 *
 * Failure criteria: root byte leak, target cwd drift, or old-generation
 * attachment mutation (the durable record of an earlier turn's attachment
 * changing across an endpoint rotation).
 *
 * R: production boot + real OpenCode; rotation = SIGKILL of the worktree
 *    `opencode serve` PID mid-turn, then pool recovery.
 * H: two fakeOpenCode endpoints under production facade wiring; rotation =
 *    fake.restart() to a new endpoint generation behind the pool seam.
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  attachRuntimeLifecycle,
  createOpenCodeRuntimeFacade,
  createOpenCodeRuntimeLifecycle,
} from "@polyth/backend-opencode";
import type {
  AgentRuntime,
  AttachmentRef,
  Project,
  ProjectService,
  RuntimeEndpoint,
  RuntimeEndpointLease,
  SessionEvent,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createStore } from "@polyth/session";
import { createFakeOpenCode, type FakeOpenCode } from "../../packages/backend-opencode/test/fakeOpenCode.ts";
import { createSessionService } from "../../packages/server/src/sessions.ts";

import {
  FIXTURE, MODEL, OPENCODE_VERSION,
  appendNdjson, autoAnswerPermissions, closeRuntime, databaseSnapshot,
  errorCode, makeScratch, manifest, messageRole, messageText, projectionOf,
  resetFixture, restoreEnvironment, seedProjects, serveFor, sleep,
  upstreamMessages, waitFor, writeJson, writeOpencodeConfig, writeVerdict,
  openRuntime,
  type RuntimeHandle, type Scratch, type Verdict,
} from "./phase6lib.ts";

const ID = "OC-REAL-072";
const ATTACH_NAME = "attach-me.txt";
const ROOT_BYTES = "OC072_ROOT_BYTES_7391";
const FEATURE_BYTES = "OC072_FEATURE_BYTES_4816";
const ROOT_ATTACH = join(FIXTURE.aRoot, ATTACH_NAME);
const FEATURE_ATTACH = join(FIXTURE.aFeature, ATTACH_NAME);
const ATTACH_PROMPT = "Do not use any tools. Reply with exactly the raw contents of the attached file and nothing else.";

const seedAttachmentFiles = async (): Promise<void> => {
  await writeFile(ROOT_ATTACH, `${ROOT_BYTES}\n`);
  await writeFile(FEATURE_ATTACH, `${FEATURE_BYTES}\n`);
};

const attachmentRef = async (absolute: string, id: string): Promise<AttachmentRef> => {
  const s = await stat(absolute);
  return { id, name: ATTACH_NAME, mime: "text/plain", size: s.size, kind: "file", path: ATTACH_NAME };
};

const messageIdOf = (message: Record<string, unknown>): string =>
  String((message.info as Record<string, unknown> | undefined)?.id ?? "");

/** Wait for an assistant turn NOT in `priorIds` to settle (see phase6_071). */
const waitNewAssistant = async (
  base: string,
  backendId: string,
  directory: string,
  priorIds: Set<string>,
  timeoutMs: number,
  wirePath?: string,
): Promise<{ completed: boolean; newMessages: Array<Record<string, unknown>>; text: string }> => {
  const deadline = Date.now() + timeoutMs;
  let fresh: Array<Record<string, unknown>> = [];
  while (Date.now() < deadline) {
    const messages = await upstreamMessages(base, backendId, directory, wirePath).catch(() => []);
    fresh = messages.filter((message) => !priorIds.has(messageIdOf(message)));
    const assistants = fresh.filter((message) => messageRole(message) === "assistant");
    const last = assistants.at(-1) as { info?: { time?: { completed?: number }; error?: unknown } } | undefined;
    if (last?.info?.time?.completed || last?.info?.error) {
      return { completed: true, newMessages: fresh, text: messageText(last as Record<string, unknown>) };
    }
    await sleep(750);
  }
  return { completed: false, newMessages: fresh, text: "" };
};

// ---------------------------------------------------------------- R engine

interface EngineResult {
  failures: string[];
  /** Honesty/functionality gaps that are not leaks or fallbacks. */
  gaps: string[];
  blocker: boolean;
  details: Record<string, unknown>;
  identifiers: Record<string, unknown>;
}

const runReal = async (): Promise<EngineResult> => {
  resetFixture();
  await seedAttachmentFiles();
  const scratch: Scratch = await makeScratch(ID, "real");
  await writeOpencodeConfig(scratch);
  await seedProjects(scratch, [{ id: "project-a", path: FIXTURE.aRoot }]);
  const wireLog = join(scratch.logsDir, "wire.ndjson");
  const polythLog = join(scratch.logsDir, "polyth.ndjson");
  const log = (entry: unknown) => void appendNdjson(polythLog, entry);
  const failures: string[] = [];
  const gaps: string[] = [];
  let blocker = false;
  const details: Record<string, unknown> = {};
  const identifiers: Record<string, unknown> = {};
  let runtime: RuntimeHandle | undefined;
  const answerers: Array<ReturnType<typeof autoAnswerPermissions>> = [];

  /** Every upstream user message must reference only its own tree's absolute
   *  attachment path. Exact-path string checks: the two paths are distinct
   *  non-prefix strings. */
  const checkUserAttachmentPaths = (
    label: string,
    messages: Array<Record<string, unknown>>,
    expectedPath: string,
    forbiddenPath: string,
  ): void => {
    const userJson = JSON.stringify(messages.filter((message) => messageRole(message) === "user"));
    details[`${label}UserPartsHaveExpectedPath`] = userJson.includes(expectedPath);
    if (!userJson.includes(expectedPath)) {
      failures.push(`R ${label}: upstream user parts never referenced the expected attachment ${expectedPath}`);
    }
    if (userJson.includes(forbiddenPath)) {
      failures.push(`R ${label}: upstream user parts referenced the FORBIDDEN tree's attachment ${forbiddenPath}`);
      blocker = true;
    }
  };

  const checkReplyBytes = (
    label: string,
    text: string,
    expected: string,
    forbidden: string,
  ): void => {
    details[`${label}Reply`] = text.trim().slice(0, 200);
    if (!text.includes(expected)) {
      failures.push(`R ${label}: reply lacked the source-tree bytes ${expected}`);
    }
    if (text.includes(forbidden)) {
      failures.push(`R ${label}: reply leaked the other tree's bytes ${forbidden}`);
      blocker = true;
    }
  };

  try {
    runtime = await openRuntime(scratch);
    const wt = await runtime.app.sessions.create({
      projectId: "project-a", title: `${ID} worktree`, model: MODEL, worktreePath: FIXTURE.aFeature,
    });
    const root = await runtime.app.sessions.create({
      projectId: "project-a", title: `${ID} root`, model: MODEL,
    });
    answerers.push(autoAnswerPermissions(runtime, wt.id, log));
    answerers.push(autoAnswerPermissions(runtime, root.id, log));
    const wtBackend = String((await projectionOf(runtime, wt.id)).backendSessionId ?? "");
    const rootBackend = String((await projectionOf(runtime, root.id)).backendSessionId ?? "");
    identifiers.worktreeSession = wt.id;
    identifiers.rootSession = root.id;
    identifiers.worktreeBackend = wtBackend;
    identifiers.rootBackend = rootBackend;
    const wtServe = serveFor(FIXTURE.aFeature);
    const rootServe = serveFor(FIXTURE.aRoot);
    if (!wtServe || !rootServe) throw new Error("missing serve endpoint for root or worktree");
    const wtBase = `http://127.0.0.1:${wtServe.ports[0]}`;
    const rootBase = `http://127.0.0.1:${rootServe.ports[0]}`;
    details.servePids = { worktree: wtServe.pid, root: rootServe.pid };

    // 1. Text-only turn on the worktree session so a later fork has a clean,
    //    text-comparable history (see step 4 for the attachment-history gap).
    await runtime.app.sessions.send(wt.id, {
      text: "Do not use any tools. Reply with exactly: WT_READY_072", model: MODEL,
    });
    const readyTurn = await waitNewAssistant(wtBase, wtBackend, FIXTURE.aFeature, new Set(), 180_000, wireLog);
    if (!readyTurn.completed || !readyTurn.text.includes("WT_READY_072")) {
      failures.push("R worktree: text-only setup turn did not complete");
    }
    await waitFor(async () => (await projectionOf(runtime!, wt.id)).status === "idle",
      60_000, 300, "worktree idle before fork");

    // 2. Fork the worktree session — the child must stay in the source
    //    worktree (no target cwd drift) and receive only source bytes when it
    //    sends the shared-relative-name attachment.
    const fork = await runtime.app.sessions.fork(wt.id);
    const childProjection = await projectionOf(runtime, fork.id);
    identifiers.childSession = fork.id;
    identifiers.childBackend = String(childProjection.backendSessionId ?? "");
    details.childProjection = {
      worktreePath: childProjection.worktreePath,
      worktreeState: childProjection.worktreeState,
      status: childProjection.status,
    };
    if (childProjection.worktreePath !== FIXTURE.aFeature) {
      failures.push(`R fork: child worktreePath drifted to ${String(childProjection.worktreePath)}`);
      blocker = true;
    }
    answerers.push(autoAnswerPermissions(runtime, fork.id, log));
    const childBackend = String(childProjection.backendSessionId ?? "");
    const childPrior = new Set(
      (await upstreamMessages(wtBase, childBackend, FIXTURE.aFeature, wireLog)).map(messageIdOf),
    );
    await runtime.app.sessions.send(fork.id, {
      text: ATTACH_PROMPT, model: MODEL,
      attachments: [await attachmentRef(FEATURE_ATTACH, "att-072-child")],
    });
    const childTurn = await waitNewAssistant(wtBase, childBackend, FIXTURE.aFeature, childPrior, 180_000, wireLog);
    if (!childTurn.completed) failures.push("R fork: child attachment turn never completed");
    checkReplyBytes("child", childTurn.text, FEATURE_BYTES, ROOT_BYTES);
    checkUserAttachmentPaths("child", childTurn.newMessages, FEATURE_ATTACH, ROOT_ATTACH);

    // 3. Parent worktree session and root session: same relative name,
    //    each must get only its own tree's bytes.
    const wtPrior = new Set(
      (await upstreamMessages(wtBase, wtBackend, FIXTURE.aFeature, wireLog)).map(messageIdOf),
    );
    await runtime.app.sessions.send(wt.id, {
      text: ATTACH_PROMPT, model: MODEL,
      attachments: [await attachmentRef(FEATURE_ATTACH, "att-072-wt")],
    });
    const wtTurn = await waitNewAssistant(wtBase, wtBackend, FIXTURE.aFeature, wtPrior, 180_000, wireLog);
    if (!wtTurn.completed) failures.push("R worktree: attachment turn never completed");
    checkReplyBytes("worktree", wtTurn.text, FEATURE_BYTES, ROOT_BYTES);
    checkUserAttachmentPaths("worktree", wtTurn.newMessages, FEATURE_ATTACH, ROOT_ATTACH);
    const wtSeenIds = new Set([...wtPrior, ...wtTurn.newMessages.map(messageIdOf)]);

    await runtime.app.sessions.send(root.id, {
      text: ATTACH_PROMPT, model: MODEL,
      attachments: [await attachmentRef(ROOT_ATTACH, "att-072-root")],
    });
    const rootTurn = await waitNewAssistant(rootBase, rootBackend, FIXTURE.aRoot, new Set(), 180_000, wireLog);
    if (!rootTurn.completed) failures.push("R root: attachment turn never completed");
    checkReplyBytes("root", rootTurn.text, ROOT_BYTES, FEATURE_BYTES);
    checkUserAttachmentPaths("root", rootTurn.newMessages, ROOT_ATTACH, FEATURE_ATTACH);

    // 4. Post-fork parent terminalization: the parent's attachment turn
    //    completed upstream; the projection must return to idle. A stall here
    //    is the post-fork mapping bug (forked child backend later reported as
    //    "unmapped session"; parent misses its turn/stopped).
    let parentSettledIdle = true;
    try {
      await waitFor(async () => (await projectionOf(runtime!, wt.id)).status === "idle",
        60_000, 300, "worktree idle before attachment-history fork");
    } catch {
      parentSettledIdle = false;
      const stuck = await projectionOf(runtime, wt.id);
      details.parentStallProjection = { status: stuck.status, worktreeState: stuck.worktreeState };
      failures.push(`R post-fork: parent's next turn completed upstream but never terminalized in Polyth (projection stuck ${String(stuck.status)}; turn/stopped missing; forked child backend became an unmapped SSE target)`);
    }

    // 5. Fork AFTER an attachment turn. OpenCode 1.18.18 stores the file
    //    attachment as synthetic user TEXT parts ("Called the Read tool…" +
    //    the file content), so the exact-history comparison rejects with
    //    history-mismatch. That is a truthful bounded rejection (no
    //    approximate child, no leak) but a functional gap: attachment-bearing
    //    histories cannot be forked.
    // When the parent is stalled by the post-fork bug, probe the gap on the
    // ROOT session instead — it also carries an attachment turn and is idle.
    const forkProbeId = parentSettledIdle ? wt.id : root.id;
    details.attachForkProbeSession = forkProbeId === wt.id ? "worktree-parent" : "root";
    await waitFor(async () => (await projectionOf(runtime!, forkProbeId)).status === "idle",
      30_000, 300, "fork probe session idle");
    const projectionsBefore = (await runtime.app.sessions.list("project-a")).length;
    let attachForkOutcome = "";
    try {
      const second = await runtime.app.sessions.fork(forkProbeId);
      attachForkOutcome = `created:${second.id}`;
    } catch (error) {
      attachForkOutcome = `rejected:${errorCode(error)}`;
    }
    const projectionsAfter = (await runtime.app.sessions.list("project-a")).length;
    details.attachForkOutcome = attachForkOutcome;
    details.sessionCountAroundAttachFork = { before: projectionsBefore, after: projectionsAfter };
    if (attachForkOutcome.startsWith("rejected:history-mismatch")) {
      if (projectionsAfter !== projectionsBefore) {
        failures.push("R fork: rejected attachment-history fork still created a canonical child");
      } else {
        gaps.push("R fork: forking a history that contains a file attachment is always rejected with history-mismatch (OpenCode stores the attachment as synthetic user text parts the canonical history does not carry) — truthful bounded rejection, no child, no leak");
      }
    } else if (!attachForkOutcome.startsWith("created:")) {
      failures.push(`R fork: unexpected attachment-history fork outcome ${attachForkOutcome}`);
    }

    // 6. Endpoint rotation mid-read on a FRESH worktree session (independent
    //    of the post-fork stall): send an attachment turn and SIGKILL the
    //    worktree serve PID while the turn is in flight. The turn may fail
    //    truthfully; the follow-up turn on the recovered endpoint must still
    //    resolve the worktree bytes only.
    const rot = await runtime.app.sessions.create({
      projectId: "project-a", title: `${ID} rotation`, model: MODEL, worktreePath: FIXTURE.aFeature,
    });
    answerers.push(autoAnswerPermissions(runtime, rot.id, log));
    identifiers.rotationSession = rot.id;
    let midSendError = "";
    try {
      await runtime.app.sessions.send(rot.id, {
        text: ATTACH_PROMPT, model: MODEL,
        attachments: [await attachmentRef(FEATURE_ATTACH, "att-072-mid")],
      });
    } catch (error) {
      midSendError = errorCode(error);
    }
    await sleep(250);
    process.kill(wtServe.pid, "SIGKILL"); // exact-PID kill of the worktree endpoint only
    details.rotation = { killedPid: wtServe.pid, midSendError };
    // Pool recovery: wait for a NEW serve process for the same worktree cwd.
    let rotated: ReturnType<typeof serveFor>;
    try {
      await waitFor(async () => {
        // sends nudge the pool to respawn if it does not do so on its own
        const candidate = serveFor(FIXTURE.aFeature);
        return Boolean(candidate && candidate.pid !== wtServe.pid && candidate.ports.length > 0);
      }, 30_000, 500, "rotated worktree serve");
      rotated = serveFor(FIXTURE.aFeature);
    } catch {
      rotated = undefined;
    }
    if (!rotated) {
      // Recovery may be lazy — trigger it with the follow-up send below.
      details.rotationNote = "no automatic respawn observed; probing via follow-up send";
    }
    let postRotateSendError = "";
    try {
      await runtime.app.sessions.send(rot.id, {
        text: ATTACH_PROMPT, model: MODEL,
        attachments: [await attachmentRef(FEATURE_ATTACH, "att-072-post")],
      });
    } catch (error) {
      postRotateSendError = errorCode(error);
    }
    details.postRotateSendError = postRotateSendError;
    if (!rotated) {
      await waitFor(async () => {
        const candidate = serveFor(FIXTURE.aFeature);
        return Boolean(candidate && candidate.pid !== wtServe.pid && candidate.ports.length > 0);
      }, 60_000, 500, "rotated worktree serve after nudge").catch(() => undefined);
      rotated = serveFor(FIXTURE.aFeature);
    }
    details.rotatedServe = rotated ? { pid: rotated.pid, cwd: rotated.cwd, ports: rotated.ports } : null;
    if (!rotated) {
      failures.push("R rotation: worktree endpoint never came back after the exact-PID kill");
    } else {
      if (rotated.cwd !== FIXTURE.aFeature) {
        failures.push(`R rotation: recovered serve cwd drifted to ${rotated.cwd}`);
        blocker = true;
      }
      const rotatedBase = `http://127.0.0.1:${rotated.ports[0]}`;
      const rotBackendAfter = String((await projectionOf(runtime, rot.id)).backendSessionId ?? "");
      details.rotationBackendAfterRotation = rotBackendAfter;
      const postTurn = await waitNewAssistant(rotatedBase, rotBackendAfter, FIXTURE.aFeature, new Set(), 180_000, wireLog);
      details.postRotationCompleted = postTurn.completed;
      if (postTurn.completed) {
        checkReplyBytes("post-rotation", postTurn.text, FEATURE_BYTES, ROOT_BYTES);
        checkUserAttachmentPaths("post-rotation", postTurn.newMessages, FEATURE_ATTACH, ROOT_ATTACH);
      } else {
        failures.push("R rotation: no attachment turn settled on the recovered endpoint");
      }
    }
    const finalProjection = await projectionOf(runtime, rot.id);
    details.finalRotationProjection = {
      status: finalProjection.status,
      worktreePath: finalProjection.worktreePath,
      worktreeState: finalProjection.worktreeState,
    };
    if (finalProjection.worktreePath !== FIXTURE.aFeature) {
      failures.push(`R rotation: session worktreePath drifted to ${String(finalProjection.worktreePath)}`);
      blocker = true;
    }
    await databaseSnapshot(scratch, "db-after");
  } catch (error) {
    failures.push(`R harness error ${errorCode(error)}: ${String((error as Error).message ?? error)}`);
  } finally {
    for (const answerer of answerers) answerer.stop();
    await closeRuntime(runtime);
    restoreEnvironment();
  }
  await writeJson(join(scratch.artifactsDir, "details.json"), details);
  return { failures, gaps, blocker, details, identifiers };
};

// ---------------------------------------------------------------- H engine

const projectService = (project: Project): ProjectService => ({
  list: async () => [project],
  get: async (id) => (id === project.id ? project : undefined),
  add: async () => project,
  create: async () => project,
  remove: async () => undefined,
});

const permissionService = {
  evaluate: () => "allow",
  addRule: () => undefined,
  rules: () => [],
} as unknown as PermissionService;

const runHarness = async (): Promise<EngineResult> => {
  resetFixture();
  await seedAttachmentFiles();
  const scratch: Scratch = await makeScratch(ID, "harness");
  const polythLog = join(scratch.logsDir, "polyth.ndjson");
  const failures: string[] = [];
  const gaps: string[] = [];
  let blocker = false;
  const details: Record<string, unknown> = {};
  const identifiers: Record<string, unknown> = {};

  const rootFake = await createFakeOpenCode();
  let worktreeFake: FakeOpenCode = await createFakeOpenCode();
  const sharedSessionIdMap = new Map<string, string>();

  const endpointFor = (
    label: string, url: string, directory: string, generation: number,
  ): RuntimeEndpoint => ({
    authorityId: `phase6:${label}`,
    continuity: "verified",
    generation,
    url,
    location: { directory },
    control: { kind: "borrowed", source: "external" },
    config: { kind: "read-only" },
    authentication: { kind: "none" },
  });

  /** Production rotation happens INSIDE one facade: the lease's refresh()
   *  hands out the next endpoint generation. The mutable ref models that. */
  const makeRuntime = async (
    endpointRef: { current: RuntimeEndpoint },
    directory: string,
    label: string,
  ): Promise<AgentRuntime> => {
    const lease = {
      control: endpointRef.current.control,
      async endpoint() { return endpointRef.current; },
      async refresh() { return endpointRef.current; },
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
  let rootRuntime: AgentRuntime | undefined;
  let worktreeRuntime: AgentRuntime | undefined;
  const rootEndpointRef = { current: endpointFor("root", rootFake.baseUrl, FIXTURE.aRoot, 1) };
  const worktreeEndpointRef = { current: endpointFor("worktree", worktreeFake.baseUrl, FIXTURE.aFeature, 1) };
  try {
    rootRuntime = await makeRuntime(rootEndpointRef, FIXTURE.aRoot, "root");
    worktreeRuntime = await makeRuntime(worktreeEndpointRef, FIXTURE.aFeature, "worktree");
    const sessions = createSessionService({
      store,
      projects: projectService(project),
      permissions: permissionService,
      queue: store,
      broadcast: {
        event(event: SessionEvent) { void appendNdjson(polythLog, { t: Date.now(), kind: "event", event }); },
        projection(projection) { void appendNdjson(polythLog, { t: Date.now(), kind: "projection", projection }); },
      },
      worktrees: { list: async () => [{ path: FIXTURE.aFeature, branch: "feature" }] },
      attachments: {
        maxBytes: 1_000_000,
        stat: async (root: string, path: string) => {
          const s = await stat(join(root, path));
          return { kind: s.isFile() ? "file" as const : "dir" as const, size: s.size };
        },
      },
      runtimes: {
        forProject: async (_projectId, cwd) => (cwd === FIXTURE.aFeature ? worktreeRuntime! : rootRuntime!),
      },
    });

    const wt = await sessions.create({
      projectId: project.id, title: "072 worktree", worktreePath: FIXTURE.aFeature,
    });
    const root = await sessions.create({ projectId: project.id, title: "072 root" });
    identifiers.worktreeSession = wt.id;
    identifiers.rootSession = root.id;
    const wtBackend = String((await store.projection(wt.id))?.backendSessionId ?? "");
    identifiers.worktreeBackend = wtBackend;

    // 1. Generation-1 sends: same relative name from both sessions. The fake
    //    records the exact prompt body Polyth produced — the file part URL is
    //    the authoritative cwd-resolution evidence.
    await sessions.send(wt.id, {
      text: "gen1 worktree attach", attachments: [await attachmentRef(FEATURE_ATTACH, "h-att-wt-1")],
    });
    await sessions.send(root.id, {
      text: "gen1 root attach", attachments: [await attachmentRef(ROOT_ATTACH, "h-att-root-1")],
    });
    await sleep(300);
    const gen1WtBodies = JSON.stringify(worktreeFake.lifecycle.session(wtBackend)?.messages ?? []);
    const rootBackend = String((await store.projection(root.id))?.backendSessionId ?? "");
    const gen1RootBodies = JSON.stringify(rootFake.lifecycle.session(rootBackend)?.messages ?? []);
    details.gen1WorktreeFileUrlOk = gen1WtBodies.includes(`file://${FEATURE_ATTACH}`);
    details.gen1RootFileUrlOk = gen1RootBodies.includes(`file://${ROOT_ATTACH}`);
    if (!gen1WtBodies.includes(`file://${FEATURE_ATTACH}`)) {
      failures.push("H gen1: worktree prompt lacked the worktree-resolved file URL");
    }
    if (gen1WtBodies.includes(`file://${ROOT_ATTACH}`)) {
      failures.push("H gen1: worktree prompt carried the ROOT-resolved file URL (root byte leak)");
      blocker = true;
    }
    if (!gen1RootBodies.includes(`file://${ROOT_ATTACH}`)) {
      failures.push("H gen1: root prompt lacked the root-resolved file URL");
    }
    if (gen1RootBodies.includes(`file://${FEATURE_ATTACH}`)) {
      failures.push("H gen1: root prompt carried the WORKTREE-resolved file URL (cross-tree leak)");
      blocker = true;
    }

    // Durable record of the gen1 worktree attachment (old generation).
    const attachmentEventsOf = async (sessionId: string) =>
      (await store.events(sessionId)).filter((event) => JSON.stringify(event.data).includes(ATTACH_NAME));
    const gen1Record = JSON.stringify(await attachmentEventsOf(wt.id));
    details.gen1AttachmentEventCount = (await attachmentEventsOf(wt.id)).length;
    if (gen1Record.includes(FIXTURE.aRoot + "/" + ATTACH_NAME)) {
      failures.push("H gen1: durable attachment record references the root tree's absolute path");
      blocker = true;
    }

    // 2. Rotate the worktree endpoint mid-read: restart the fake onto a new
    //    real socket (same authoritative state), point the SAME facade's
    //    lease at the generation-2 endpoint (that is how production rotates —
    //    the lifecycle refreshes the lease after the SSE disconnect), crash
    //    the old socket, and mutate the ROOT twin file so any re-resolution
    //    against the wrong cwd becomes byte-visible.
    worktreeFake.lifecycle.finishTurn(wtBackend);
    await sleep(200);
    const rotatedFake = await worktreeFake.restart();
    const oldFake = worktreeFake;
    worktreeFake = rotatedFake;
    worktreeEndpointRef.current = endpointFor("worktree", rotatedFake.baseUrl, FIXTURE.aFeature, 2);
    await oldFake.crash().catch(() => undefined);
    await rotatedFake.waitForSseConnections(1); // facade re-attached to gen2
    await writeFile(ROOT_ATTACH, `${ROOT_BYTES}_MUTATED_AFTER_ROTATION\n`);
    // The disconnect drops the session to `unknown` and reconciliation must
    // re-verify against the new generation; sends are (correctly) refused
    // with `conflict` until then. Wait for the projection to recover.
    let recovered = true;
    try {
      await waitFor(async () => (await store.projection(wt.id))?.status === "idle",
        30_000, 300, "worktree projection recovered after rotation");
    } catch {
      recovered = false;
      const stuck = await store.projection(wt.id);
      details.postRotationProjection = { status: stuck?.status };
      failures.push(`H rotation: session never re-verified against the generation-2 endpoint (projection stuck ${String(stuck?.status)})`);
    }
    details.recoveredAfterRotation = recovered;

    // 3. Generation-2 send on the SAME canonical session: the attachment must
    //    still resolve against the worktree — not the pool's root endpoint,
    //    not the last generation's URL cache.
    let gen2SendError = "";
    try {
      await sessions.send(wt.id, {
        text: "gen2 worktree attach", attachments: [await attachmentRef(FEATURE_ATTACH, "h-att-wt-2")],
      });
    } catch (error) {
      gen2SendError = errorCode(error);
    }
    await sleep(400);
    details.gen2SendError = gen2SendError;
    const gen2Backend = String((await store.projection(wt.id))?.backendSessionId ?? "");
    details.gen2Backend = gen2Backend;
    const gen2Bodies = JSON.stringify(
      worktreeFake.lifecycle.sessions().flatMap((session) => session.messages),
    );
    details.gen2WorktreeFileUrlOk = gen2Bodies.includes(`file://${FEATURE_ATTACH}`) && gen2Bodies.includes("gen2 worktree attach");
    if (gen2SendError) {
      failures.push(`H gen2: send failed after endpoint rotation (${gen2SendError})`);
    } else {
      if (!gen2Bodies.includes("gen2 worktree attach")) {
        failures.push("H gen2: rotated endpoint never received the generation-2 prompt");
      } else if (!gen2Bodies.includes(`file://${FEATURE_ATTACH}`)) {
        failures.push("H gen2: generation-2 prompt lost the worktree-resolved file URL");
      }
      if (gen2Bodies.includes(`file://${ROOT_ATTACH}`)) {
        failures.push("H gen2: generation-2 prompt drifted to the ROOT-resolved file URL");
        blocker = true;
      }
    }
    // Root endpoint must never have seen a worktree URL at any generation.
    const rootSaw = JSON.stringify(rootFake.requests());
    if (rootSaw.includes(`file://${FEATURE_ATTACH}`)) {
      failures.push("H: the ROOT endpoint observed a worktree attachment URL");
      blocker = true;
    }

    // 4. Old-generation attachment mutation: the durable record of the gen1
    //    turn must be byte-identical after rotation + root-file mutation.
    const gen1RecordAfter = JSON.stringify(
      (await store.events(wt.id))
        .filter((event) => JSON.stringify(event.data).includes(ATTACH_NAME))
        .slice(0, details.gen1AttachmentEventCount as number),
    );
    details.gen1RecordImmutable = gen1RecordAfter === gen1Record;
    if (gen1RecordAfter !== gen1Record) {
      failures.push("H: the generation-1 durable attachment record changed across the endpoint rotation");
    }
    details.rootFileNow = (await readFile(ROOT_ATTACH, "utf8")).trim();
    await databaseSnapshot(scratch, "db-after");
  } catch (error) {
    failures.push(`H harness error ${errorCode(error)}: ${String((error as Error).message ?? error)}`);
  } finally {
    await rootRuntime?.dispose().catch(() => undefined);
    await worktreeRuntime?.dispose().catch(() => undefined);
    await rootFake.close().catch(() => undefined);
    await worktreeFake.close().catch(() => undefined);
    store.close();
  }
  await writeJson(join(scratch.artifactsDir, "details.json"), details);
  return { failures, gaps, blocker, details, identifiers };
};

// ---------------------------------------------------------------- verdict

const run = async (): Promise<void> => {
  const summaryScratch = await makeScratch(ID);
  await manifest(summaryScratch, {
    engine: "R+H",
    real: "production boot; fork + same-relative-name attachments; SIGKILL rotation of the worktree serve PID",
    harness: "fakeOpenCode x2 under production facade wiring; fake.restart() endpoint rotation; root-file mutation probe",
  });
  console.log(`[${ID}] R engine…`);
  const real = await runReal();
  console.log(`[${ID}] H engine…`);
  const harness = await runHarness();
  const failures = [...real.failures, ...harness.failures];
  const gaps = [...real.gaps, ...harness.gaps];
  const blocker = real.blocker || harness.blocker;
  const verdict: Verdict = {
    id: ID,
    verdict: failures.length > 0 ? "fail" : gaps.length > 0 ? "partial" : "pass",
    engine: "R+H",
    opencodeVersion: OPENCODE_VERSION,
    protocol: "legacy",
    observed: failures.length > 0
      ? `attachment/fork isolation violations: ${failures.slice(0, 3).join(" | ")}`
      : gaps.length > 0
        ? `no leak/drift/mutation; functional gap remains: ${gaps.join(" | ")}`
        : "fork children stayed bound to the source worktree; same-relative-name attachments resolved to source-tree bytes/URLs only, across an exact-PID endpoint kill (R) and a deterministic endpoint rotation with root-file mutation (H); the old generation's durable attachment record never changed",
    expected: "child stays in source worktree and receives only source bytes; no root byte leak, target cwd drift, or old-generation attachment mutation",
    attribution: failures.length > 0 ? "POLYTH" : gaps.length > 0 ? "POLYTH" : "NONE",
    crossTreeLeakBlocker: blocker,
    identifiers: { real: real.identifiers, harness: harness.identifiers },
    evidence: [
      "artifacts/opencode-real-world/phase-6/OC-REAL-072/real/details.json",
      "artifacts/opencode-real-world/phase-6/OC-REAL-072/harness/details.json",
      "logs/opencode-real-world/phase-6/OC-REAL-072/",
    ],
    failures: [...failures, ...gaps.map((gap) => `[gap] ${gap}`)],
  };
  await writeVerdict(summaryScratch, verdict);
};

await run();
process.exit(0);
