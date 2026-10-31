// Source-level contract for the one transient-notification standard: one
// stylesheet on canonical tokens, the shared Quiet Glass material lists, the
// placement per shell, transform-only motion that yields to reduced motion,
// and no leftover bespoke toast/update/result-card styles.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");
const notifyCss = read("../src/notify/notify.css");
const styles = read("../src/styles.css");

test("the stack sits at --z-toast: bottom-trailing above the status bar on desktop, under the session header on phone", () => {
  assert.match(notifyCss, /\.notify-stack\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*var\(--z-toast\);[^}]*inset-inline-end:\s*calc\(var\(--safe-right\) \+ var\(--space-3\)\);[^}]*bottom:\s*calc\(max\(var\(--space-3\), var\(--safe-bottom\)\)/s);
  assert.match(notifyCss, /body:has\(\.statusbar\) \.notify-stack\[data-shell="desktop"\]\s*\{\s*--notify-lift:/);
  assert.match(notifyCss, /\.notify-stack\[data-shell="phone"\]\s*\{[^}]*top:\s*calc\(var\(--safe-top\) \+ var\(--mobile-session-header-height\) \+ var\(--space-2\)\);/s);
});

test("cards use the Quiet Glass material and join the shared glass, glass-off and low-resource lists", () => {
  assert.match(notifyCss, /\.notify-card\s*\{[^}]*border:\s*1px solid var\(--material-glass-border\);[^}]*background:\s*var\(--material-glass-strong\);[^}]*box-shadow:\s*var\(--material-glass-highlight\), var\(--material-glass-shadow\);/s);
  assert.equal(styles.match(/, \.notify-card, \.sync-catch-up\)/g)?.length, 3, "blur, glass-off and low-resource lists");
});

test("motion is transform/opacity only, paces on motion tokens and stops under every reduced-motion switch", () => {
  assert.match(notifyCss, /transition:\s*transform var\(--motion-stack\) var\(--motion-stack-ease\),\s*opacity var\(--motion-normal\)/);
  assert.match(notifyCss, /@keyframes notify-in\s*\{\s*from\s*\{\s*opacity:\s*0;\s*translate:[^;]*;\s*scale:[^;]*;\s*\}/);
  assert.match(notifyCss, /\.notify-card\[data-exit-ghost="notification"\]/);
  assert.match(notifyCss, /\.notify-card\[data-exit-ghost="notification-swipe"\]/);
  assert.match(notifyCss, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.notify-card, \.notify-card-inner\s*\{\s*animation:\s*none;\s*transition:\s*none;/);
  assert.match(notifyCss, /html\[data-reduce-animations="true"\] :is\(\.notify-card, \.notify-card-inner\),\s*body\[data-desktop-low-resource="true"\] :is\(\.notify-card, \.notify-card-inner\)/);
});

test("the lifetime hairline follows the kind tone and freezes while the stack is paused", () => {
  assert.match(notifyCss, /\.notify-life\s*\{[^}]*block-size:\s*2px;[^}]*animation:\s*notify-life var\(--notify-life, 5s\) linear both;/s);
  assert.match(notifyCss, /\.notify-stack\[data-paused\] \.notify-life\s*\{\s*animation-play-state:\s*paused;/);
  assert.match(notifyCss, /html\[dir="rtl"\] \.notify-life\s*\{\s*transform-origin:\s*right center;/);
});

test("the replaced bespoke surfaces left no styles behind", () => {
  const surfaceMotion = read("../src/surfaceMotion.css");
  assert.doesNotMatch(styles, /\.error-banner|\.desktop-update-notice|error-banner-slide|error-banner-lifetime/);
  assert.doesNotMatch(surfaceMotion, /data-exit-ghost="toast"|toast-out/);
});

test("every error category keeps its own glyph", () => {
  const feedback = read("../src/components/ConnectionFeedback.tsx");
  for (const icon of ["OfflineIcon", "LockIcon", "StorageIcon", "ServerErrorIcon", "BlockedIcon", "ErrorIcon"]) {
    assert.match(feedback, new RegExp(`\\b${icon}\\b`), `${icon} must stay mapped`);
  }
  assert.match(feedback, /presentUiError\(message\)/);
  assert.match(feedback, /data: \{ category: view\.category \}/);
});

test("kind tones: info is neutral, update/progress keep the accent, a hint is teal off the accent", () => {
  assert.match(notifyCss, /:is\(\.notify-card, \.notify-glyph, \.ntc-row\)\s*\{\s*--notify-tone:\s*var\(--accent\);/);
  assert.match(notifyCss, /\[data-kind="info"\]\s*\{\s*--notify-tone:\s*var\(--muted\);\s*--notify-wash:\s*color-mix\(in srgb, var\(--text\) 8%, transparent\);/);
  assert.match(notifyCss, /\[data-kind="hint"\]\s*\{\s*--notify-tone:\s*color-mix\(in oklab, var\(--green\) 45%, var\(--blue\)\);/);
  assert.doesNotMatch(notifyCss, /\[data-kind="(update|progress)"\]/, "they inherit the accent");
});

test("the glyph has a 1px inset tinted ring and no glow; a 600 title one step under --font-body, the body one more; a two-track grid with the close in the corner", () => {
  assert.match(notifyCss, /\.notify-glyph\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px color-mix\(in srgb, var\(--notify-tone\) 26%, transparent\);/s);
  assert.doesNotMatch(notifyCss, /0 0 14px/);
  assert.match(notifyCss, /--notify-title-size:\s*calc\(var\(--font-body\) - 1px\);/);
  assert.match(notifyCss, /\.notify-title\s*\{[^}]*font-size:\s*var\(--notify-title-size\);[^}]*font-weight:\s*600;/s);
  assert.match(notifyCss, /\.notify-body\s*\{[^}]*font-size:\s*calc\(var\(--font-body\) - 2px\);/s);
  // A title alone centres on the glyph; a title with a body is taller than
  // the glyph, so it starts on the glyph's top edge.
  assert.match(notifyCss, /\.notify-main\s*\{[^}]*justify-content:\s*center;[^}]*min-block-size:\s*var\(--notify-glyph-size\);/s);
  assert.doesNotMatch(notifyCss, /\.notify-main\s*\{[^}]*padding-block-start:/s);
  assert.match(notifyCss, /--notify-close-size:\s*24px;/);
  // Two tracks: the close is not a column, so the body, excerpt, progress and
  // actions run to the content's right edge; only the title steps around it.
  assert.match(notifyCss, /grid-template-columns:\s*var\(--notify-glyph-size\) minmax\(0, 1fr\);/);
  assert.match(notifyCss, /\.notify-card-inner\[data-closable\] \.notify-title\s*\{\s*padding-inline-end:\s*var\(--notify-close-size\);/);
  // Symmetric padding: the glyph and the close's *painted stroke* sit the
  // same distance from their own card edge.
  assert.match(notifyCss, /\.notify-card-inner\s*\{[^}]*padding:\s*var\(--notify-pad\);/s);
  assert.match(notifyCss, /--notify-close-ink-pad:\s*calc\(var\(--icon-sm\) \* \(1 - 13\.75 \/ 24\) \/ 2\);/);
  assert.match(notifyCss, /--notify-close-nudge:\s*calc\(\(var\(--notify-close-size\) - var\(--icon-sm\)\) \/ 2 \+ var\(--notify-close-ink-pad\)\);/);
  assert.match(notifyCss, /\.notify-card \.notify-close\s*\{[^}]*position:\s*absolute;[^}]*inset-block-start:\s*calc\(var\(--notify-pad\) - var\(--notify-close-nudge\)\);[^}]*inset-inline-end:\s*calc\(var\(--notify-pad\) - var\(--notify-close-nudge\)\);/s);
  assert.match(notifyCss, /\.notify-excerpt,\s*\.notify-progress,\s*\.notify-actions\s*\{\s*grid-column:\s*2 \/ -1;/);
});

test("labelled actions are flat and share the text column evenly: a plain accent primary, a translucent ink wash for the rest", () => {
  assert.match(notifyCss, /\.notify-actions \.notify-action\.ui-btn\s*\{[^}]*flex:\s*1 1 0;[^}]*min-inline-size:\s*fit-content;[^}]*min-block-size:\s*max\(30px, var\(--hit-min\)\);[^}]*box-shadow:\s*none;/s);
  assert.match(notifyCss, /\.notify-actions:has\(\.notify-actions-spacer\) \.notify-action\.ui-btn\s*\{\s*flex:\s*none;/);
  assert.match(notifyCss, /\.notify-actions \.notify-action\.ui-btn--primary\s*\{\s*background:\s*var\(--accent\);\s*color:\s*var\(--accent-ink\);\s*\}/);
  // Never an opaque slab on the glass card.
  assert.match(notifyCss, /\.notify-actions \.notify-action\.ui-btn--quiet\s*\{\s*background:\s*color-mix\(in srgb, var\(--text\) 7%, transparent\);/);
});

test("touch: icon-only controls get a --tap hit area without growing, and the waiting bar's buttons reach it", () => {
  assert.match(notifyCss, /@media \(pointer: coarse\)\s*\{[^@]*\.notify-card :is\(\.notify-close, \.notify-action\.ui-icon-btn\)::after\s*\{\s*inline-size:\s*max\(100%, var\(--tap\)\);\s*block-size:\s*max\(100%, var\(--tap\)\);/s);
  assert.match(notifyCss, /\.notify-more \.ui-btn\s*\{\s*min-block-size:\s*var\(--tap\);/);
  // The nudged close sits on the card's corner; its hit area is anchored to
  // the control's outer corner so the --tap square grows inward and the card's
  // clip never eats it. The control therefore stays its own 24px.
  assert.match(notifyCss, /\.notify-card \.notify-close::after\s*\{\s*left:\s*auto;\s*top:\s*auto;\s*inset-block-start:\s*0;\s*inset-inline-end:\s*0;\s*transform:\s*none;\s*\}/);
  assert.doesNotMatch(notifyCss, /--notify-close-size:\s*max\(/);
  assert.doesNotMatch(notifyCss, /\.notify-card-inner\s*\{\s*padding-inline-end:/);
});

test("a folded card's hairline holds still, and a flick up leaves toward the edge", () => {
  assert.match(notifyCss, /\.notify-card\[data-folded\] \.notify-life\s*\{\s*opacity:\s*0;\s*animation-play-state:\s*paused;/);
  assert.match(notifyCss, /\.notify-card\[data-exit-ghost="notification-lift"\]\s*\{\s*animation:\s*notify-lift-out/);
  assert.match(notifyCss, /\.notify-stack\[data-shell="phone"\] \.notify-card\s*\{[^}]*touch-action:\s*none;/);
});

test("notification centre rows speak the card language: grid, glass, radius, unread dot, no physical border-left", () => {
  const row = styles.match(/\.ntc-row\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(row, /display:\s*grid;/);
  assert.match(row, /text-align:\s*start;/);
  assert.match(row, /min-block-size:\s*var\(--tap\);/);
  assert.match(row, /border-radius:\s*var\(--radius-surface\);/);
  assert.match(row, /border:\s*1px solid var\(--material-glass-border/);
  // Two tracks, glyph and text: the date is the meta line's last item. A third,
  // no-wrap date track took ~100px of a ~265px rail-panel row and left the title
  // a sliver (notificationCentreLayout.test.ts measures it in a browser).
  assert.match(row, /grid-template-columns:\s*auto minmax\(0, 1fr\);/);
  assert.match(styles, /\.ntc-time\s*\{[^}]*margin-inline-start:\s*auto;/);
  assert.doesNotMatch(styles, /\.ntc-row[^{]*\{[^}]*border-left/);
  assert.doesNotMatch(styles, /\.ntc-kind[^{]*\{[^}]*text-transform:\s*uppercase/);
  assert.match(styles, /\.ntc-row\.unread \.ntc-dot\s*\{\s*background:\s*var\(--notify-tone/);
  assert.match(styles, /\.ntc-row\.unread \.ntc-title\s*\{\s*font-weight:\s*650;/);
});
