// The macOS 12 (Monterey) desktop build. Electron 44 requires macOS 13, so the
// regular macOS package cannot start on 12. This Intel-only package is the
// same app on Electron 43, the last Electron line that runs on Monterey; it
// leaves support on 2027-01-05, after which no patched Electron runs there.
//
// remote-build.mjs (target mac-dmg-legacy) packages it with the overrides
// below. Its update metadata is legacy-mac.yml, read only by this build
// (apps/desktop/src/updaterChannel.ts) and published on stable releases by
// update-feed.mjs. See docs/dev/desktop.md, "macOS 12 build".

/** Newest Electron 43 release; keep it on the 43 line, the last one for macOS 12. */
export const MAC_LEGACY_ELECTRON_VERSION = "43.8.4";
export const MAC_LEGACY_MINIMUM_SYSTEM_VERSION = "12.0";
/** Only Intel: Apple silicon Macs can all run macOS 13 or newer. */
export const MAC_LEGACY_ARCH = "x64";
/** The `POLYTH_DESKTOP_FLAVOR` build define the desktop main process keys on. */
export const MAC_LEGACY_FLAVOR = "mac-legacy";
/** electron-updater reads `<channel>-mac.yml`; the desktop build uses channel `legacy`. */
export const MAC_LEGACY_METADATA = "legacy-mac.yml";

/** electron-builder `--config.*` overrides that turn the macOS package into the macOS 12 one. */
export function macLegacyBuilderArgs() {
  return [
    `--config.electronVersion=${MAC_LEGACY_ELECTRON_VERSION}`,
    `--config.mac.minimumSystemVersion=${MAC_LEGACY_MINIMUM_SYSTEM_VERSION}`,
    // Distinct file names, so both packages share one release.
    "--config.mac.artifactName=${productName}-${version}-mac-legacy-${arch}.${ext}",
  ];
}
