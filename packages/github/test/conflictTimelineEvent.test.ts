// The conflict card is a github contribution to the shell's generic
// `session.timeline.event` slot, not a shell-owned row.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import type { SessionEvent } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const host = {
  ui: {
    icons: { pullRequest: () => null, external: () => null },
    locale: { translate: (key: string, values?: Record<string, string | number>) => `${key}${values ? ` ${Object.values(values).join(",")}` : ""}` },
  },
} as unknown as WebPackageHost;

const event = (): SessionEvent => ({
  id: "event-2",
  sessionId: "session-1",
  seq: 2,
  time: 2,
  type: "github/conflict-resolution-started",
  data: {
    prNumber: 42,
    title: "Rework session routing",
    url: "https://github.com/acme/polyth/pull/42",
    baseRefName: "main",
    headRefName: "feat/session-routing",
  },
  v: 1,
});

test("the github web entry contributes the conflict card through the timeline event slot", async () => {
  const source = await readFile(new URL("../widgets/index.tsx", import.meta.url), "utf8");
  assert.match(source, /slot: "session\.timeline\.event"/);
  assert.match(source, /"github\/conflict-resolution-started"/);
  assert.match(source, /GithubConflictTimelineEvent/);
});

test("the conflict card carries the pull-request handoff", async () => {
  const { default: GithubConflictTimelineEvent } = await import("../widgets/GithubConflictTimelineEvent.tsx");
  const element = GithubConflictTimelineEvent({ host, event: event() }) as { props: { className: string; children: unknown } };
  assert.equal(element.props.className, "msg github-conflict-card");
  assert.equal(JSON.stringify(element.props.children).includes("42"), true);
  assert.equal(JSON.stringify(element.props.children).includes("Rework session routing"), true);
  assert.equal(JSON.stringify(element.props.children).includes("https://github.com/acme/polyth/pull/42"), true);
});

test("the conflict card renders nothing for another timeline event", async () => {
  const { default: GithubConflictTimelineEvent } = await import("../widgets/GithubConflictTimelineEvent.tsx");
  const compacted: SessionEvent = { ...event(), type: "session/compacted", data: { summary: "x" } };
  assert.equal(GithubConflictTimelineEvent({ host, event: compacted }), null);
});

test("a conflict event without a pull-request number is not shown as PR #0", async () => {
  const { default: GithubConflictTimelineEvent } = await import("../widgets/GithubConflictTimelineEvent.tsx");
  for (const prNumber of [null, 0, -1, 1.5]) {
    const malformed: SessionEvent = { ...event(), data: { ...(event().data as object), prNumber } };
    assert.equal(GithubConflictTimelineEvent({ host, event: malformed }), null);
  }
});

test("a non-https link is dropped instead of becoming an empty in-app href", async () => {
  const { default: GithubConflictTimelineEvent } = await import("../widgets/GithubConflictTimelineEvent.tsx");
  for (const url of [null, "", "javascript:alert(1)", "/sessions/x"]) {
    const linkless: SessionEvent = { ...event(), data: { ...(event().data as object), url } };
    const element = GithubConflictTimelineEvent({ host, event: linkless }) as { props: { children: unknown } };
    const serialized = JSON.stringify(element.props.children);
    assert.equal(serialized.includes("\"href\""), false);
    assert.equal(serialized.includes("42"), true);
  }
});
