export type UpdateInstallMode = "in-app" | "manual";

/**
 * Squirrel.Mac installs an update only when its signature satisfies the
 * running app's designated requirement. An ad-hoc signature (the external
 * builder's macOS output) is pinned to its own cdhash, so no later build can
 * satisfy it: such apps learn about updates but install them by hand.
 * `codesignDetails` is `codesign -dv` output (stderr); null when unavailable.
 */
export const resolveUpdateInstallMode = (
  platform: NodeJS.Platform,
  codesignDetails: string | null,
): UpdateInstallMode => platform === "darwin" && codesignDetails !== null && /^Signature=adhoc\s*$/m.test(codesignDetails)
  ? "manual"
  : "in-app";

/** GitHub release page for `version` from the packaged app-update.yml feed. */
export const releasePageUrl = (appUpdateYml: string, version: string): string | null => {
  const field = (key: string) => new RegExp(`^${key}:\\s*['"]?([^'"\\s]+)['"]?\\s*$`, "m").exec(appUpdateYml)?.[1];
  const owner = field("owner");
  const repo = field("repo");
  if (field("provider") !== "github" || !owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  return `https://github.com/${owner}/${repo}/releases/tag/v${version}`;
};
