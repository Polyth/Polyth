import assert from "node:assert/strict";
import test from "node:test";
import {
  followsMacLegacyFeed, MAC_LEGACY_FLAVOR, resolveUpdaterChannel, resolveUpdaterConfig, updateChannelForVersion,
} from "../src/updaterChannel.ts";

test("Windows arm64 uses its architecture-specific update channel", () => {
  assert.equal(resolveUpdaterChannel("win32", "arm64"), "latest-arm64");
  assert.equal(resolveUpdaterChannel("win32", "x64"), undefined);
  assert.equal(resolveUpdaterChannel("linux", "arm64"), undefined);
  assert.equal(resolveUpdaterChannel("darwin", "arm64"), undefined);
});

test("a build's version names the release channel it came from", () => {
  assert.equal(updateChannelForVersion("0.1.140"), "stable");
  assert.equal(updateChannelForVersion("0.1.141-beta"), "test");
  assert.equal(updateChannelForVersion("0.1.142-nightly"), "nightly");
  assert.equal(updateChannelForVersion("0.1.0"), "stable");
  assert.equal(updateChannelForVersion("1.2.3-rc.1"), "stable");
});

test("each channel maps to electron-updater's GitHub prerelease rules", () => {
  assert.deepEqual(resolveUpdaterConfig("stable", "linux", "x64"), { allowPrerelease: false, channel: "latest" });
  assert.deepEqual(resolveUpdaterConfig("stable", "win32", "arm64"), { allowPrerelease: false, channel: "latest-arm64" });
  assert.deepEqual(resolveUpdaterConfig("test", "darwin", "arm64"), { allowPrerelease: true, channel: "beta" });
  assert.deepEqual(resolveUpdaterConfig("nightly", "darwin", "arm64"), { allowPrerelease: true, channel: "nightly" });
});

test("the macOS 12 build follows its own feed only while the Mac runs macOS 12 or older", () => {
  assert.equal(followsMacLegacyFeed(MAC_LEGACY_FLAVOR, "darwin", "12.7.6"), true);
  assert.equal(followsMacLegacyFeed(MAC_LEGACY_FLAVOR, "darwin", "11.7.10"), true);
  // From 13 on it takes the regular feed, so its next update is the regular build.
  assert.equal(followsMacLegacyFeed(MAC_LEGACY_FLAVOR, "darwin", "13.0.0"), false);
  assert.equal(followsMacLegacyFeed(MAC_LEGACY_FLAVOR, "darwin", "26.1"), false);
  // An unreadable version must never reach the regular build's metadata.
  assert.equal(followsMacLegacyFeed(MAC_LEGACY_FLAVOR, "darwin", ""), true);
  assert.equal(followsMacLegacyFeed("", "darwin", "12.7.6"), false);
  assert.equal(followsMacLegacyFeed(MAC_LEGACY_FLAVOR, "linux", "12.7.6"), false);
});

test("the macOS 12 feed is stable-only legacy-mac.yml on every channel", () => {
  for (const channel of ["stable", "test", "nightly"] as const) {
    assert.deepEqual(resolveUpdaterConfig(channel, "darwin", "x64", true), { allowPrerelease: false, channel: "legacy" });
  }
  assert.deepEqual(resolveUpdaterConfig("nightly", "darwin", "x64", false), { allowPrerelease: true, channel: "nightly" });
});
