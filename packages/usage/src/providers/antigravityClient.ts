// Antigravity's client identity, in one place.
//
// Google gates the Gemini group of `retrieveUserQuotaSummary` by the client
// version advertised in the User-Agent: an outdated one answers 200 with the
// third-party group alone, so the Gemini rows disappear from the usage pane
// with no error anywhere. Keep this version at the one Antigravity's own
// updater offers — read the `version:` line of
// https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml
// (verified 2026-10-19: 2.24.0).
export const ANTIGRAVITY_CLIENT_VERSION = "2.24.0";

const OS_NAMES: Record<string, string> = { win32: "windows", darwin: "darwin", linux: "linux" };

/** Antigravity names the platform in Go's `os/arch` form. A pair this client
 *  does not know keeps the windows/amd64 identity the provider always sent. */
export const antigravityUserAgent = (platform: string, arch: string): string => {
  const os = OS_NAMES[platform];
  if (!os) return `antigravity/${ANTIGRAVITY_CLIENT_VERSION} windows/amd64`;
  return `antigravity/${ANTIGRAVITY_CLIENT_VERSION} ${os}/${arch === "arm64" ? "arm64" : "amd64"}`;
};

/** The vendor-versioned half of the request headers; callers add their own
 *  Authorization/bearer. */
export const antigravityClientHeaders = (
  runtime: { platform: string; arch: string },
): Record<string, string> => ({
  "User-Agent": antigravityUserAgent(runtime.platform, runtime.arch),
  "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "Client-Metadata": "{\"ideType\":\"IDE_UNSPECIFIED\",\"platform\":\"PLATFORM_UNSPECIFIED\",\"pluginType\":\"GEMINI\"}",
});

let warnedMissingGeminiGroup = false;

/** A summary that carries groups but none for Gemini is what an outdated client
 *  version gets back. Warn once per process so the log names the constant above
 *  instead of the rows disappearing silently. */
export const warnIfGeminiGroupMissing = (
  groups: readonly unknown[],
  sawGoogleGroup: boolean,
  warn: (message: string) => void = (message) => console.warn(message),
): void => {
  if (warnedMissingGeminiGroup || sawGoogleGroup || groups.length === 0) return;
  warnedMissingGeminiGroup = true;
  warn(
    "Antigravity quota: Google returned no Gemini quota group, so the Gemini rows are missing. "
      + `If Antigravity itself shows Gemini limits, ANTIGRAVITY_CLIENT_VERSION (${ANTIGRAVITY_CLIENT_VERSION}) `
      + "in packages/usage/src/providers/antigravityClient.ts is probably out of date.",
  );
};
