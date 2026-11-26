import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionProjection } from "@polyth/contracts";
import { projectRailStatus } from "../src/sessionStatus.ts";

register("./tsxHooks.mjs", import.meta.url);
const { ProjectRailMarks, projectRailStatusLabel } = await import("../src/components/sidebar/ProjectRailStatus.tsx");

const session = (extra: Partial<SessionProjection> = {}) => ({
  id: "s", projectId: "p", title: "", status: "idle", createdAt: 1, updatedAt: 1, ...extra,
}) as SessionProjection;
const attention = (counts: Partial<NonNullable<SessionProjection["attention"]>>) => ({ questions: 0, permissions: 0, unread: 0, ...counts });
const marks = (status: Partial<ReturnType<typeof projectRailStatus>>) => renderToStaticMarkup(createElement(ProjectRailMarks, {
  status: { permissions: 0, questions: 0, results: 0, working: 0, ...status },
})).replace(/<\/?bdi[^>]*>/g, "");

test("each chat counts once, under the status its row shows", () => {
  assert.deepEqual(projectRailStatus([
    session({ attention: attention({ permissions: 3, questions: 1, unread: 2 }) }),
    session({ attention: attention({ questions: 2 }) }),
    session({ status: "waiting" }),
    session({ attention: attention({ unread: 5 }) }),
    session({ status: "working", attention: attention({ unread: 5 }) }),
    session({ status: "reconciling" }),
  ]), { permissions: 1, questions: 2, results: 1, working: 2 });
});

test("nothing that needs no person reaches the icon", () => {
  assert.deepEqual(projectRailStatus([
    session(),
    session({ status: "archived", attention: attention({ permissions: 1, unread: 1 }) }),
    session({ status: "unknown" }),
    session({ parentId: "root", attention: attention({ unread: 1 }) }),
    session({ muted: true, attention: attention({ unread: 1 }) }),
  ]), { permissions: 0, questions: 0, results: 0, working: 0 });
});

test("a chat armed to wake by itself shows an hourglass, but its unread reply is still a result", () => {
  const waits = [{ id: "w1", kind: "session" as const, sourceSessionId: "child", since: 1 }];
  assert.deepEqual(projectRailStatus([
    session({ waits, attention: attention({ unread: 1 }) }),
    session({ waits }),
    session({ waits, muted: true, attention: attention({ unread: 1 }) }),
  ]), { permissions: 0, questions: 0, results: 1, working: 0 });
});

test("a fork's unread reply is its own result, unlike a subagent's", () => {
  assert.equal(projectRailStatus([
    session({ parentId: "root", forkOf: "root", attention: attention({ unread: 1 }) } as Partial<SessionProjection>),
  ]).results, 1);
});

test("a subagent's request and a muted chat's request still block", () => {
  assert.equal(projectRailStatus([session({ parentId: "root", attention: attention({ permissions: 1 }) })]).permissions, 1);
  assert.equal(projectRailStatus([session({ muted: true, attention: attention({ questions: 1 }) })]).questions, 1);
});

test("one shows what it is and several show how many", () => {
  assert.match(marks({ permissions: 1 }), /is-permission"[^>]*>!</);
  assert.match(marks({ permissions: 2 }), /is-permission"[^>]*>2</);
  assert.match(marks({ questions: 1 }), /is-question"[^>]*>\?</);
  assert.match(marks({ questions: 12 }), /is-question"[^>]*>9\+</);
  assert.match(marks({ results: 1 }), /is-result is-dot"[^>]*><\/span>/);
  assert.match(marks({ results: 4 }), /is-result"[^>]*>4</);
  assert.equal(marks({}), "");
});

test("working gives its corner up to a result", () => {
  assert.match(marks({ working: 1 }), /is-working is-dot/);
  assert.doesNotMatch(marks({ working: 1, results: 1 }), /is-working/);
});

test("the button's name carries every count", () => {
  const status = { permissions: 1, questions: 0, results: 12, working: 0 };
  const label = projectRailStatusLabel("Polyth", status);
  assert.match(label, /^Polyth\. /);
  assert.match(label, /: 1\. /);
  assert.match(label, /: 9\+$/, "results past the loaded ten are only known to be more");
  assert.match(projectRailStatusLabel("Polyth", { permissions: 12, questions: 0, results: 0, working: 0 }), /: 12$/);
  assert.equal(projectRailStatusLabel("Polyth", { permissions: 0, questions: 0, results: 0, working: 0 }), "Polyth");
});

test("a mark's box and ring snap to whole pixels", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const block = css.slice(css.indexOf(".sidebar-project-rail-mark {"), css.indexOf(".sidebar-project-rail-tooltip-copy > .sidebar-project-rail-tooltip-status"));
  // The rail scale is a percentage: at 0.9 an 8px dot is 7.2px long, and the
  // browser rasterizes that as 7 or 8px by the tile's subpixel position, so two
  // projects in the same state wore differently sized marks. Each size is a
  // rounded second declaration over the plain calc, which stays as the fallback.
  assert.match(block, /--rail-mark: calc\(var\(--rail-mark-base\) \* var\(--rail-scale-left, 1\)\);/);
  assert.match(block, /--rail-mark: round\(calc\(var\(--rail-mark-base\) \* var\(--rail-scale-left, 1\)\), 1px\);/);
  assert.match(block, /--rail-mark-ring: round\(calc\(2px \* var\(--rail-scale-left, 1\)\), 1px\);/);
  assert.match(block, /\.sidebar-project-rail-mark\.is-dot \{\n {2}--rail-mark-base: 8px;/);
  assert.match(block, /inset 0 0 0 var\(--rail-mark-ring\) var\(--accent\)/);
  assert.doesNotMatch(block, /--rail-mark: calc\(8px \* var\(--rail-scale-left/);
});

test("each kind owns its corner and the bottom start stays free", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.sidebar-project-rail-mark\.is-question \{[^}]*top: 0; inset-inline-start: 0;/);
  assert.match(css, /\.sidebar-project-rail-mark\.is-permission \{[^}]*top: 0; inset-inline-end: 0;/);
  assert.match(css, /\.sidebar-project-rail-mark:is\(\.is-result, \.is-working\) \{ bottom: 0; inset-inline-end: 0; \}/);
  assert.doesNotMatch(css, /\.sidebar-project-rail-mark[^{]*\{[^}]*bottom: [^}]*inset-inline-start/);
  // A mark's own direction would decide its inline corner, so a mirrored shell
  // would keep the corners unmirrored.
  assert.doesNotMatch(css.slice(css.indexOf(".sidebar-project-rail-mark {"), css.indexOf(".sidebar-project-rail-tooltip-copy > .sidebar-project-rail-tooltip-status")), /direction:/);
});
