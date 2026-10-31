import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const runtimeSource = readFileSync(
  new URL("../src/packages/sandbox/runtime.ts", import.meta.url),
  "utf8",
);
const contributionSource = readFileSync(
  new URL("../src/packages/sandbox/Contribution.tsx", import.meta.url),
  "utf8",
);

test("credential prompts and external tabs require one recent host-observed user action", () => {
  assert.match(runtimeSource, /const USER_INTENT_WINDOW_MS = 10_000/);
  assert.match(runtimeSource, /function requireRecentUserIntent[\s\S]*runtime\.lastUserIntentAt = 0/);
  assert.match(
    runtimeSource,
    /method: "ui\.openExternalUrl"[\s\S]*?requireRecentUserIntent\(runtime, "Opening an external URL"\)/,
  );
  assert.match(
    runtimeSource,
    /method: "auth\.connect"[\s\S]*?requireRecentUserIntent\(runtime, "Connecting an extension account"\)/,
  );
  assert.match(runtimeSource, /sendAction\(action\)[\s\S]*runtime\.lastUserIntentAt = Date\.now\(\)/);
  assert.match(runtimeSource, /if \(userDrivenContribution\(request\.kind\)\) runtime\.lastUserIntentAt = Date\.now\(\)/);
});

test("static status badges render without acquiring sandbox runtime", () => {
  const badgeBranch = contributionSource.indexOf('if (descriptor.kind === "status-badge")');
  const toolBranch = contributionSource.indexOf('if (descriptor.kind === "tool-renderer")', badgeBranch);
  assert.ok(badgeBranch >= 0, "status-badge branch must exist");
  assert.ok(toolBranch > badgeBranch, "static badge branch must run before runtime-backed contributions");
  const branch = contributionSource.slice(badgeBranch, toolBranch);
  assert.match(branch, /return <Badge tone="neutral">\{descriptor\.label\}<\/Badge>/);
  assert.doesNotMatch(branch, /InlineContribution|acquireSandboxRuntime|invokeContribution/);
});

test("passive inline contributions do not auto-apply structured context", () => {
  assert.match(
    contributionSource,
    /function InlineContribution[\s\S]*applyStructuredResult = false/,
  );
  assert.match(
    contributionSource,
    /\["settings-section", "widget", "surface"\][\s\S]*<InlineContribution plugin=\{plugin\} descriptor=\{descriptor\} hostProps=\{hostProps\} \/>/,
  );
  assert.match(
    contributionSource,
    /presentation === "picker"[\s\S]*<InlineContribution plugin=\{plugin\} descriptor=\{descriptor\} hostProps=\{hostProps\} applyStructuredResult \/>/,
  );
});
