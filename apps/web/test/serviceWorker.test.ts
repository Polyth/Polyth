import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../sw.js", import.meta.url), "utf8");

interface WorkerEvent {
  action?: string;
  data?: { json(): unknown };
  notification?: { data?: Record<string, unknown>; close(): void };
  waitUntil?(promise: Promise<unknown>): void;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function workerHarness(options: { visible?: boolean; fetchStatus?: number } = {}) {
  const listeners = new Map<string, (event: WorkerEvent) => void>();
  const notifications: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const posted: unknown[] = [];
  const fetches: FetchCall[] = [];
  const windowClient = {
    visibilityState: options.visible ? "visible" : "hidden",
    focus: async () => undefined,
    postMessage: (message: unknown) => posted.push(message),
  };
  const self = {
    addEventListener: (type: string, listener: (event: WorkerEvent) => void) => listeners.set(type, listener),
    skipWaiting: () => undefined,
    clients: {
      claim: async () => undefined,
      matchAll: async () => options.visible === undefined ? [] : [windowClient],
      openWindow: async (url: string) => { opened.push(url); },
    },
    registration: {
      showNotification: async (title: string, notificationOptions: Record<string, unknown>) => {
        notifications.push({ title, options: notificationOptions });
      },
    },
  };
  const fetchFn = async (url: string, init: RequestInit = {}) => {
    fetches.push({ url, init });
    const status = options.fetchStatus ?? 200;
    return { ok: status >= 200 && status < 300, status };
  };
  runInNewContext(source, { self, fetch: fetchFn });

  const dispatch = async (type: string, event: WorkerEvent): Promise<void> => {
    const listener = listeners.get(type);
    assert.ok(listener, `${type} listener registered`);
    let work = Promise.resolve();
    listener({
      ...event,
      waitUntil(promise) { work = Promise.resolve(promise).then(() => undefined); },
    });
    await work;
  };
  return { dispatch, notifications, opened, posted, fetches };
}

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test("PWA manifest declares standalone root scope and install icons", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")) as {
    id: string;
    start_url: string;
    scope: string;
    display: string;
    icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
  };
  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(manifest.icons.map((icon) => [icon.sizes, icon.type, icon.purpose]), [
    ["192x192", "image/png", "any maskable"],
    ["512x512", "image/png", "any maskable"],
  ]);
  for (const [file, size] of [["../icon-192.png", 192], ["../icon-512.png", 512]] as const) {
    const png = readFileSync(new URL(file, import.meta.url));
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});

test("permission push exposes allow/deny actions only when no window is visible", async () => {
  const worker = workerHarness();
  await worker.dispatch("push", {
    data: {
      json: () => ({
        kind: "permission",
        sessionId: "ses 1",
        requestId: "per/1",
        title: "Polyth — Deploy",
        body: "Deploy needs permission",
        tag: "permission-1",
      }),
    },
  });
  assert.equal(worker.notifications.length, 1);
  assert.deepEqual(plain(worker.notifications[0]!.options.actions), [
    { action: "polyth:permission-once", title: "Allow once" },
    { action: "polyth:permission-reject", title: "Deny" },
  ]);

  const visible = workerHarness({ visible: true });
  await visible.dispatch("push", { data: { json: () => ({ kind: "permission", requestId: "p" }) } });
  assert.equal(visible.notifications.length, 0);
});

test("notification actions post authenticated responses to the bound session and request", async () => {
  const worker = workerHarness();
  let closed = false;
  await worker.dispatch("notificationclick", {
    action: "polyth:permission-once",
    notification: {
      data: { sessionId: "ses 1", requestId: "per/1", kind: "permission" },
      close: () => { closed = true; },
    },
  });
  assert.equal(closed, true);
  assert.equal(worker.fetches.length, 1);
  assert.equal(worker.fetches[0]!.url, "/api/sessions/ses%201/permission/per%2F1");
  assert.equal(worker.fetches[0]!.init.credentials, "same-origin");
  assert.deepEqual(JSON.parse(String(worker.fetches[0]!.init.body)), { reply: "once" });
  assert.deepEqual(worker.opened, []);

  await worker.dispatch("notificationclick", {
    action: "polyth:question-1",
    notification: {
      data: {
        sessionId: "ses 2",
        requestId: "que/2",
        kind: "question",
        quickAnswers: [
          { title: "No", answers: { choice: "no" } },
          { title: "Yes", answers: { choice: "yes" } },
        ],
      },
      close: () => undefined,
    },
  });
  assert.equal(worker.fetches[1]!.url, "/api/sessions/ses%202/question/que%2F2");
  assert.deepEqual(JSON.parse(String(worker.fetches[1]!.init.body)), { answers: { choice: "yes" } });
});

test("complex questions offer open/reject and failed responses reopen the owning session", async () => {
  const worker = workerHarness({ fetchStatus: 401 });
  await worker.dispatch("push", {
    data: {
      json: () => ({
        kind: "question",
        sessionId: "s1",
        requestId: "q1",
        title: "Question",
        quickAnswers: [],
      }),
    },
  });
  assert.deepEqual(plain(worker.notifications[0]!.options.actions), [
    { action: "polyth:open", title: "Answer" },
    { action: "polyth:question-reject", title: "Reject" },
  ]);

  await worker.dispatch("notificationclick", {
    action: "polyth:question-reject",
    notification: {
      data: { sessionId: "s1", requestId: "q1", kind: "question" },
      close: () => undefined,
    },
  });
  assert.equal(worker.fetches[0]!.url, "/api/sessions/s1/question/q1/reject");
  assert.deepEqual(worker.opened, ["/?session=s1"]);
});
