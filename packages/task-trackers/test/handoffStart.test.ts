import test from "node:test";
import assert from "node:assert/strict";
import type {
  CreateIsolatedSessionInput,
  CreateSessionInput,
  JsonObject,
  RouteRequest,
  SessionEvent,
  SessionProjection,
  SpaceContext,
  TaskTrackerAttachmentDto,
  TaskTrackerService,
  TaskTrackerTaskDto,
  UserTurnInput,
} from "@polyth/contracts";
import { taskTrackerRoutes } from "../src/serverEntry.ts";
import { MAX_HANDOFF_IMAGES, taskImages, type TaskImageStager } from "../src/handoffImages.ts";
import { DEFAULT_TASK_TRACKER_PREFERENCES } from "../src/types.ts";

/** Starting work from a task: shared or isolated checkout, and every picture
 *  on the card attached to the first message. */

const task = (id: string, attachments: TaskTrackerAttachmentDto[] = []): TaskTrackerTaskDto => ({
  provider: "jira",
  id,
  key: `POL-${id}`,
  title: `Task ${id}`,
  description: "Do it",
  status: { id: "todo", name: "To do", category: "todo" },
  labels: [],
  assignees: [],
  ...(attachments.length > 0 ? { attachments } : {}),
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const CARD_FILES: TaskTrackerAttachmentDto[] = [
  { id: "a1", name: "screen.png", mimeType: "image/png" },
  { id: "a2", name: "spec.pdf", mimeType: "application/pdf" },
  { id: "a3", name: "logo.svg", mimeType: "image/svg+xml" },
  // Trello reports no type for some uploads; the name says it is a picture.
  { id: "a4", name: "photo.JPG", mimeType: "" },
  { id: "a5", name: "broken.png", mimeType: "image/png" },
];

interface HarnessOptions {
  attachments?: TaskTrackerAttachmentDto[];
  stager?: TaskImageStager | null;
  isolation?: boolean;
  /** Errors the first send throws, in order; later sends succeed. */
  sendFailures?: unknown[];
}

function harness(options: HarnessOptions = {}) {
  const log: string[] = [];
  const turns: Array<{ sessionId: string; input: UserTurnInput }> = [];
  const staged: Array<{ projectId: string; name: string; size: number }> = [];
  const failures = [...options.sendFailures ?? []];
  let sessions = 0;
  const service: TaskTrackerService = {
    providers: () => [],
    listProjects: async () => [],
    listBoards: async () => [],
    listTasks: async () => [],
    getTask: async (_provider, id) => task(id, options.attachments ?? []),
    updateStatus: async (_provider, id) => task(id),
    attachmentContent: async (_provider, _taskId, attachmentId) => {
      log.push(`content:${attachmentId}`);
      if (attachmentId === "a5") throw new Error("Jira answered 404");
      const file = (options.attachments ?? []).find((item) => item.id === attachmentId)!;
      return { name: file.name, mimeType: file.mimeType || "application/octet-stream", bytes: PNG };
    },
  };
  const stager: TaskImageStager | undefined = options.stager === null ? undefined : options.stager ?? {
    maxBytes: 1024,
    stage: async ({ projectId, name, bytes }) => {
      staged.push({ projectId, name, size: bytes.length });
      return { path: `_inbox/${staged.length}-${name}`, size: bytes.length };
    },
  };
  const routes = taskTrackerRoutes({
    trackers: service,
    management: {
      preferences: () => ({ ...DEFAULT_TASK_TRACKER_PREFERENCES, agentHandoff: true }),
      recordLink: () => {},
    } as never,
    snapshot: async (sessionId) => ({ id: sessionId, projectId: "p-linked" } as SessionProjection),
    events: async () => [],
    append: async (sessionId, type) => {
      log.push(`append:${sessionId}:${type}`);
      return {} as SessionEvent;
    },
    send: async (sessionId, input) => {
      log.push(`send:${sessionId}:${input.attachments?.length ?? 0}`);
      const failure = failures.shift();
      if (failure) throw failure;
      turns.push({ sessionId, input });
      return {};
    },
    create: async (input: CreateSessionInput) => {
      sessions += 1;
      log.push(`create:${input.projectId}`);
      return { id: `s${sessions}` };
    },
    ...(options.isolation === false ? {} : {
      createIsolated: async (input: CreateIsolatedSessionInput) => {
        sessions += 1;
        log.push(`isolated:${input.projectId}:${input.title}`);
        return { id: `s${sessions}` };
      },
    }),
    images: () => stager,
  });
  const call = async (method: string, path: string, body: JsonObject = {}) => {
    let payload: unknown;
    const request = {
      path,
      method,
      url: new URL(`http://polyth.local${path}`),
      body: async () => body,
      json: (_code: number, value: unknown) => { payload = value; },
      space: { spaceId: "space-a", userId: "u", role: "member" } as SpaceContext,
    } as unknown as RouteRequest;
    await routes(request);
    return payload;
  };
  return { call, log, turns, staged };
}

test("dispatch starts an isolated session only when asked", async () => {
  const shared = harness();
  await shared.call("POST", "/api/task-trackers/dispatch", { projectId: "p1", tasks: [{ provider: "jira", taskId: "1" }] });
  assert.deepEqual(shared.log, ["create:p1", "append:s1:task/selected", "send:s1:0"]);

  const isolated = harness();
  const payload = await isolated.call("POST", "/api/task-trackers/dispatch", {
    projectId: "p1",
    isolated: true,
    tasks: [{ provider: "jira", taskId: "1" }, { provider: "jira", taskId: "2" }],
  });
  assert.deepEqual(isolated.log, [
    "isolated:p1:Task 1", "append:s1:task/selected", "send:s1:0",
    "isolated:p1:Task 2", "append:s2:task/selected", "send:s2:0",
  ]);
  assert.deepEqual((payload as { results: Array<{ sessionId?: string }> }).results.map((result) => result.sessionId), ["s1", "s2"]);

  await assert.rejects(
    isolated.call("POST", "/api/task-trackers/dispatch", { projectId: "p1", isolated: "yes", tasks: [{ provider: "jira", taskId: "1" }] }),
    { code: "invalid-input" },
  );
  const noGit = harness({ isolation: false });
  await assert.rejects(
    noGit.call("POST", "/api/task-trackers/dispatch", { projectId: "p1", isolated: true, tasks: [{ provider: "jira", taskId: "1" }] }),
    { code: "unavailable" },
  );
  assert.deepEqual(noGit.log, [], "nothing starts when isolation cannot be honoured");
});

test("every picture on the card goes into the first message; the prompt names the rest", async () => {
  const run = harness({ attachments: CARD_FILES });
  await run.call("POST", "/api/task-trackers/dispatch", { projectId: "p1", tasks: [{ provider: "jira", taskId: "7" }] });
  // The PDF is not a picture; the four images are fetched in card order.
  assert.deepEqual(run.log.filter((line) => line.startsWith("content:")), ["content:a1", "content:a3", "content:a4", "content:a5"]);
  assert.deepEqual(run.staged, [
    { projectId: "p1", name: "screen.png", size: 4 },
    { projectId: "p1", name: "photo.JPG", size: 4 },
  ]);
  const [turn] = run.turns;
  assert.deepEqual(turn?.input.attachments?.map(({ name, mime, kind, path, size }) => ({ name, mime, kind, path, size })), [
    { name: "screen.png", mime: "image/png", kind: "image", path: "_inbox/1-screen.png", size: 4 },
    { name: "photo.JPG", mime: "image/jpeg", kind: "image", path: "_inbox/2-photo.JPG", size: 4 },
  ]);
  const text = turn?.input.text ?? "";
  assert.match(text, /Task images attached to this message \(2\): screen\.png, photo\.JPG/);
  assert.match(text, /Task images not attached \(2\)/);
  assert.match(text, /- logo\.svg: image\/svg\+xml images cannot be attached/);
  assert.match(text, /- broken\.png: Jira answered 404/);
});

test("linking a task to the open session attaches its pictures too", async () => {
  const run = harness({ attachments: [CARD_FILES[0]!] });
  await run.call("POST", "/api/task-trackers/jira/tasks/9/link", { sessionId: "open-1" });
  assert.deepEqual(run.staged, [{ projectId: "p-linked", name: "screen.png", size: 4 }]);
  assert.equal(run.turns[0]?.sessionId, "open-1");
  assert.equal(run.turns[0]?.input.attachments?.[0]?.path, "_inbox/1-screen.png");

  const linkOnly = harness({ attachments: [CARD_FILES[0]!] });
  await linkOnly.call("POST", "/api/task-trackers/jira/tasks/9/link", { sessionId: "open-1", startAgent: false });
  assert.deepEqual(linkOnly.staged, [], "a plain link starts no turn and stages nothing");
});

test("an engine that refuses pictures still gets the task, told which images it misses", async () => {
  const refusal = Object.assign(new Error("Image attachments are not supported by the Example engine."), { code: "unsupported" });
  const run = harness({ attachments: [CARD_FILES[0]!], sendFailures: [refusal] });
  const payload = await run.call("POST", "/api/task-trackers/dispatch", { projectId: "p1", tasks: [{ provider: "jira", taskId: "1" }] });
  assert.deepEqual(run.log.filter((line) => line.startsWith("send:")), ["send:s1:1", "send:s1:0"]);
  assert.equal(run.turns[0]?.input.attachments, undefined);
  assert.match(run.turns[0]?.input.text ?? "", /- screen\.png: Image attachments are not supported by the Example engine\./);
  assert.equal((payload as { results: Array<{ sessionId?: string }> }).results[0]?.sessionId, "s1");

  // An uncertain outcome is never replayed.
  const unknown = Object.assign(new Error("lost"), { code: "unsupported", mutationOutcome: "unknown" });
  const uncertain = harness({ attachments: [CARD_FILES[0]!], sendFailures: [unknown] });
  const result = await uncertain.call("POST", "/api/task-trackers/dispatch", { projectId: "p1", tasks: [{ provider: "jira", taskId: "1" }] });
  assert.deepEqual(uncertain.log.filter((line) => line.startsWith("send:")), ["send:s1:1"]);
  assert.equal((result as { results: Array<{ error?: string }> }).results[0]?.error, "lost");
});

test("without a staging seam or past the turn limit, images are named instead of dropped", async () => {
  const run = harness({ attachments: [CARD_FILES[0]!], stager: null });
  await run.call("POST", "/api/task-trackers/dispatch", { projectId: "p1", tasks: [{ provider: "jira", taskId: "1" }] });
  assert.equal(run.turns[0]?.input.attachments, undefined);
  assert.match(run.turns[0]?.input.text ?? "", /- screen\.png: this server cannot pass images to sessions/);

  const many = Array.from({ length: MAX_HANDOFF_IMAGES + 2 }, (_, index): TaskTrackerAttachmentDto =>
    ({ id: `m${index}`, name: `shot-${index}.png`, mimeType: "image/png" }));
  const crowded = harness({ attachments: many });
  await crowded.call("POST", "/api/task-trackers/dispatch", { projectId: "p1", tasks: [{ provider: "jira", taskId: "1" }] });
  assert.equal(crowded.turns[0]?.input.attachments?.length, MAX_HANDOFF_IMAGES);
  assert.match(crowded.turns[0]?.input.text ?? "", /- shot-17\.png: only the first 16 images are attached/);

  const large = harness({ attachments: [CARD_FILES[0]!], stager: { maxBytes: 2, stage: async () => ({ path: "_inbox/x", size: 0 }) } });
  await large.call("POST", "/api/task-trackers/dispatch", { projectId: "p1", tasks: [{ provider: "jira", taskId: "1" }] });
  assert.match(large.turns[0]?.input.text ?? "", /- screen\.png: the image is too large to attach/);

  assert.deepEqual(taskImages(task("1", CARD_FILES)).map((item) => item.id), ["a1", "a3", "a4", "a5"]);
});
