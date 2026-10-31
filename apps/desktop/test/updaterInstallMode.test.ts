import assert from "node:assert/strict";
import test from "node:test";
import { releasePageUrl, resolveUpdateInstallMode } from "../src/updaterInstallMode.ts";

const ADHOC = "Executable=/Applications/Polyth.app/Contents/MacOS/Polyth\nIdentifier=com.polyth.desktop\nFormat=app bundle with Mach-O thin (arm64)\nSignature=adhoc\nTeamIdentifier=not set\n";
const DEVELOPER_ID = "Executable=/Applications/Polyth.app/Contents/MacOS/Polyth\nAuthority=Developer ID Application: Polyth\nTeamIdentifier=ABCDE12345\n";

test("ad-hoc signed macOS builds install updates by hand", () => {
  assert.equal(resolveUpdateInstallMode("darwin", ADHOC), "manual");
  assert.equal(resolveUpdateInstallMode("darwin", DEVELOPER_ID), "in-app");
  assert.equal(resolveUpdateInstallMode("darwin", null), "in-app");
  assert.equal(resolveUpdateInstallMode("win32", ADHOC), "in-app");
  assert.equal(resolveUpdateInstallMode("linux", ADHOC), "in-app");
});

test("the release page comes from the packaged GitHub feed", () => {
  const feed = "owner: example-org\nrepo: some-repo.name\nprovider: github\nreleaseType: release\nupdaterCacheDirName: polyth-updater\n";
  assert.equal(releasePageUrl(feed, "0.1.86"), "https://github.com/example-org/some-repo.name/releases/tag/v0.1.86");
  assert.equal(releasePageUrl(feed, "0.1.86\n"), null);
  assert.equal(releasePageUrl(feed, "../x"), null);
  assert.equal(releasePageUrl(feed.replace("github", "generic"), "0.1.86"), null);
  assert.equal(releasePageUrl("provider: github\nowner: a/b\nrepo: c\n", "0.1.86"), null);
});
