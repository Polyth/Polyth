// The Desktop settings update row used to show the browser's native
// <progress> element: unthemed, no percentage, and in the middle of the
// "Show progress" action. It now shares the core Progress primitive.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("the Desktop update row uses the shared progress primitive and a percentage", async () => {
  const [desktop, progress, styles] = await Promise.all([
    read("../src/desktop.tsx"),
    read("../src/components/ui/Progress.tsx"),
    read("../src/styles.css"),
  ]);

  assert.match(desktop, /import \{[^}]*\bProgress\b[^}]*\} from "\.\/components\/ui\/index\.ts"/);
  assert.match(desktop, /<DownloadProgress percent=\{update\.percent\} label=\{update\.message \|\|/);
  assert.doesNotMatch(desktop, /<progress\b/, "the unthemed native element must not return");
  assert.match(desktop, /indeterminate=\{!known\}/, "before the first progress tick the bar slides");
  assert.match(desktop, /font-variant-numeric|desktop-update-progress-percent/);
  // The bar is the progress surface: the row must not also offer a button that
  // only reopens it in the small window. The tray keeps that action.
  assert.match(desktop, /update\.phase !== "downloading" && \(/);
  assert.doesNotMatch(desktop, /desktop\.settings\.showProgress/);

  // The shared primitive owns the indeterminate state and its accessible
  // semantics: no aria-valuenow when the completion is unknown.
  assert.match(progress, /indeterminate\?: boolean/);
  assert.match(progress, /indeterminate\s*\?\s*\{\}\s*:\s*\{ "aria-valuenow"/);
  assert.match(styles, /\.ui-progress--indeterminate \.ui-progress-fill\s*\{[^}]*animation: ui-progress-slide/);
  assert.match(styles, /\.desktop-update-progress-percent\s*\{[^}]*font-variant-numeric: tabular-nums/);
  assert.match(
    styles,
    /:is\(html\[data-reduce-animations="true"\], body\[data-desktop-low-resource="true"\]\) \.ui-progress--indeterminate \.ui-progress-fill\s*\{[^}]*opacity: 0\.45/,
    "reduced motion keeps a static partial bar instead of an empty track",
  );
});
