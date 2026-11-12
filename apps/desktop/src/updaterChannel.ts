import type { DesktopUpdateChannel } from "./types.ts";
import { WORKSTATION_FLAVOR, WORKSTATION_UPDATER_CHANNEL } from "./edition.ts";

export const DESKTOP_UPDATE_CHANNELS: readonly DesktopUpdateChannel[] = ["stable", "nightly"];

export const resolveUpdaterChannel = (
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined => platform === "win32" && arch === "arm64"
  ? "latest-arm64"
  : undefined;

/**
 * The release channel a build came from, read from its version: the external
 * builder publishes X.Y.N (stable) and X.Y.N-nightly
 * (scripts/ci/update-feed.mjs). It is the default until the user picks one.
 * Builds from the retired test channel (X.Y.N-beta) follow stable.
 */
export const updateChannelForVersion = (version: string): DesktopUpdateChannel => {
  const id = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(version)?.[1];
  return id === "nightly" ? "nightly" : "stable";
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

/**
 * The stable-only feed a build is pinned to, whatever channel the person
 * picked; null when the chosen channel applies. The workstation edition always
 * follows `workstation*.yml`, so it can never update into the standard build.
 */
export const pinnedUpdaterChannel = (
  flavor: string,
  platform: NodeJS.Platform,
  systemVersion: string,
): string | null => {
  if (flavor === WORKSTATION_FLAVOR) return WORKSTATION_UPDATER_CHANNEL;
  return followsMacLegacyFeed(flavor, platform, systemVersion) ? MAC_LEGACY_UPDATER_CHANNEL : null;
};

export interface UpdaterChannelConfig {
  allowPrerelease: boolean;
  /** electron-updater channel; always a string because the updater cannot unset one. */
  channel: string;
}

/**
 * electron-updater's GitHub provider: stable reads /releases/latest, which
 * never returns a prerelease. With prereleases allowed, a custom `nightly`
 * channel takes only nightly releases.
 *
 * A pinned feed (the macOS 12 build, the workstation edition) is stable only,
 * whatever the chosen channel: with prereleases on, the provider reads the
 * metadata named after the release's prerelease id and falls back to the
 * regular build's `latest*.yml`.
 */
export const resolveUpdaterConfig = (
  channel: DesktopUpdateChannel,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  pinnedChannel: string | null = null,
): UpdaterChannelConfig => {
  if (pinnedChannel) return { allowPrerelease: false, channel: pinnedChannel };
  if (channel === "nightly") return { allowPrerelease: true, channel: "nightly" };
  return { allowPrerelease: false, channel: resolveUpdaterChannel(platform, arch) ?? "latest" };
};
