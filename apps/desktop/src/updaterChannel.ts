import type { DesktopUpdateChannel } from "./types.ts";

export const DESKTOP_UPDATE_CHANNELS: readonly DesktopUpdateChannel[] = ["stable", "test", "nightly"];

export const resolveUpdaterChannel = (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined => platform === "win32" && arch === "arm64"
  ? "latest-arm64"
  : undefined;

/**
 * The release channel a build came from, read from its version: the external
 * builder publishes X.Y.N (stable), X.Y.N-beta (test) and X.Y.N-nightly
 * (scripts/ci/update-feed.mjs). It is the default until the user picks one.
 */
export const updateChannelForVersion = (version: string): DesktopUpdateChannel => {
  const id = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(version)?.[1];
  return id === "nightly" ? "nightly" : id === "beta" ? "test" : "stable";
};

/** Build flavor of the macOS 12 package: Electron 43, the last Electron that runs on Monterey. */
export const MAC_LEGACY_FLAVOR = "mac-legacy";
/** Its electron-updater channel: `legacy-mac.yml` on stable releases (scripts/ci/update-feed.mjs). */
export const MAC_LEGACY_UPDATER_CHANNEL = "legacy";

/**
 * The macOS 12 build follows its own feed while it runs on macOS 12 or older;
 * the regular macOS build needs 13, so it must never be offered there. Once
 * the Mac runs 13 or newer, the build follows the regular feed and its next
 * update replaces it with the regular build. An unreadable version stays on
 * the legacy feed.
 */
export const followsMacLegacyFeed = (
  flavor: string,
  platform: NodeJS.Platform,
  systemVersion: string,
): boolean => {
  if (flavor !== MAC_LEGACY_FLAVOR || platform !== "darwin") return false;
  const major = Number(/^(\d+)\./.exec(systemVersion)?.[1]);
  return !Number.isInteger(major) || major < 13;
};

export interface UpdaterChannelConfig {
  allowPrerelease: boolean;
  /** electron-updater channel; always a string because the updater cannot unset one. */
  channel: string;
}

/**
 * electron-updater's GitHub provider: stable reads /releases/latest, which
 * never returns a prerelease. With prereleases allowed, the `beta` channel
 * takes the newest beta or stable release and a custom `nightly` channel
 * takes only nightly releases.
 *
 * The macOS 12 feed is stable only, whatever the chosen channel: with
 * prereleases on, the provider reads the metadata named after the release's
 * prerelease id and falls back to `latest-mac.yml`, the regular build.
 */
export const resolveUpdaterConfig = (
  channel: DesktopUpdateChannel,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  macLegacy = false,
): UpdaterChannelConfig => {
  if (macLegacy) return { allowPrerelease: false, channel: MAC_LEGACY_UPDATER_CHANNEL };
  if (channel === "test") return { allowPrerelease: true, channel: "beta" };
  if (channel === "nightly") return { allowPrerelease: true, channel: "nightly" };
  return { allowPrerelease: false, channel: resolveUpdaterChannel(platform, arch) ?? "latest" };
};
