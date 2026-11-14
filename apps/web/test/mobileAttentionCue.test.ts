import test from "node:test";
import assert from "node:assert/strict";
import type { SessionProjection } from "@polyth/contracts";
import {
  attentionKindLabel,
  deriveAttentionCue,
  isAttentionKind,
  takeAttentionSnapshot,
} from "../src/mobileAttentionCue.ts";

const mockSession = (overrides: Partial<SessionProjection>): SessionProjection => ({
  id: "s1",
  projectId: "p1",
  title: "Session 1",
  status: "idle",
  createdAt: 1000,
  updatedAt: 2000,
  ...overrides,
});

test("isAttentionKind correctly identifies attention kinds", () => {
  assert.equal(isAttentionKind("needs-approval"), true);
  assert.equal(isAttentionKind("needs-reply"), true);
  assert.equal(isAttentionKind("failed"), true);
  assert.equal(isAttentionKind("working"), false);
  assert.equal(isAttentionKind("regular"), false);
  assert.equal(isAttentionKind("unread"), false);
  assert.equal(isAttentionKind("reconciling"), false);
});

test("attentionKindLabel returns appropriate localized or fallback text", () => {
  assert.ok(attentionKindLabel("needs-approval").length > 0);
  assert.ok(attentionKindLabel("needs-reply").length > 0);
  assert.ok(attentionKindLabel("failed").length > 0);
});

test("deriveAttentionCue detects transition to needs-approval in another session", () => {
  const s1 = mockSession({ id: "s1", title: "Active Session", status: "working" });
  const s2Before = mockSession({ id: "s2", title: "Worker Session", status: "working" });
  const s2After = mockSession({
    id: "s2",
    title: "Worker Session",
    status: "working",
    attention: { permissions: 1, questions: 0, unread: 0 },
  });

  const prev = takeAttentionSnapshot([s1, s2Before]);
  const cue = deriveAttentionCue(prev, [s1, s2After], "s1", {});

  assert.ok(cue !== null);
  assert.equal(cue?.sessionId, "s2");
  assert.equal(cue?.kind, "needs-approval");
  assert.equal(cue?.sessionTitle, "Worker Session");
});

test("deriveAttentionCue detects transition to needs-reply (questions) in another session", () => {
  const s1 = mockSession({ id: "s1", title: "Active Session", status: "working" });
  const s2Before = mockSession({ id: "s2", title: "Ask Session", status: "working" });
  const s2After = mockSession({
    id: "s2",
    title: "Ask Session",
    status: "waiting",
    attention: { permissions: 0, questions: 1, unread: 0 },
  });

  const prev = takeAttentionSnapshot([s1, s2Before]);
  const cue = deriveAttentionCue(prev, [s1, s2After], "s1", {});

  assert.ok(cue !== null);
  assert.equal(cue?.sessionId, "s2");
  assert.equal(cue?.kind, "needs-reply");
  assert.equal(cue?.sessionTitle, "Ask Session");
});

test("deriveAttentionCue detects transition to failed in another session", () => {
  const s1 = mockSession({ id: "s1", title: "Active Session", status: "working" });
  const s2Before = mockSession({ id: "s2", title: "Failed Session", status: "working" });
  const s2After = mockSession({
    id: "s2",
    title: "Failed Session",
    status: "failed",
  });

  const prev = takeAttentionSnapshot([s1, s2Before]);
  const cue = deriveAttentionCue(prev, [s1, s2After], "s1", {});

  assert.ok(cue !== null);
  assert.equal(cue?.sessionId, "s2");
  assert.equal(cue?.kind, "failed");
  assert.equal(cue?.sessionTitle, "Failed Session");
});

test("deriveAttentionCue ignores attention state changes in the active session", () => {
  const s1Before = mockSession({ id: "s1", title: "Active Session", status: "working" });
  const s1After = mockSession({
    id: "s1",
    title: "Active Session",
    status: "failed",
    attention: { permissions: 1, questions: 0, unread: 0 },
  });

  const prev = takeAttentionSnapshot([s1Before]);
  const cue = deriveAttentionCue(prev, [s1After], "s1", {});

  assert.equal(cue, null);
});

test("deriveAttentionCue ignores archived sessions", () => {
  const s1 = mockSession({ id: "s1", title: "Active", status: "idle" });
  const s2Before = mockSession({ id: "s2", title: "Other", status: "working" });
  const s2After = mockSession({ id: "s2", title: "Other", status: "archived" });

  const prev = takeAttentionSnapshot([s1, s2Before]);
  const cue = deriveAttentionCue(prev, [s1, s2After], "s1", {});

  assert.equal(cue, null);
});

test("deriveAttentionCue prioritizes needs-approval over needs-reply and failed", () => {
  const s1 = mockSession({ id: "s1", title: "Active", status: "working" });
  const s2Before = mockSession({ id: "s2", title: "Failed Worker", status: "working" });
  const s2After = mockSession({ id: "s2", title: "Failed Worker", status: "failed" });
  const s3Before = mockSession({ id: "s3", title: "Approval Worker", status: "working" });
  const s3After = mockSession({
    id: "s3",
    title: "Approval Worker",
    status: "working",
    attention: { permissions: 1, questions: 0, unread: 0 },
  });

  const prev = takeAttentionSnapshot([s1, s2Before, s3Before]);
  const cue = deriveAttentionCue(prev, [s1, s2After, s3After], "s1", {});

  assert.ok(cue !== null);
  assert.equal(cue?.sessionId, "s3");
  assert.equal(cue?.kind, "needs-approval");
});

test("deriveAttentionCue returns null when no state changes occur", () => {
  const s1 = mockSession({ id: "s1", title: "Active", status: "working" });
  const s2 = mockSession({
    id: "s2",
    title: "Other",
    status: "working",
    attention: { permissions: 1, questions: 0, unread: 0 },
  });

  const prev = takeAttentionSnapshot([s1, s2]);
  const cue = deriveAttentionCue(prev, [s1, s2], "s1", {});

  assert.equal(cue, null);
});

test("mobile header title has no arrow, keeps its context on a quiet line, and keeps attention styles", async () => {
  const { readFile } = await import("node:fs/promises");
  const [styles, mobileHeaderCss, mobileHeaderTsx] = await Promise.all([
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/mobile/MobileSessionHeader.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/mobile/MobileSessionHeader.tsx", import.meta.url), "utf8"),
  ]);

  // The whole title is the control: no dropdown arrow beside it.
  assert.doesNotMatch(mobileHeaderTsx, /mobile-session-selector-arrow|Icon\.chevronDown/);
  assert.doesNotMatch(styles, /mobile-session-selector-arrow/);
  assert.doesNotMatch(mobileHeaderCss, /mobile-session-selector-arrow/);

  // Package status marks lead the name inside its own text (one centred group
  // on the title's baseline, inked and sized from the title); the owner's name
  // alone takes a quiet line under it.
  assert.match(mobileHeaderTsx, /<span className="mobile-island-title-text">\s*\{!attentionCue && \(\s*<span className="session-header-status">[\s\S]*?<\/span>\s*\)\}\s*\{activeTitleText\}\s*<\/span>/);
  assert.match(mobileHeaderTsx, /\{activeTitleText\}\s*<\/span>[\s\S]*?\{!attentionCue && !conversation && session\?\.sharing\?\.owner && \(\s*<span className="mobile-island-owner"/);
  assert.doesNotMatch(mobileHeaderTsx, /mobile-island-meta/);
  assert.match(styles, /\.mobile-island-text \{[^}]*flex-direction: column;/);
  assert.match(styles, /\.mobile-island-title-text > \.session-header-status \{[^}]*display: inline-flex;[^}]*color: var\(--muted\);/);
  assert.match(styles, /\.mobile-island-title-text > \.session-header-status > \* \{ color: inherit; \}/);
  assert.match(styles, /\.mobile-island-title-text > \.session-header-status svg \{ width: \.85em; height: \.85em;/);
  // One line, always, cut at the end: every chat's title sits at the same height.
  assert.match(styles, /\.mobile-island-title-text \{[^}]*display: block;[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis;/);
  assert.doesNotMatch(styles, /\.mobile-island-title-text \{[^}]*line-clamp/);
  assert.match(styles, /\.mobile-island-text > \.mobile-island-owner \{[^}]*color: var\(--muted\);[^}]*font-size: var\(--font-meta\);/);

  // Title reserves a leading column only for an attention dot.
  assert.match(styles, /\.mobile-session-selector\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(styles, /\.mobile-session-title-island\[data-leading-indicator\] \.mobile-session-selector\s*\{[^}]*grid-template-columns:\s*var\(--icon-md\) minmax\(0, 1fr\) var\(--icon-md\);/);
  assert.match(styles, /\.mobile-session-selector\s*\{[^}]*gap:\s*var\(--space-2\);/);
  assert.match(mobileHeaderTsx, /data-leading-indicator=\{attentionCue \? "true" : undefined\}/);

  // Transparent title retains attention copy, dots and live announcements.
  for (const [kind, color] of [["needs-approval", "amber"], ["needs-reply", "blue"], ["failed", "red"]]) {
    assert.ok(mobileHeaderCss.includes(`.mobile-island-text.attention-${kind} {\n  color: var(--${color});`));
  }
  assert.match(mobileHeaderTsx, /className=\{`mobile-island-dot \$\{attentionCue.kind\}`\} aria-hidden="true"/);
  assert.match(mobileHeaderTsx, /attentionCue && <span className="sr-only" role="status" aria-live="assertive"/);
  assert.doesNotMatch(mobileHeaderTsx, /<GlassIsland\s+className=\{`mobile-session-title-island/);

  // Clicking header opens the session needing attention
  assert.match(mobileHeaderTsx, /if \(attentionCue\) \{\s*const targetId = attentionCue\.sessionId;\s*dismissAttentionCue\(\);\s*void openSession\(targetId\);\s*return;\s*\}/);
});

test("glass title button fills its island with real spacing tokens", async () => {
  const { readFile } = await import("node:fs/promises");
  const [styles, tokens, mobileHeaderCss] = await Promise.all([
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/tokens.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/mobile/MobileSessionHeader.css", import.meta.url), "utf8"),
  ]);

  // An undeclared spacing token invalidates the whole declaration, which once
  // zeroed the title button's padding and pressed the title onto the pill edge.
  const declared = new Set([...tokens.matchAll(/(--space-[\w-]+)\s*:/g)].map((match) => match[1]));
  for (const css of [styles, mobileHeaderCss]) {
    for (const [, name] of css.matchAll(/var\((--space-[\w-]+)\)/g)) {
      assert.ok(declared.has(name), `${name} is not declared in tokens.css`);
    }
  }

  // The inline-flex glass island must stretch its row so the title centres in
  // the whole pill and the island keeps its siblings' height.
  assert.match(styles, /\.mobile-session-title-island > \.mobile-session-title-row \{ flex: 1 1 auto; height: auto; align-self: stretch; align-items: stretch; \}/);
  assert.match(styles, /\.mobile-session-floats\[data-title-mode="button"\] \.mobile-session-selector \{ min-height: 0; height: auto; \}/);
});
