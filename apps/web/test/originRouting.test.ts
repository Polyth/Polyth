// Origin routing for interactive replies: permission / question / secret
// responses must target the originating session, never live activeSessionId.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });

const posted: Array<{ method?: string; path: string; body?: unknown }> = [];
(globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
  const u = new URL(String(url), "http://localhost:3000");
  let body: unknown;
  if (init?.body && typeof init.body === "string") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  posted.push({ method: init?.method, path: u.pathname, ...(body !== undefined ? { body } : {}) });

  let payload: unknown = {};
  if (u.pathname === "/api/sessions" && init?.method === "POST") {
    payload = { id: "created-session" };
  } else if (/^\/api\/sessions\/[^/]+$/.test(u.pathname) && (!init?.method || init.method === "GET")) {
    payload = {
      id: u.pathname.split("/").pop(),
      projectId: "p1",
      title: "T",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    };
  } else if (/^\/api\/sessions\/[^/]+\/events$/.test(u.pathname)) {
    payload = [];
  }

  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
};

const store = await import("../src/store.ts");
const {
  answerQuestion,
  createSession,
  rejectQuestion,
  replyPermission,
  replySecret,
} = await import("../src/init.ts");

test("reply helpers call the API for the origin session even when another session is active", async () => {
  posted.length = 0;
  store.activateSession("active-other");

  replyPermission("origin-a", "perm-1", "once");
  answerQuestion("origin-a", "q-1", { a: "yes" });
  rejectQuestion("origin-a", "q-2");
  await replySecret("origin-a", "sec-1", "dismiss");

  // Empty sessionId is a no-op and must not fall back to activeSessionId.
  replyPermission("", "perm-x", "once");
  answerQuestion("", "q-x", {});

  await new Promise((r) => setTimeout(r, 10));

  assert.ok(posted.some((p) =>
    p.method === "POST"
    && p.path === "/api/sessions/origin-a/permission/perm-1"));
  assert.ok(posted.some((p) =>
    p.method === "POST"
    && p.path === "/api/sessions/origin-a/question/q-1"));
  assert.ok(posted.some((p) =>
    p.method === "POST"
    && p.path === "/api/sessions/origin-a/question/q-2/reject"));
  assert.ok(posted.some((p) =>
    p.method === "POST"
    && p.path === "/api/sessions/origin-a/secrets/sec-1"));
  assert.equal(posted.filter((p) => p.path.includes("active-other")).length, 0);
  assert.equal(posted.filter((p) => p.path.includes("perm-x") || p.path.includes("q-x")).length, 0);
});

test("createSession returns the API id rather than reading activeSessionId", async () => {
  store.activateSession("stale-active");
  const id = await createSession("p1", { title: "workflow parent" });
  assert.equal(id, "created-session");
  assert.notEqual("stale-active", id);
});
