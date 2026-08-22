import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");

test("working status is compact and does not claim repository indexing", () => {
  const surface = read("../src/components/workspace/builtinSurfaces.tsx");
  const css = read("../src/styles.css");

  assert.doesNotMatch(surface, /Scanning repositories|indexing|usually takes a few seconds/i);
  assert.match(surface, /<span>Working…<\/span>/);
  assert.match(css, /\.focus-working-spinner\s*\{[^}]*width:\s*7px;[^}]*animation:\s*focus-working-pulse/s);
});

test("conversation rows omit visible role titles and keep subtle, opposed alignment", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const css = read("../src/styles.css");

  assert.doesNotMatch(timeline, /className="msg-author"/);
  assert.doesNotMatch(timeline, /<strong>(?:Polyth|You|User)<\/strong>/);
  assert.match(css, /\.msg\.user\s*\{\s*align-items:\s*flex-end;/);
  assert.match(css, /\.msg\.assistant\s*\{\s*align-items:\s*flex-start;/);
  assert.match(css, /\.msg\.user \.bubble\s*\{[^}]*background:\s*color-mix/s);
  assert.match(css, /\.msg\.assistant > \.bubble\s*\{[^}]*background:\s*color-mix/s);
});

test("thinking and command blocks share the light collapsible surface", () => {
  const timeline = read("../src/components/Timeline.tsx");
  const css = read("../src/styles.css");

  assert.match(timeline, /<details className="reasoning" open=\{open\}>/);
  assert.match(timeline, /<details className=\{`tool-card/);
  assert.match(css, /\.reasoning, \.tool-card\s*\{[^}]*background:\s*color-mix/s);
});
