import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { SessionProjection } from "@polyth/contracts";
import { draftTitleSource, sessionDraftLine, sessionDraftMark } from "../src/sessionDraft.ts";

const base: SessionProjection = { id: "s", projectId: "p", title: "", status: "idle", createdAt: 1, updatedAt: 1 };
const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("a summary marks a draft by its preview and ignores stale cached draft text", () => {
  assert.equal(sessionDraftLine({ ...base, summary: true, draftPreview: "Plan the release" }), "Plan the release");
  // A summary replaced an older full row: its retained `draft` is stale.
  assert.equal(sessionDraftLine({ ...base, summary: true, draft: "old text" }), undefined);
  // A full projection carries the text itself.
  assert.equal(sessionDraftLine({ ...base, draft: "\n  First line \nsecond" }), "First line");
  assert.equal(sessionDraftLine({ ...base, draft: "   " }), undefined);
});

test("a chat that never ran is a draft; a chat with history marks its draft only while closed", () => {
  const parked = { ...base, summary: true as const, draftPreview: "Ship it" };
  assert.equal(sessionDraftMark(parked, false), "Ship it");
  assert.equal(sessionDraftMark(parked, true), "Ship it", "an open draft chat stays marked until sent");
  const followUp = { ...parked, lastTurnAt: 10 };
  assert.equal(sessionDraftMark(followUp, false), "Ship it");
  assert.equal(sessionDraftMark(followUp, true), undefined, "the open chat already shows its draft in the composer");
  assert.equal(sessionDraftMark({ ...base, summary: true }, false), undefined);
});

test("only a chat that never ran is named by its draft", () => {
  assert.equal(draftTitleSource({ ...base, summary: true, draftPreview: "Ship it" }), "Ship it");
  assert.equal(draftTitleSource({ ...base, summary: true, draftPreview: "Ship it", lastTurnAt: 10 }), undefined);
});

test("both navigators render the shared draft mark with the canonical accent Badge", async () => {
  for (const path of ["../src/components/sidebar/SessionList.tsx", "../src/components/mobile/MobileNavigator.tsx"]) {
    const source = await read(path);
    assert.match(source, /sessionDraftMark\(/, `${path} resolves the mark through the shared helper`);
    assert.match(source, /<Badge tone="accent" className="session-draft-mark">\{draftLabel\}<\/Badge>/, path);
    assert.match(source, /draftTitleSource\(/, `${path} names a never-run draft chat by its text`);
  }
});

test("holding Send parks a new chat through the same creation path as sending it", async () => {
  const composer = await read("../src/components/Composer.tsx");
  const park = composer.slice(composer.indexOf("} else if (activeProjectId && parkAsDraft) {"), composer.indexOf("} else if (activeProjectId) {"));
  assert.match(park, /createNewChat\(projectId, \(\) => false\)/, "a draft chat is created without being opened");
  assert.match(park, /stageTargetDraft\(created, scope\)/, "text and pills move into the chat's own draft record");
  assert.match(park, /saveDraftToServerNow\(created, scope\)/, "the draft reaches the server at once, so every navigator lists it");
  assert.doesNotMatch(park, /deliver\(|beginSessionSpawn|beginPendingSend/, "parking starts no turn, echo or spawn surface");
  assert.match(composer, /const echoId = command === null && delivery !== "queue" && !hiddenUserMessage && !parkAsDraft/);
});
