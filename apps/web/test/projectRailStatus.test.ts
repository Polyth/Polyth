import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionProjection } from "@polyth/contracts";
import { EMPTY_PROJECT_RAIL_STATUS, projectRailStatus, projectStatusSignal, type ProjectRailStatus } from "../src/sessionStatus.ts";

register("./tsxHooks.mjs", import.meta.url);
const { ProjectRailMarks, projectRailStatusLabel } = await import("../src/components/sidebar/ProjectRailStatus.tsx");
const { ProjectTreeStatus, ProjectTreeStatusLabel } = await import("../src/components/sidebar/ProjectTreeStatus.tsx");

const session = (extra: Partial<SessionProjection> = {}) => ({
  id: "s", projectId: "p", title: "", status: "idle", createdAt: 1, updatedAt: 1, ...extra,
}) as SessionProjection;
const attention = (counts: Partial<NonNullable<SessionProjection["attention"]>>) => ({ questions: 0, permissions: 0, unread: 0, ...counts });
const status = (counts: Partial<ProjectRailStatus>): ProjectRailStatus => ({ ...EMPTY_PROJECT_RAIL_STATUS, ...counts });
const marks = (counts: Partial<ProjectRailStatus>) => renderToStaticMarkup(createElement(ProjectRailMarks, { status: status(counts) }))
  .replace(/<\/?bdi[^>]*>/g, "");
const tree = (counts: Partial<ProjectRailStatus>) => renderToStaticMarkup(createElement(ProjectTreeStatus, { status: status(counts) }))
  .replace(/<\/?bdi[^>]*>/g, "");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const railBlock = css.slice(css.indexOf("/* A project's status on its rail tile"), css.indexOf(".sidebar-project-rail-tooltip-copy > .sidebar-project-rail-tooltip-status"));

test("each chat counts once, under the status its row shows", () => {
  assert.deepEqual(projectRailStatus([
    session({ attention: attention({ permissions: 3, questions: 1, unread: 2 }) }),
    session({ attention: attention({ questions: 2 }) }),
    session({ status: "waiting" }),
    session({ attention: attention({ unread: 5 }) }),
    session({ status: "working", attention: attention({ unread: 5 }) }),
    session({ status: "reconciling" }),
    session({ status: "failed" }),
    session({ resume: { resumeAt: Date.now() + 60_000, scope: "quota", attempt: 1, userMessageSeq: 2 } }),
  ]), status({ permissions: 1, questions: 2, results: 1, working: 1, reconciling: 1, failed: 1, limited: 1 }));
});

test("a runtime changed outside a planned handoff waits on a person; a Polyth-owned one recovers by itself", () => {
  assert.equal(projectRailStatus([session({ status: "epoch-pending", runtimeControl: "borrowed" } as Partial<SessionProjection>)]).runtime, 1);
  assert.deepEqual(projectRailStatus([session({ status: "epoch-pending", runtimeControl: "owned" } as Partial<SessionProjection>)]), status({}));
});

test("nothing that needs no person and does not move reaches the icon", () => {
  assert.deepEqual(projectRailStatus([
    session(),
    session({ status: "archived", attention: attention({ permissions: 1, unread: 1 }) }),
    session({ status: "unknown" }),
    session({ parentId: "root", attention: attention({ unread: 1 }) }),
    session({ parentId: "root", status: "failed" }),
    session({ muted: true, attention: attention({ unread: 1 }) }),
    session({ muted: true, status: "failed" }),
  ]), status({}));
});

test("a chat armed to wake by itself is paused, but its unread reply is still a result", () => {
  const waits = [{ id: "w1", kind: "session" as const, sourceSessionId: "child", since: 1 }];
  assert.deepEqual(projectRailStatus([
    session({ waits, attention: attention({ unread: 1 }) }),
    session({ waits }),
    session({ waits, muted: true, attention: attention({ unread: 1 }) }),
  ]), status({ results: 1, awaiting: 3 }));
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

test("one seal counts every chat that waits on a person, in the most urgent kind's tone", () => {
  assert.deepEqual(projectStatusSignal(status({ questions: 2, permissions: 1, failed: 1, runtime: 1 })).seal, { kind: "permission", count: 5 });
  assert.deepEqual(projectStatusSignal(status({ questions: 1, failed: 2 })).seal, { kind: "question", count: 3 });
  assert.deepEqual(projectStatusSignal(status({ failed: 1, runtime: 1 })).seal, { kind: "failed", count: 2 });
  assert.deepEqual(projectStatusSignal(status({ runtime: 1 })).seal, { kind: "runtime", count: 1 });
  assert.equal(projectStatusSignal(status({ working: 3, results: 2 })).seal, null);
});

test("the project's motion: working outranks reconnecting, which outranks a pause", () => {
  assert.equal(projectStatusSignal(status({ working: 1, reconciling: 1, limited: 1 })).activity, "working");
  assert.equal(projectStatusSignal(status({ reconciling: 1, awaiting: 1 })).activity, "reconciling");
  assert.equal(projectStatusSignal(status({ limited: 1 })).activity, "paused");
  assert.equal(projectStatusSignal(status({ awaiting: 2 })).activity, "paused");
  assert.equal(projectStatusSignal(status({ results: 1 })).activity, null);
  assert.equal(projectStatusSignal(status({ working: 2, reconciling: 1 })).running, 3);
});

test("the rail tile: one seal, a halo while chats move, a pip for an unread reply", () => {
  assert.match(marks({ permissions: 1 }), /sidebar-project-rail-seal status-seal" data-kind="permission"[^>]*><svg/);
  assert.match(marks({ questions: 1 }), /data-kind="question"[^>]*><svg/);
  assert.match(marks({ failed: 1 }), /data-kind="failed"[^>]*><svg/);
  assert.match(marks({ permissions: 2, questions: 1 }), /data-kind="permission"[^>]*><svg class="status-seal-count"[^>]*><text [^>]*>3<\/text>/, "several show how many, drawn in the seal's box");
  assert.match(marks({ questions: 12 }), /data-kind="question" data-wide=""[^>]*><svg class="status-seal-count"[^>]*><text [^>]*>9\+</);
  assert.equal((marks({ permissions: 1, questions: 1, failed: 1 }).match(/ status-seal"/g) ?? []).length, 1, "never more than one seal");
  assert.match(marks({ working: 1 }), /sidebar-project-rail-halo" data-activity="working"/);
  assert.match(marks({ reconciling: 1 }), /data-activity="reconciling"/);
  assert.match(marks({ limited: 1 }), /data-activity="paused"/);
  assert.match(marks({ results: 1 }), /sidebar-project-rail-pip/);
  assert.match(marks({ results: 1, working: 1 }), /halo[\s\S]*pip/, "a result no longer hides that chats work");
  assert.doesNotMatch(marks({ results: 4 }), /4/, "the pip does not count");
  assert.equal(marks({}), "");
});

test("the tree row: running count, seal capsule with its glyph and count, pip", () => {
  const busy = tree({ working: 2, permissions: 3, results: 1 });
  assert.match(busy, /project-status-pip/);
  assert.match(busy, /project-status-running" data-activity="working"><span class="session-lead-spinner project-status-spinner"><\/span>2</);
  assert.match(busy, /project-status-seal status-seal" data-kind="permission"><svg[\s\S]*<\/svg>3</);
  assert.match(tree({ working: 1 }), /project-status-spinner"><\/span><\/span>/, "one running chat shows the ring alone");
  assert.match(tree({ questions: 1 }), /data-kind="question" data-solo=""><svg/, "one waiting chat is a round seal");
  assert.match(tree({ reconciling: 1 }), /session-lead-spinner project-status-spinner reconciling/);
  assert.match(tree({ awaiting: 1 }), /project-status-paused/);
  assert.equal(tree({}), "");
  assert.doesNotMatch(tree({ results: 2 }), /project-status"/, "an unread reply alone is just the pip");
});

test("the button's name carries every count", () => {
  const label = projectRailStatusLabel("Polyth", status({ permissions: 1, results: 12, working: 2, failed: 1 }));
  assert.match(label, /^Polyth\. /);
  assert.match(label, /: 1\. /);
  assert.match(label, /: 2\. /);
  assert.match(label, /: 9\+$/, "results past the loaded ten are only known to be more");
  assert.match(projectRailStatusLabel("Polyth", status({ permissions: 12 })), /: 12$/);
  assert.equal(projectRailStatusLabel("Polyth", status({})), "Polyth");
  const treeLabel = renderToStaticMarkup(createElement(ProjectTreeStatusLabel, { status: status({ questions: 2 }) }));
  assert.match(treeLabel, /^<span class="sr-only">\. [^<]+: 2<\/span>$/);
  assert.equal(renderToStaticMarkup(createElement(ProjectTreeStatusLabel, { status: status({}) })), "");
});

test("the seal snaps to whole pixels and its cut-out follows it, mirrored with the shell", () => {
  // The rail scale is a percentage: at 0.9 a 15px seal is 13.5px, and the
  // browser rasterizes that by the tile's subpixel position, so two tiles in
  // one state wore seals a pixel apart. A rounded second declaration sits
  // over the plain calc, which stays as the fallback.
  assert.match(railBlock, /--rail-seal: calc\(15px \* var\(--rail-scale-left, 1\)\);\n {2}--rail-seal: round\(calc\(15px \* var\(--rail-scale-left, 1\)\), 1px\);/);
  assert.match(railBlock, /\.sidebar-project-rail-seal \{[^}]*top: 0;\n {2}inset-inline-end: 0;/);
  // A real hole in the icon and the halo instead of a --panel ring, which
  // mismatched the active tile's glass.
  assert.doesNotMatch(railBlock, /0 0 0 1px var\(--panel\)/);
  // `:is()` takes no relative selectors: `:is(> .a)` would drop the rule.
  assert.match(railBlock, /:has\(> \.sidebar-project-rail-seal\) > :is\(\.project-glyph, \.sidebar-project-rail-halo\) \{[^}]*mask-composite: intersect;/);
  assert.match(railBlock, /\.sidebar-project-rail-item:dir\(rtl\):has\(> \.sidebar-project-rail-seal\) > \.project-glyph \{[^}]*--rail-hole-from: 270deg;/);
});

test("the halo turns by transform only and lights no full contour", () => {
  const comet = /\.sidebar-project-rail-halo-comet \{([^}]*)\}/.exec(railBlock)?.[1] ?? "";
  assert.match(comet, /animation: rail-halo-turn 2\.8s linear infinite;/);
  assert.match(comet, /conic-gradient\(from 0deg, transparent 0 64%/, "most of the contour stays dark: a lit one reads as the selected tile");
  const keyframes = /@keyframes rail-halo-turn \{([^}]*\}[^}]*)\}/.exec(railBlock)?.[1] ?? "";
  assert.match(keyframes, /transform: rotate\(1turn\)/);
  assert.doesNotMatch(keyframes, /width|height|inset|box-shadow/);
  // Masks, not borders: the borderless look blanks every border.
  assert.doesNotMatch(/\.sidebar-project-rail-halo-ring \{([^}]*)\}/.exec(railBlock)?.[1] ?? "", /border(?!-radius)/);
  assert.match(railBlock, /\[data-activity="paused"\] \.sidebar-project-rail-halo-comet \{[^}]*animation: none;/);
});

test("the pip sits on the rail's edge, inside the list that clips past it", () => {
  assert.match(css, /\.sidebar-project-rail-list \{[^}]*width: calc\(100% \+ 2 \* var\(--space-1\) \* var\(--rail-scale-left, 1\)\);[^}]*margin-inline: calc\(-1 \* var\(--space-1\) \* var\(--rail-scale-left, 1\)\);/);
  assert.match(railBlock, /\.sidebar-project-rail-pip \{[^}]*inset-inline-start: calc\(-1px - \(var\(--rail-project-track\) - 1px - var\(--rail-project-item\)\) \/ 2\);/);
});

test("a tooltip swatch sits in the lowercase band of the text beside it", () => {
  const line = /\.sidebar-project-rail-tooltip-line \{([^}]*)\}/.exec(css);
  assert.match(line?.[1] ?? "", /align-items: baseline;/, "the swatch hangs from the text baseline, not the line box centre");
  const swatch = /\.sidebar-project-rail-tooltip-swatch \{([^}]*)\}/.exec(css)?.[1] ?? "";
  // Centred on the line box or on the cap height it hung above the word.
  assert.match(swatch, /--rail-swatch: 7px;/);
  assert.match(swatch, /top: calc\(var\(--rail-swatch\) \/ 2 - 0\.5ex\);/, "centred on half the x-height");
  assert.match(swatch, /position: relative;/);
  assert.doesNotMatch(swatch, /cap\)/);
  const keyframes = /@keyframes rail-working-breathe \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  for (const [, factor] of keyframes.matchAll(/scale\(([\d.]+)\)/g)) assert.ok(Number(factor) <= 1, "the breathing swatch never grows past its box");
});
