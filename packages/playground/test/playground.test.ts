import test from "node:test";
import assert from "node:assert/strict";
import {
  PLAYGROUND_ARTIFACT_PATH,
  PLAYGROUND_CHANNEL,
  playgroundBootstrapPrompt,
  playgroundSelectionPrompt,
  sandboxPreviewDocument,
} from "../src/index.ts";

test("bootstrap keeps the playground artifact explicit and project edits bounded", () => {
  const fresh = playgroundBootstrapPrompt(false);
  const existing = playgroundBootstrapPrompt(true);

  assert.match(fresh, new RegExp(PLAYGROUND_ARTIFACT_PATH.replaceAll(".", "\\.")));
  assert.match(fresh, /first relevant user request/);
  assert.match(fresh, /Never read credentials/);
  assert.match(existing, /Read it before editing/);
});

test("selection context is compact and points back to the canonical artifact", () => {
  const prompt = playgroundSelectionPrompt({
    selector: "main > button.primary",
    tag: "button",
    text: "  Save   changes  ",
  });

  assert.match(prompt, /\.polyth\/playground\/index\.html/);
  assert.match(prompt, /main > button\.primary/);
  assert.match(prompt, /"Save changes"/);
});

test("preview document injects an isolated bridge and blocks connections by default", () => {
  const html = sandboxPreviewDocument("<!doctype html><html><head><title>x</title></head><body>Hi</body></html>");

  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /img-src[^;]*https:/);
  assert.doesNotMatch(html, /script-src[^;]*https:/);
  assert.match(html, new RegExp(PLAYGROUND_CHANNEL));
  assert.match(html, /<title>x<\/title>/);
  assert.match(html, /<body>Hi<\/body>/);
});

test("network mode only relaxes HTTPS connections", () => {
  const html = sandboxPreviewDocument("<main>hello</main>", true);

  assert.match(html, /connect-src https:/);
  assert.match(html, /img-src data: blob: https:/);
  assert.match(html, /script-src 'unsafe-inline' 'unsafe-eval' https:/);
  assert.match(html, /frame-src 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.match(html, /<main>hello<\/main>/);
});
