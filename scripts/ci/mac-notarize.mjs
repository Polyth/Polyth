// electron-builder `afterSign` hook used by remote-build.mjs for Developer ID
// builds in place of the built-in `mac.notarize`. The built-in path staples
// through @electron/notarize, which gives up after ~7 s of retries; the Intel
// macOS runners repeatedly lose the connection to Apple's ticket CDN
// (api.apple-cloudkit.com, stapler error 68) for longer than that, failing a
// build Apple had already accepted. Here notarization itself stays mandatory,
// stapling is retried for several minutes, and a still-unreachable ticket CDN
// ships the notarized app unstapled (Gatekeeper fetches the ticket online).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const STAPLE_DELAYS_SECONDS = [15, 30, 60, 60, 120, 120];

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${command} ${args[0] ?? ""} failed: ${result.error.message}`);
  return result;
}

function credentials() {
  const appleId = process.env.APPLE_ID ?? "";
  const password = process.env.APPLE_APP_SPECIFIC_PASSWORD ?? "";
  const teamId = process.env.APPLE_TEAM_ID ?? "";
  if (!appleId || !password || !teamId) {
    throw new Error("Notarization needs APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID");
  }
  return ["--apple-id", appleId, "--password", password, "--team-id", teamId];
}

function notarize(appPath) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-notarize-"));
  try {
    const zip = join(dir, "Polyth.zip");
    if (run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zip]).status !== 0) {
      throw new Error(`Unable to zip ${appPath} for notarization`);
    }
    console.log(`[notarize] submitting ${appPath}`);
    const submit = run("xcrun", ["notarytool", "submit", zip, ...credentials(), "--wait", "--output-format", "json"], { capture: true });
    let outcome = {};
    try { outcome = JSON.parse(submit.stdout); } catch { /* reported below */ }
    console.log(`[notarize] id=${outcome.id ?? "unknown"} status=${outcome.status ?? "unknown"}`);
    if (submit.status !== 0 || outcome.status !== "Accepted") {
      if (outcome.id) run("xcrun", ["notarytool", "log", outcome.id, ...credentials()]);
      else if (submit.stdout) console.log(submit.stdout);
      throw new Error(`Apple notarization did not accept ${appPath}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function staple(appPath) {
  for (let attempt = 0; ; attempt += 1) {
    if (run("xcrun", ["stapler", "staple", appPath]).status === 0) {
      console.log(`[notarize] stapled ${appPath}`);
      return;
    }
    const delay = STAPLE_DELAYS_SECONDS[attempt];
    if (delay === undefined) break;
    console.log(`[notarize] staple attempt ${attempt + 1} failed; retrying in ${delay}s`);
    await sleep(delay * 1000);
  }
  console.log(`::warning::Notarized ${appPath} but could not staple its ticket; Gatekeeper will fetch it online.`);
}

export default async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  notarize(appPath);
  await staple(appPath);
}
