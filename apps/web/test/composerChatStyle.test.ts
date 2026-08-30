import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");

test("working status is compact and does not claim repository indexing", () => {
  const surface = read("../src/components/workspace/builtinSurfaces.tsx");
  const css = read("../src/styles.css");

  assert.doesNotMatch(surface, /Scanning repositories|indexing|usually takes a few seconds/i);
  assert.match(
    surface,
    /workingIndicator === "activity" \? activityLabel : tr\("workspace\.builtinsurfaces\.working"\)/,
    "the configured activity indicator may use a specific step while compact modes say Working",
  );
  assert.match(css, /\.focus-working-spinner\s*\{[^}]*width:\s*7px;[^}]*animation:\s*focus-working-pulse/s);
});

test("composer radius uses the shared corner setting", () => {
  const css = read("../src/styles.css");

  assert.match(css, /\.composer-card\s*\{[^}]*border-radius:\s*var\(--radius-composer\)/s);
  assert.match(css, /\.composer-simple \.composer-card\s*\{[^}]*border-radius:\s*var\(--radius-composer\)/s);
  assert.match(css, /\.composer-mobile \.composer-card\s*\{[^}]*border-radius:\s*var\(--radius-composer\)/s);
});

test("conversation rows omit role chrome and keep assistant prose unboxed", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const css = read("../src/styles.css");

  assert.doesNotMatch(timeline, /className="msg-author"/);
  assert.doesNotMatch(timeline, /<strong>(?:Polyth|You|User)<\/strong>/);
  assert.match(css, /\.msg\.user\s*\{\s*align-items:\s*flex-end;/);
  assert.match(css, /\.msg\.assistant\s*\{\s*align-items:\s*flex-start;/);
  assert.match(css, /\.msg\.user \.bubble\s*\{[^}]*background:\s*color-mix/s);
  assert.match(css, /\.msg\.assistant > \.bubble\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
});

test("message actions use one lightweight copy control and local hover zones", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const css = read("../src/styles.css");

  assert.match(timeline, /className="msg-action-btn"/);
  assert.match(timeline, /key: "copy"/);
  assert.doesNotMatch(timeline, /key: "md"|key: "json"/);
  assert.match(timeline, /prefs\.showMessageActions &&/);
  assert.match(timeline, /data-tooltip=\{entry\.disabledReason \?\? entry\.label\}/);
  assert.match(timeline, /<Icon\.more \/>/);
  assert.match(timeline, /className="msg-actions-item-label">\{entry\.label\}/);
  assert.match(css, /\.msg-action-btn\s*\{[^}]*border:\s*1px solid transparent;[^}]*background:\s*transparent;/s);
  assert.match(css, /\.msg-action-btn::after\s*\{[^}]*content:\s*attr\(data-tooltip\);/s);
  assert.match(css, /\.msg > \.bubble:hover ~ \.msg-meta \.msg-actions,/);
  assert.doesNotMatch(css, /\.msg:hover \.msg-actions|\.msg\.assistant \.msg-actions\s*\{[^}]*pointer-events:\s*auto/s);
  assert.match(css, /\.msg-actions\s*\{[^}]*gap:\s*1px;/s);
  assert.match(css, /@media \(hover:\s*none\) and \(pointer:\s*coarse\) and \(min-width:\s*481px\)/);
  assert.match(css, /@media \(max-width:\s*480px\)[\s\S]*\.msg\.assistant \.msg-actions\s*\{\s*display:\s*flex;/);
  assert.match(timeline, /key: "gallery"/);
  assert.match(timeline, /key: "regenerate"/);
  assert.match(timeline, /<AssistantAgentHeader m=\{m\} announce=\{announce\} turn=\{turn\} preliminary=\{preliminary\} \/>/);
  assert.match(timeline, /prefs\.responseActions\.map/);
  assert.match(timeline, /tr\("timeline\.startNewMultiRunFromThisAnswer"\)/);
});

test("thinking, tasks, and every execution share the compact activity-card treatment", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const execution = read("../src/components/ExecutionRow.tsx");
  const css = read("../src/styles.css");

  assert.match(timeline, /<details className="reasoning" open=\{open\}>/);
  assert.match(timeline, /<strong>Thinking<\/strong>/);
  assert.match(execution, /<div className=\{`tool-card execution-row/);
  assert.match(css, /\.reasoning,\s*\.task-list,\s*\.tool-card\.execution-row\s*\{[^}]*border:\s*0;/s);
  assert.match(css, /\.task-list\s*\{[^}]*margin:\s*var\(--space-1\) 0 0;/s);
});
