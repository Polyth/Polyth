import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("workflow surfaces preserve visual and keyboard polish", async () => {
  const [view, styles] = await Promise.all([
    source("../src/components/WorkflowView.tsx"),
    source("../src/styles.css"),
  ]);

  assert.match(view, /className="workflow-node-output"[\s\S]*?tabIndex=\{0\}/);
  assert.match(view, /aria-label=\{`\$\{node\.role\} output`\}/);
  assert.match(styles, /\.view-icon > svg \{ width: 16px; height: 16px; \}/);
  assert.match(styles, /\.workflow-button\.primary-btn \{[\s\S]*?border-radius: var\(--radius-sm\)/);
  assert.match(styles, /\.workflow-definition:hover:not\(:disabled\)/);
  assert.match(styles, /\.workflow-dependency:hover:not\(\.disabled\)/);
  assert.match(styles, /\.workflow-node-activity \{[^}]*overflow-wrap: anywhere;/);
  assert.match(styles, /\.workflow-node-output \{[^}]*overscroll-behavior: contain;/);
  assert.match(styles, /\.app:not\(\.view-session\) > \.header \.header-brand strong \{ display: none; \}/);
  assert.match(styles, /\.app:not\(\.view-session\) > \.header \.header-actions \{ display: none; \}/);
  assert.match(styles, /\.app:not\(\.view-session\) > \.header \.header-profile \{[\s\S]*?width: var\(--tap\); height: var\(--tap\)/);
});
