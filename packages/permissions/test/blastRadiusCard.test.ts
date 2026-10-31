// The permission card's blast-radius and reason text: localized from stable
// codes, tolerant of codes and kinds from a newer server, high-risk only.
import test from "node:test";
import assert from "node:assert/strict";
import { en } from "../src/i18n/en.ts";
import {
  blastRadiusLines,
  permissionBlastRadius,
  riskReasonLabels,
  sessionWorkspaceRoots,
  type Translate,
} from "../widgets/blastRadius.ts";
import type { BlastRadiusEffect } from "../src/risk.ts";

const messages = en as Record<string, string>;
// The readable line; the target split is covered on its own below.
const readable = (lines: Array<{ text: string; notes: string[] }>) => lines.map(({ text, notes }) => ({ text, notes }));
const translate: Translate = (key, vars = {}) => {
  const template = messages[key];
  if (!template) return key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));
};

test("reason labels skip unknown or malformed codes instead of showing them raw", () => {
  assert.deepEqual(
    riskReasonLabels(["history-rewrite", "from-a-newer-server", 42, "infrastructure-destruction", "history-rewrite"], translate),
    [en["permissionbanner.reason.history-rewrite"], en["permissionbanner.reason.infrastructure-destruction"]],
  );
  assert.deepEqual(riskReasonLabels(undefined, translate), []);
});

test("a high-risk card says what is affected and where", () => {
  const card = (command: string) => readable(permissionBlastRadius(
    { permission: "bash", patterns: [command], preview: { title: "bash", lines: [command], risk: "high", reasons: [] } },
    ["/home/dev/project"],
    translate,
  ));
  assert.deepEqual(card("rm -rf /var/lib/app"), [
    { text: "Deletes /var/lib/app and everything in it", notes: ["outside the workspace"] },
  ]);
  assert.deepEqual(card("git push --force origin main"), [
    { text: "Force-pushes main to origin, replacing its history", notes: [] },
  ]);
  assert.deepEqual(card("git push -f"), [
    { text: "Force-pushes the current branch to its upstream, replacing its history", notes: [] },
  ]);
  assert.deepEqual(card("find . -type f -delete"), [
    { text: "Deletes . and everything in it", notes: ["the whole workspace", "nothing narrows it"] },
  ]);
  assert.deepEqual(card("terraform destroy -auto-approve"), [
    { text: "Destroys resources: terraform destroy", notes: ["nothing narrows it"] },
  ]);
  assert.deepEqual(card("git stash clear"), [{ text: "Drops every stash", notes: [] }]);
});

test("targets inside the workspace read relative to it and split around the target", () => {
  const lines = permissionBlastRadius(
    { permission: "bash", patterns: ["rm -rf /home/dev/project/build"], preview: { title: "bash", lines: [], risk: "high" } },
    ["/home/dev/project/"],
    translate,
  );
  assert.deepEqual(lines, [{
    text: "Deletes build and everything in it",
    target: { before: "Deletes ", value: "build", after: " and everything in it" },
    notes: [],
  }]);
});

test("routine cards and cards without a preview carry no blast radius", () => {
  assert.deepEqual(permissionBlastRadius({ permission: "bash", patterns: ["rm -rf /"] }, [], translate), []);
  assert.deepEqual(permissionBlastRadius(
    { permission: "bash", patterns: ["rm -rf dist"], preview: { title: "bash", lines: [], risk: "medium" } }, [], translate), []);
});

test("unknown effect kinds and scopes from a newer module are skipped", () => {
  const effects = [
    { kind: "teleport", target: "x" },
    { kind: "delete", target: "a", scope: "moon" },
  ] as unknown as BlastRadiusEffect[];
  assert.deepEqual(readable(blastRadiusLines({ effects, truncated: true }, translate)), [
    { text: "Deletes a", notes: [] },
    { text: "More effects are not listed", notes: [] },
  ]);
});

test("the client's workspace roots come from the session's directory and worktree", () => {
  assert.deepEqual(sessionWorkspaceRoots(undefined), []);
  assert.deepEqual(sessionWorkspaceRoots({ runtimeBinding: { location: { directory: "/w" } }, worktreePath: "/w" }), ["/w"]);
  assert.deepEqual(sessionWorkspaceRoots({ worktreePath: "/wt" }), ["/wt"]);
});
