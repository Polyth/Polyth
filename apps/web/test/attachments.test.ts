// F2: composer attachment pills and timeline reducer rendering.
// DOM-free (localStorage shimmed).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AttachmentRef, JsonObject, SessionEvent } from "@polyth/contracts";

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const {
  addAttachment, attachText, clearAttachments, isLargeTextPaste, MAX_PENDING_ATTACHMENTS, newAttachmentId, pendingAttachments,
  removeAttachment, takeAttachments,
} = await import("../src/attachments.ts");
const { buildModel } = await import("../src/reduce.ts");

const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: crypto.randomUUID(), name: "a.txt", mime: "text/plain", size: 4, kind: "file", path: "a.txt", ...over,
});

test("isLargeTextPaste uses char or line thresholds", () => {
  assert.equal(isLargeTextPaste("x".repeat(1999)), false);
  assert.equal(isLargeTextPaste("x".repeat(2000)), true);
  assert.equal(isLargeTextPaste(`${"l\n".repeat(23)}x`), false);
  assert.equal(isLargeTextPaste(`${"l\n".repeat(24)}x`), true);
});

test("attachText uploads as pasted-context.txt for the given project/session", async () => {
  const posts: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const prev = globalThis.fetch;
  (globalThis as { fetch?: unknown }).fetch = async (url: string, init?: RequestInit) => {
    const u = new URL(String(url), "http://localhost/");
    let body: Record<string, unknown> | undefined;
    if (init?.body && typeof init.body === "string") {
      try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { /* ignore */ }
    }
    posts.push({ path: u.pathname, ...(body ? { body } : {}) });
    if (u.pathname.includes("/files/upload")) {
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "{}" };
    }
    if (u.pathname.includes("/files/stat")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ path: u.searchParams.get("path"), kind: "file", size: 11, mime: "text/plain" }),
        text: async () => "",
      };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  };
  try {
    const result = await attachText("proj-origin", "sess-origin", "hello paste");
    assert.equal(result.ok, true);
    const upload = posts.find((p) => p.path.includes("/files/upload"));
    assert.ok(upload?.body);
    assert.equal(upload!.body!.projectId, "proj-origin");
    assert.equal(upload!.body!.sessionId, "sess-origin");
    assert.match(String(upload!.body!.path), /pasted-context\.txt$/);
  } finally {
    (globalThis as { fetch?: unknown }).fetch = prev;
  }
});

test("pending attachments: add, dedupe, remove, take clears", () => {
  const sid = "sess-a";
  const a = ref({ id: "x1" });
  assert.ok(addAttachment(sid, a));
  // same path+range dedupes silently
  assert.ok(addAttachment(sid, ref({ id: "x2" })));
  assert.equal(pendingAttachments(sid).length, 1);
  const b = ref({ id: "x3", path: "b.txt", name: "b.txt" });
  addAttachment(sid, b);
  assert.equal(pendingAttachments(sid).length, 2);
  removeAttachment(sid, "x1");
  assert.deepEqual(pendingAttachments(sid).map((r) => r.id), ["x3"]);
  const taken = takeAttachments(sid);
  assert.equal(taken.length, 1);
  assert.equal(pendingAttachments(sid).length, 0);
});

test("pills persist per session (draft round-trip) and cap at the limit", () => {
  const sid = "sess-b";
  addAttachment(sid, ref({ id: "p1" }));
  // persisted under the draft key…
  const stored = JSON.parse(mem.get(`polyth.draft.att.${sid}`) ?? "[]") as AttachmentRef[];
  assert.equal(stored[0]?.id, "p1");
  // …and a fresh session key loads what localStorage already holds
  mem.set("polyth.draft.att.sess-c", JSON.stringify([ref({ id: "seeded" })]));
  assert.equal(pendingAttachments("sess-c")[0]?.id, "seeded");

  clearAttachments(sid);
  assert.equal(mem.has(`polyth.draft.att.${sid}`), false);

  for (let i = 0; i < MAX_PENDING_ATTACHMENTS + 3; i++) {
    addAttachment("sess-cap", ref({ id: `c${i}`, path: `f${i}.txt` }));
  }
  assert.equal(pendingAttachments("sess-cap").length, MAX_PENDING_ATTACHMENTS);
});

test("no-session pills stay in memory only", () => {
  addAttachment(null, ref({ id: "hero" }));
  assert.equal(pendingAttachments(null).length, 1);
  assert.ok(![...mem.keys()].some((k) => k === "polyth.draft.att."));
  assert.equal(takeAttachments(null)[0]?.id, "hero");
});

test("attachment IDs fall back when randomUUID is unavailable", () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: (bytes: Uint8Array) => bytes.fill(0) },
  });
  try {
    assert.equal(newAttachmentId(), "00000000-0000-4000-8000-000000000000");
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
    else delete (globalThis as { crypto?: unknown }).crypto;
  }
});

test("reducer surfaces attachments on user messages; junk rows are dropped", () => {
  let seq = 0;
  const ev = (type: string, data: JsonObject): SessionEvent => ({
    id: `e${++seq}`, sessionId: "s1", seq, time: seq, type, data, v: 1,
  });
  const refs = [
    { id: "a1", name: "a.txt", mime: "text/plain", size: 4, kind: "file", path: "a.txt" },
    { junk: true },
  ];
  const model = buildModel([ev("user/message", { text: "see file", attachments: refs as unknown as JsonObject[] })]);
  const user = model.messages[0]!;
  assert.equal(user.kind, "user");
  const atts = (user as { attachments?: AttachmentRef[] }).attachments;
  assert.equal(atts?.length, 1);
  assert.equal(atts?.[0]?.name, "a.txt");
});
