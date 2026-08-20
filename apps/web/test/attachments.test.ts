// F2: composer attachment pills — draft store round-trip, GitHub URL pills,
// and timeline reducer rendering. DOM-free (localStorage shimmed).
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
  addAttachment, clearAttachments, githubUrlMatchesRepo, githubUrlRef,
  MAX_PENDING_ATTACHMENTS, parseGithubUrl, pendingAttachments, removeAttachment, takeAttachments,
} = await import("../src/attachments.ts");
const { buildModel } = await import("../src/reduce.ts");

const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: crypto.randomUUID(), name: "a.txt", mime: "text/plain", size: 4, kind: "file", path: "a.txt", ...over,
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

test("parseGithubUrl accepts PR/issue URLs and rejects everything else", () => {
  const pr = parseGithubUrl("https://github.com/octo/repo/pull/42");
  assert.deepEqual(pr, { owner: "octo", repo: "repo", kind: "pull", number: 42, url: "https://github.com/octo/repo/pull/42" });
  const issue = parseGithubUrl("  https://github.com/octo/repo/issues/7#issuecomment-1 ");
  assert.equal(issue?.kind, "issues");
  assert.equal(issue?.number, 7);
  assert.equal(parseGithubUrl("https://github.com/octo/repo"), null);
  assert.equal(parseGithubUrl("https://gitlab.com/octo/repo/pull/42"), null);
  assert.equal(parseGithubUrl("http://github.com/octo/repo/pull/42"), null);
  assert.equal(parseGithubUrl("check https://github.com/octo/repo/pull/42 out"), null);
});

test("github pill requires the repo to match; ref is link-only", () => {
  const parts = parseGithubUrl("https://github.com/Octo/Repo/pull/9")!;
  assert.ok(githubUrlMatchesRepo(parts, { owner: "octo", name: "repo" }));
  assert.ok(!githubUrlMatchesRepo(parts, { owner: "octo", name: "other" }));
  assert.ok(!githubUrlMatchesRepo(parts, null));
  const pill = githubUrlRef(parts);
  assert.equal(pill.kind, "url");
  assert.equal(pill.name, "PR #9");
  assert.equal(pill.url, "https://github.com/Octo/Repo/pull/9");
  assert.equal(pill.size, 0);
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
