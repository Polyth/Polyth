// Origin routing for interactive replies: permission / question / secret
// responses must target the originating session, never live activeSessionId.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { buildModel } from "../src/reduce.ts";

let seq = 0;
function ev(type: string, data: JsonObject, sessionId = "origin-session"): SessionEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    sessionId,
    seq,
    time: 1_700_000_000_000 + seq,
    type,
    data,
    v: 1,
  };
}

const source = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("reduce stamps sessionId onto pending permission, question, and secret rows", () => {
  const model = buildModel([
    ev("permission/requested", { requestId: "p1", permission: "bash", patterns: ["*"] }, "sess-a"),
    ev("question/asked", { requestId: "q1", questions: [{ prompt: "Continue?" }] }, "sess-a"),
    ev("secret/requested", { requestId: "s1", handle: "token", label: "Token" }, "sess-a"),
  ]);
  assert.equal(model.permissions[0]?.sessionId, "sess-a");
  assert.equal(model.questions[0]?.sessionId, "sess-a");
  assert.equal(model.secrets[0]?.sessionId, "sess-a");

  const other = buildModel([
    ev("permission/requested", { requestId: "p2", permission: "edit", patterns: [] }, "sess-b"),
  ]);
  assert.equal(other.permissions[0]?.sessionId, "sess-b");
});

test("reply helpers require an explicit sessionId and never read activeSessionId", async () => {
  const init = await source("../src/init.ts");
  // Signature: first arg is sessionId for each interactive reply helper.
  assert.match(init, /export function replyPermission\(\s*sessionId: string,/);
  assert.match(init, /export function answerQuestion\(sessionId: string,/);
  assert.match(init, /export function rejectQuestion\(sessionId: string,/);
  assert.match(init, /export async function replySecret\(\s*sessionId: string,/);
  // No live-active fallback inside the reply helpers themselves.
  const replyBlock = init.slice(init.indexOf("export function replyPermission"));
  const replySection = replyBlock.slice(0, replyBlock.indexOf("export function exportSessionMarkdown"));
  assert.doesNotMatch(replySection, /store\.getState\(\)\.activeSessionId/);
  assert.match(replySection, /if \(!sessionId\) return;/);
  assert.match(replySection, /api\.replyPermission\(sessionId, requestId/);
  assert.match(replySection, /api\.answerQuestion\(sessionId, requestId/);
  assert.match(replySection, /api\.rejectQuestion\(sessionId, requestId/);
  assert.match(replySection, /api\.replySecret\(sessionId, requestId/);
});

test("PermissionBanner and QuestionCards pass origin sessionId into reply helpers", async () => {
  const banner = await source("../../../packages/permissions/widgets/PermissionBanner.tsx");
  const questions = await source("../src/components/QuestionCards.tsx");
  const secrets = await source("../../../packages/secure-safe/widgets/SecureSafeCard.tsx");
  const permissionsIndex = await source("../../../packages/permissions/widgets/index.tsx");
  const launcher = await source("../../../packages/workflow/widgets/WorkflowLauncher.tsx");
  const composer = await source("../src/components/Composer.tsx");

  assert.match(banner, /sessionId\?: string/);
  assert.match(banner, /replyPermission\(origin, p\.requestId/);
  assert.match(banner, /originSessionId\(p, sessionId\)/);
  assert.match(permissionsIndex, /sessionId: typeof context\.sessionId === "string" \? context\.sessionId/);
  assert.match(permissionsIndex, /createElement\(PendingPermissionsWidget, \{ context \}\)/);

  assert.match(questions, /answerQuestion\(q\.sessionId, q\.requestId/);
  assert.match(questions, /rejectQuestion\(q\.sessionId, q\.requestId\)/);
  assert.match(secrets, /replySecret\(secret\.sessionId, secret\.requestId/);

  // WorkflowLauncher uses createSession's returned id, not a raced activeSessionId.
  assert.match(launcher, /parentSessionId = await createSession\(/);
  assert.doesNotMatch(launcher, /getState\(\)\.activeSessionId/);

  // goalAttach clear is gated on the captured target session.
  assert.match(composer, /if \(sessionIdRef\.current !== target\) return;/);
  assert.match(composer, /api\.goalAttach\(target, objective\)/);
});
