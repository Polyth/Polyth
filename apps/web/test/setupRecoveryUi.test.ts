import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Source-level guard for the first-run setup screen: only a name and a
// password are typed, the recovery material is actionable (copy/download) and
// sits before the acknowledgement and submit, and every field carries a
// visible label. Motion is asserted at the token level so the lock surfaces
// keep the shared cadence and the global reduced-motion / low-resource rules
// can disable it. Behavior is covered by setupScreen.test.ts.
const read = (relative: string): Promise<string> =>
  readFile(new URL(relative, import.meta.url), "utf8");

test("setup screen exposes copy and download for recovery codes", async () => {
  const [source] = await Promise.all([read("../src/components/SetupScreen.tsx")]);

  assert.match(source, /copyText/);
  assert.match(source, /copyRecoveryCodes/);
  assert.match(source, /downloadRecoveryCodes/);
  assert.match(source, /recoveryCodes\.join\("\\n"\)/);
  assert.match(source, /URL\.createObjectURL/);
  assert.match(source, /URL\.revokeObjectURL/);
  assert.match(source, /download = "polyth-recovery-codes\.txt"/);
  // Copy confirm is transient feedback, never a permanent status line.
  assert.match(source, /setCopied\(true\)/);
  assert.match(source, /setTimeout\(\(\) => setCopied\(false\)/);
});

test("the recovery step lists codes, then save actions, the acknowledgement and submit", async () => {
  const source = await read("../src/components/SetupScreen.tsx");

  const codes = source.indexOf('className="setup-codes"');
  const actions = source.indexOf('className="setup-codes-actions"');
  const acknowledgement = source.indexOf('className="lock-agree"');
  const submit = source.indexOf('tr("setup.recovery.create")');

  assert.ok(codes > 0, "recovery codes must be listed");
  assert.ok(actions > codes, "download/copy must follow the codes");
  assert.ok(acknowledgement > actions, "acknowledgement must follow the save actions");
  assert.ok(submit > acknowledgement, "submit action must follow the acknowledgement");
});

test("setup asks only for visibly labelled name and password fields", async () => {
  const source = await read("../src/components/SetupScreen.tsx");

  for (const id of ["setup-name", "setup-password", "setup-claim"]) {
    assert.match(source, new RegExp(`htmlFor="${id}"`));
    assert.match(source, new RegExp(`id="${id}"`));
  }
  // Organization defaults, the login is fixed and the password has a reveal
  // control instead of a confirmation field.
  for (const removed of ["setup-organization", "setup-confirm", "setup-login"]) {
    assert.doesNotMatch(source, new RegExp(removed));
  }
  assert.match(source, /const DEFAULT_ORGANIZATION = "Personal";/);
  assert.match(source, /organizationName: DEFAULT_ORGANIZATION,/);
  assert.match(source, /setup\.account\.showPassword/);
  assert.match(source, /lock-field-hint/);
});

test("setup does not ask for a login; the owner login is fixed", async () => {
  const source = await read("../src/components/SetupScreen.tsx");

  assert.doesNotMatch(source, /setup-login/);
  assert.match(source, /const OWNER_LOGIN = "owner";/);
  assert.match(source, /login: OWNER_LOGIN,/);
});

test("setup errors are translated sentences, not server codes", async () => {
  const source = await read("../src/components/SetupScreen.tsx");

  // The old screen printed `body.error` with dashes replaced ("invalid claim").
  assert.doesNotMatch(source, /replace\(\/-\/g, " "\)/);
  assert.match(source, /function problemFor\(/);
  assert.match(source, /setup\.error\.codeExpired/);
  assert.match(source, /setup\.error\.generic/);
});

test("the AppImage E2E waits for the setup form by its usage and name field selectors", async () => {
  const [source, e2e] = await Promise.all([
    read("../src/components/SetupScreen.tsx"),
    read("../../desktop/test/appimage-e2e.mjs"),
  ]);

  // The release build's Linux job drives first-run setup through these
  // selectors; a renamed field silently fails that build.
  assert.match(source, /id="setup-name"/);
  assert.match(source, /name="setup-usage"/);
  assert.match(e2e, /querySelector\("input#setup-name"\)/);
  assert.match(e2e, /querySelector\("input\[name=setup-usage\]"\)/);
  assert.match(e2e, /desktop\.completeLocalSetup\(\)/);
});

test("the AppImage E2E waits for the app shell, which every window layout renders", async () => {
  const [app, e2e] = await Promise.all([
    read("../src/App.tsx"),
    read("../../desktop/test/appimage-e2e.mjs"),
  ]);

  // The bare layout has no top bar until a chat is open, so a fresh first run
  // never shows `.header`.
  assert.match(app, /className="app-shell"/);
  assert.match(e2e, /querySelector\("\.app-shell"\)/);
  assert.doesNotMatch(e2e, /querySelector\("\.header"\)/);
});

test("setup and lock surfaces animate on the shared motion tokens", async () => {
  const css = await read("../src/styles.css");

  assert.match(css, /\.lock-card\s*\{[^}]*animation:\s*lock-card-in\s+var\(--motion-surface\)\s+var\(--motion-ease\)/s);
  assert.match(css, /@keyframes lock-card-in/);
  assert.match(css, /\.lock-fields > \.lock-field\s*\{[^}]*animation:\s*lock-field-in\s+var\(--motion-normal\)\s+var\(--motion-ease\)/s);
  assert.match(css, /\.setup-step\s*\{[^}]*animation:\s*lock-field-in\s+var\(--motion-normal\)\s+var\(--motion-ease\)/s);
  assert.match(css, /\.setup-codes > li\s*\{[^}]*animation:\s*lock-code-in\s+var\(--motion-normal\)\s+var\(--motion-ease\)/s);
  assert.match(css, /@keyframes lock-code-in/);
  assert.match(css, /@keyframes lock-copy-pop/);
  assert.match(css, /\.lock-agree:has\(input:checked\)/);
});
