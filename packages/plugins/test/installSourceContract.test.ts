import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REPOSITORY_REF,
  describeInstallSource,
  isRepositorySource,
  isSupportedInstallSource,
} from "../src/installSourceContract.ts";

test("archive URLs and local sources keep their existing meaning", () => {
  assert.equal(isSupportedInstallSource("https://example.com/pkg.zip"), true);
  assert.equal(isSupportedInstallSource("zip:https://example.com/pkg.zip"), true);
  assert.equal(isSupportedInstallSource("file:demo"), true);
  assert.equal(isSupportedInstallSource("app.zip"), true);
  assert.equal(isSupportedInstallSource("npm:@scope/name"), false);
  assert.equal(isSupportedInstallSource("git:https://example.com/repo.git"), false);
  assert.equal(isSupportedInstallSource("git+https://example.com/repo.git"), false);
  assert.equal(isSupportedInstallSource("path:/tmp/pkg"), false);
  assert.equal(isSupportedInstallSource("path:/tmp/pkg", true), true);
  assert.deepEqual(describeInstallSource("zip:https://example.com/pkg.zip"), {
    kind: "archive-url",
    label: "example.com",
    archiveUrl: "https://example.com/pkg.zip",
  });
  // An https URL with credentials is never a supported source.
  assert.equal(isSupportedInstallSource("https://user:pass@example.com/pkg.zip"), false);
  assert.equal(isSupportedInstallSource("http://example.com/pkg.zip"), false);
});

test("public forge repositories resolve to a downloadable archive", () => {
  const cases: Array<[string, string, string]> = [
    ["https://github.com/acme/tools", "HEAD", "https://codeload.github.com/acme/tools/zip/HEAD"],
    ["https://github.com/acme/tools.git", "HEAD", "https://codeload.github.com/acme/tools/zip/HEAD"],
    ["https://github.com/acme/tools/tree/main", "main", "https://codeload.github.com/acme/tools/zip/main"],
    ["https://github.com/acme/tools/tree/feature/private", "feature/private", "https://codeload.github.com/acme/tools/zip/feature%2Fprivate"],
    ["https://github.com/acme/tools/tree/feature%2Fprivate", "feature/private", "https://codeload.github.com/acme/tools/zip/feature%2Fprivate"],
    ["https://github.com/acme/tools/releases/tag/v1.2.0", "v1.2.0", "https://codeload.github.com/acme/tools/zip/v1.2.0"],
    ["https://gitlab.com/acme/tools", "HEAD", "https://gitlab.com/acme/tools/-/archive/HEAD/tools-HEAD.zip"],
    ["https://gitlab.com/group/sub/tools/-/tree/v2", "v2", "https://gitlab.com/group/sub/tools/-/archive/v2/tools-v2.zip"],
    ["https://codeberg.org/acme/tools", "HEAD", "https://codeberg.org/acme/tools/archive/HEAD.zip"],
    ["https://codeberg.org/acme/tools/src/branch/dev", "dev", "https://codeberg.org/acme/tools/archive/dev.zip"],
  ];
  for (const [source, ref, archiveUrl] of cases) {
    const described = describeInstallSource(source);
    assert.equal(described.kind, "repository", source);
    assert.equal(described.archiveUrl, archiveUrl, source);
    assert.equal(isRepositorySource(source), true, source);
    assert.equal(isSupportedInstallSource(source), true, source);
    assert.ok(described.repository?.endsWith(`@${ref}`), source);
    assert.equal(described.repositoryRef, ref, source);
    assert.ok(described.repositoryHost, source);
    assert.ok(described.repositoryPath, source);
  }
  const github = describeInstallSource("https://github.com/acme/tools");
  assert.equal(github.repositoryHost, "github.com");
  assert.equal(github.repositoryPath, "acme/tools");
  assert.equal(github.repositoryRef, "HEAD");
  assert.equal(DEFAULT_REPOSITORY_REF, "HEAD");
});

test("repository-like inputs the host cannot resolve stay rejected", () => {
  for (const source of [
    "https://github.com/acme",
    "https://github.com/acme/tools/tree/",
    "https://gitlab.com/tools",
    "https://example.com/acme/tools",
  ]) {
    assert.equal(isRepositorySource(source), false, source);
  }
  // A non-forge https URL is still a plain archive candidate (the server
  // reports a clear extraction error), never a repository download.
  assert.equal(describeInstallSource("https://example.com/acme/tools").kind, "archive-url");
  assert.equal(describeInstallSource("https://gist.github.com/acme/abc123").kind, "archive-url");
  assert.equal(describeInstallSource("").kind, "invalid");
  assert.equal(describeInstallSource("   ").kind, "invalid");
});
