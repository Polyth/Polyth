import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The GitHub provider is one implementation of the Git package's
// provider-identity slot; this checks the package-owned half of that contract
// without the Git host test reaching into this package.
test("GitHub identity explains a disconnected provider from the shared slot context", () => {
  const github = readFileSync(new URL("../widgets/GithubIntegration.tsx", import.meta.url), "utf8");
  const provider = github.slice(
    github.indexOf("export function GithubIdentity"),
    github.indexOf("function GithubChangeRequestState"),
  );
  assert.match(provider, /if \(!context.user\)[\s\S]*?tr\("gitview.providerNotConnected"\)[\s\S]*?tr\("gitview.providerSignIn"\)/);
});
