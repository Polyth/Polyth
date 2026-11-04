import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(path, "utf8");

test("repository quality contract covers stable and Polyth Link tests", () => {
  const script = read("scripts/ci/release-quality.mjs");
  assert.match(script, /QUALITY_TEST_FILES/);
  assert.match(script, /release-version\.test\.ts/);
  assert.match(script, /releaseQuality\.test\.ts/);
  assert.match(script, /release-quality-gates\.test\.ts/);
  assert.match(script, /apps\/desktop\/test\/configuration\.test\.ts/);
  assert.match(script, /packages\/server\/test\/canonicalAuth\.test\.ts/);
  assert.match(script, /packages\/server\/test\/runtimeSecurityBinding\.test\.ts/);
  assert.match(script, /packages\/server\/test\/debugAgentAccess\.test\.ts/);
  assert.match(script, /scripts\/test\/agentBeta\.test\.ts/);
  assert.match(script, /packages\/harness-runtime\/test\/agentBeta\.test\.ts/);
  assert.match(script, /packages\/backend-opencode\/test\/delegation\.test\.ts/);
  assert.match(script, /packages\/backend-commandcode\/test\/capabilities\.test\.ts/);
  assert.match(script, /packages\/server\/test\/routeRegistry\.test\.ts/);
  assert.match(script, /packages\/files\/test\/agentBeta\.test\.ts/);
  assert.match(script, /packages\/git\/test\/agentBeta\.test\.ts/);
  assert.match(script, /packages\/terminal\/test\/agentBeta\.test\.ts/);
  for (const project of [
    "packages/contracts",
    "packages/plugins",
    "packages/server",
    "packages/control-plane",
    "packages/identity",
    "packages/tenancy",
    "packages/secure-safe",
    "packages/pairing-qr",
    "packages/tunnel",
    "packages/terminal",
    "packages/markets",
    "packages/web-search",
    "apps/mobile",
  ]) {
    assert.ok(script.includes(`"${project}"`), `release gate must typecheck ${project}`);
  }
});

test("CI is automatic on devel and master while build and release workflows stay manual", () => {
  const ci = read(".github/workflows/ci.yml");
  // Pushes and pull requests to both long-lived branches run CI; the full
  // suite runs automatically only once the repository is public, and a
  // repository variable can stop everything before a runner starts.
  assert.match(ci, /push:\n\s+branches:\n\s+- devel\n\s+- master/);
  assert.match(ci, /pull_request:\n\s+branches:\n\s+- devel\n\s+- master/);
  assert.match(ci, /github\.event\.repository\.private == false/);
  assert.match(ci, /vars\.CI_DISABLED != '1'/);
  assert.match(ci, /node scripts\/ci\/release-quality\.mjs/);

  const builds = read(".github/workflows/build-apps.yml");
  assert.match(builds, /workflow_dispatch:/);
  assert.doesNotMatch(builds, /^\s*push:/m);
  assert.match(builds, /java-version: "21"/);
  assert.match(builds, /:app:assembleDebug/);
  assert.match(builds, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(builds, /--win nsis --\$\{\{ matrix\.arch \}\} --publish never/);
  assert.match(builds, /--linux AppImage --\$\{\{ matrix\.arch \}\} --publish never/);
  assert.doesNotMatch(builds, /--publish always/);
  assert.match(builds, /macos_x64:/);
  assert.match(builds, /macos_arm64:/);
  assert.match(builds, /--mac dmg --\$\{\{ matrix\.arch \}\} --publish never/);
  assert.match(builds, /polyth-macos-dmg-x64/);
  assert.match(builds, /polyth-macos-dmg-arm64/);
  assert.match(builds, /SIGN_CSC_LINK: \$\{\{ secrets\.CSC_LINK \}\}/);
  assert.doesNotMatch(builds, /\n    env:\n      CSC_LINK: \$\{\{ secrets\.CSC_LINK \}\}/);
  assert.doesNotMatch(builds, /CSC_LINK= \\/);
  assert.match(builds, /must be unset for an ad-hoc macOS build/);
  assert.match(builds, /--config\.mac\.identity=-/);
  assert.match(builds, /--config\.mac\.notarize=false/);
  assert.doesNotMatch(builds, /(?:^|\s)-c\.mac\.(?:identity|notarize)=/m);
  assert.match(builds, /npm_packages:/);
  assert.match(builds, /type: boolean/);
  assert.doesNotMatch(builds, /inputs\.target/);

  const release = read(".github/workflows/release.yml");
  assert.match(release, /workflow_dispatch:/);
  assert.doesNotMatch(release, /^\s*push:/m);
  assert.match(release, /Require master/);
  assert.match(release, /Prepare draft GitHub Release/);
  assert.match(release, /gh release create/);
  assert.match(release, /--draft/);
  // The bump rewrites workspace pins too; the release commit must include every
  // manifest it reports, or `npm ci` resolves the old pin from the registry.
  assert.match(release, /BUMP_FILES: \$\{\{ steps\.bump\.outputs\.files \}\}/);
  assert.match(release, /git add -- package-lock\.json "\$\{files\[@\]\}"/);
  assert.match(release, /--mac dmg zip --x64 --arm64 --publish always/);
  assert.match(release, /Require macOS signing and notarization/);
  assert.doesNotMatch(release, /--config\.mac\.identity=-/);
  assert.doesNotMatch(release, /--config\.mac\.notarize=false/);
  assert.doesNotMatch(release, /--universal/);
  assert.match(release, /Missing macOS \$ARCH DMG/);
  assert.match(release, /Missing macOS \$ARCH ZIP/);
  assert.match(release, /--publish always/);
  assert.match(release, /gh release edit .*--draft=false/);
  assert.match(release, /latest\.yml latest-arm64\.yml latest-mac\.yml latest-linux\.yml/);
  assert.match(release, /npm publish/);
  assert.match(release, /upload-google-play/);

  const appGradle = read("apps/mobile/android/app/build.gradle");
  const capacitorGradle = read("apps/mobile/android/app/capacitor.build.gradle");
  assert.match(appGradle, /sourceCompatibility JavaVersion\.VERSION_21/);
  assert.match(appGradle, /targetCompatibility JavaVersion\.VERSION_21/);
  assert.match(capacitorGradle, /sourceCompatibility JavaVersion\.VERSION_21/);
  assert.match(capacitorGradle, /targetCompatibility JavaVersion\.VERSION_21/);
});

test("nightlies build devel behind the release gate and promotions verify master before pushing", () => {
  const nightly = read(".github/workflows/nightly.yml");
  assert.doesNotMatch(nightly, /^\s*push:/m);
  // The schedule is plain UTC: with `timezone: Europe/Kyiv` no slot ever fired.
  assert.match(nightly, /^ {4}- cron: '17 3 \* \* \*'$/m);
  assert.doesNotMatch(nightly, /^\s*timezone:/m);
  // Automatic runs stay off until the repository opts in; manual runs always work.
  assert.match(nightly, /vars\.POLYTH_NIGHTLY == '1'/);
  assert.match(nightly, /\|\| 'devel' \}\}/);
  // Automatic runs are nightlies; only a manual run picks test or stable.
  assert.match(nightly, /POLYTH_RELEASE_CHANNEL: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.channel \|\| 'nightly' \}\}/);
  assert.match(nightly, /needs: \[plan, verify\]/);
  assert.match(nightly, /node scripts\/ci\/release-quality\.mjs/);
  // A version must match its channel; only stable is marked Latest, and stable releases are never pruned.
  assert.match(nightly, /Refusing to publish \$VERSION as a \$POLYTH_RELEASE_CHANNEL release/);
  assert.match(nightly, /stable:false:\*\) kind=\(\); latest=true ;;/);
  assert.match(nightly, /if: env\.POLYTH_RELEASE_CHANNEL != 'stable'/);
  assert.match(nightly, /test\("\^v\[0-9\]\+\\\\\.\[0-9\]\+\\\\\.\[0-9\]\+'"\$suffix"'\$"\)/);

  const promote = read(".github/workflows/promote.yml");
  assert.match(promote, /workflow_dispatch:/);
  // Trigger keys sit two spaces under `on:`; the `push` input is deeper.
  assert.doesNotMatch(promote, /^ {2}(push|schedule|pull_request|repository_dispatch):/m);
  const drift = promote.indexOf("promote-master.mjs check-drift");
  const apply = promote.indexOf("promote-master.mjs apply");
  const verify = promote.indexOf("node scripts/ci/release-quality.mjs");
  const push = promote.indexOf('git push origin "$COMMIT:refs/heads/master"');
  assert.ok(drift >= 0 && apply > drift, "master drift is refused before the tree is rebuilt");
  assert.ok(verify > apply && push > verify, "the promoted tree is verified before master moves");
  assert.match(promote, /Promoted-from: %s/);
  assert.match(promote, /git commit-tree "\$tree" -p "\$MASTER" -p "\$DEVEL"/);

  // A release bump lands on master; devel must carry it or the next promotion drops it.
  const release = read(".github/workflows/release.yml");
  assert.match(release, /Forward the version bump to devel/);
});

test("signed iOS pins Xcode and proves the signature before uploading", () => {
  // The signed iOS path lives in the external builder now, not Codemagic. The
  // nightly uploads to TestFlight unattended, so what is load-bearing here is
  // that the toolchain is pinned and that the archive's signature is actually
  // checked before anything leaves the runner.
  const remote = read("scripts/ci/remote-build.mjs");
  const xcode = remote.indexOf("requireXcodeVersion()");
  const ipa = remote.indexOf("build-ipa");
  const verify = remote.indexOf("Authority=Apple Distribution:");
  const publish = remote.indexOf('"publish", "--path"');

  assert.ok(xcode >= 0, "a pinned Xcode check is required for signed iOS builds");
  assert.ok(ipa >= 0 && verify >= 0 && publish >= 0, "sign, verify and upload must all exist");
  assert.ok(xcode < ipa, "the Xcode pin must be asserted before building the archive");
  assert.ok(ipa < verify, "the archive must exist before its signature is checked");
  assert.ok(verify < publish, "an unverified archive must never reach TestFlight");
  assert.match(remote, /node:child_process/);
  // An explicit version, never a floating "newest Xcode on the runner".
  assert.match(remote, /POLYTH_IOS_XCODE_VERSION \?\? "27\.1"/);
});
