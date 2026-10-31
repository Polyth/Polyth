import test from "node:test";
import assert from "node:assert/strict";
import { createServerServiceRegistry, SESSION_PURPOSES, type ServerPackageHost } from "@polyth/plugins";
import {
  PLAYGROUND_CHANNEL,
  PLAYGROUND_IMPLEMENTATION_SNAPSHOT_LIMIT,
  PLAYGROUND_PURPOSE,
  playgroundArtifactPath,
  playgroundImplementationPrompt,
  playgroundSelectionPrompt,
  playgroundTurnContext,
  sandboxPreviewDocument,
} from "../src/index.ts";
import registerPackage from "../src/serverEntry.ts";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const PATH_A = `.polyth/playground/${SESSION_A}/index.html`;
const PATH_B = `.polyth/playground/${SESSION_B}/index.html`;

test("each canonical session gets its own artifact path", () => {
  assert.equal(playgroundArtifactPath(SESSION_A), PATH_A);
  assert.equal(playgroundArtifactPath(SESSION_B), PATH_B);
  assert.equal(playgroundArtifactPath(SESSION_A.toUpperCase()), PATH_A);
  assert.notEqual(PATH_A, PATH_B);
  assert.notEqual(PATH_A, ".polyth/playground/index.html");

  for (const unsafe of ["", "playground", "../etc/passwd", `${SESSION_A}/../secret`, ".polyth/playground/index.html", `${SESSION_A}/index.html`]) {
    assert.throws(() => playgroundArtifactPath(unsafe), /canonical session id/);
  }
});

test("turn context names only that session's artifact and does not arm a setup turn", () => {
  const context = playgroundTurnContext({ id: SESSION_A });

  assert.match(context, new RegExp(PATH_A.replaceAll(".", "\\.")));
  assert.doesNotMatch(context, new RegExp(PATH_B.replaceAll(".", "\\.")));
  assert.match(context, /exactly one live artifact file/);
  assert.match(context, /Do not spend a turn on setup/);
  assert.match(context, /create it, including its parent directory/);
  assert.match(context, /Read it before editing|read it before editing/);
  assert.match(context, /Never read credentials/);
  assert.match(context, /prefer suitable assets already in the project/);
  assert.match(context, /unless the user explicitly asks/);
  assert.match(context, /Do not read or write \.polyth\/playground\/index\.html/);
  assert.doesNotMatch(context, /initialization message/);
  assert.doesNotMatch(context, /Do not acknowledge/);
});

test("purpose registration follows enable and disable", () => {
  const services = createServerServiceRegistry();
  const purposes = new Map<string, (session: { id: string }) => string>();
  services.provide(SESSION_PURPOSES, {
    register(purpose, context) {
      if (purposes.has(purpose)) {
        throw Object.assign(new Error(`session purpose already registered: ${purpose}`), { code: "conflict" });
      }
      purposes.set(purpose, context);
      return {
        dispose() {
          if (purposes.get(purpose) === context) purposes.delete(purpose);
        },
      };
    },
  });
  const pkg = registerPackage({ services } as ServerPackageHost);
  assert.throws(() => registerPackage({ services: createServerServiceRegistry() } as ServerPackageHost).onEnable?.(), /not provided/);

  pkg.onEnable?.();
  pkg.onEnable?.();
  assert.equal(purposes.size, 1);
  const context = purposes.get(PLAYGROUND_PURPOSE);
  assert.equal(typeof context, "function");
  assert.match(context!({ id: SESSION_A } as never), new RegExp(PATH_A.replaceAll(".", "\\.")));
  assert.doesNotMatch(context!({ id: SESSION_B } as never), new RegExp(PATH_A.replaceAll(".", "\\.")));

  pkg.onDisable?.();
  assert.equal(purposes.has(PLAYGROUND_PURPOSE), false);
  pkg.onDisable?.();
  assert.equal(purposes.size, 0);
});

test("implementation handoff preserves source context and bounds the artifact snapshot", () => {
  const prompt = playgroundImplementationPrompt({
    sourceSessionId: SESSION_A,
    artifactHtml: "<main>```" + "x".repeat(PLAYGROUND_IMPLEMENTATION_SNAPSHOT_LIMIT + 100) + "</main>",
    selectedElement: { selector: "main > button.primary", tag: "button", text: " Save   changes " },
    worktreePath: "/tmp/playground-checkout",
  });

  assert.match(prompt, new RegExp(SESSION_A));
  assert.match(prompt, new RegExp(PATH_A.replaceAll(".", "\\.")));
  assert.doesNotMatch(prompt, new RegExp(PATH_B.replaceAll(".", "\\.")));
  assert.doesNotMatch(prompt, /\.polyth\/playground\/index\.html/);
  assert.match(prompt, /\/tmp\/playground-checkout/);
  assert.match(prompt, /main > button\.primary/);
  assert.match(prompt, /"Save changes"/);
  assert.match(prompt, /snapshot truncated/);
  assert.match(prompt, /untrusted project data/);
  assert.doesNotMatch(prompt, /<main>```/);
  assert.ok(prompt.length < PLAYGROUND_IMPLEMENTATION_SNAPSHOT_LIMIT + 1500);

  const unsafe = playgroundImplementationPrompt({ sourceSessionId: "../etc/passwd" });
  assert.match(unsafe, /Canonical artifact for that session only: \(unavailable\)/);
  assert.doesNotMatch(unsafe, /\.polyth\/playground\/index\.html/);
});

test("selection context is compact and points back to that session's artifact", () => {
  const prompt = playgroundSelectionPrompt({
    selector: "main > button.primary",
    tag: "button",
    text: "  Save   changes  ",
  }, SESSION_A);

  assert.match(prompt, new RegExp(PATH_A.replaceAll(".", "\\.")));
  assert.doesNotMatch(prompt, new RegExp(PATH_B.replaceAll(".", "\\.")));
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
