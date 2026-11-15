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
/** Poll delays for a submission Apple has not judged yet: about ten minutes in total. */
export const POLL_DELAYS_SECONDS = [15, 30, 60, 60, 60, 60, 120, 120, 120, 120, 120, 120];
/** A submit request that lost its connection is retried instead of failing the build. */
const SUBMIT_ATTEMPTS = 3;

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

async function notarize(appPath) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-notarize-"));
  try {
    const zip = join(dir, "Polyth.zip");
    if (run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zip]).status !== 0) {
      throw new Error(`Unable to zip ${appPath} for notarization`);
    }
    const id = await submit(appPath, zip);
    if (!id) throw new Error(`Apple notarization returned no submission id for ${appPath}`);
    const outcome = await awaitNotarization(id);
    if (outcome !== "Accepted") throw new Error(`Apple notarization did not accept ${appPath} (${outcome})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `notarytool submit --wait` holds one HTTP request open for the whole review;
 * the Intel macOS runners intermittently lose it (NSURLErrorDomain -1001) and a
 * build Apple would have accepted failed instead. Submit without `--wait` to get
 * the id, then poll it. A submit that loses its connection is retried, because
 * the id it would have returned is the only handle on the submission.
 */
async function submit(appPath, zip) {
  let stdout = "";
  for (let attempt = 1; attempt <= SUBMIT_ATTEMPTS; attempt += 1) {
    console.log(`[notarize] submitting ${appPath} (attempt ${attempt}/${SUBMIT_ATTEMPTS})`);
    const result = run("xcrun", ["notarytool", "submit", zip, ...credentials(), "--output-format", "json"], { capture: true });
    stdout = result.stdout ?? "";
    let outcome = {};
    try { outcome = JSON.parse(stdout); } catch { /* keep the raw output for the message */ }
    if (result.status === 0 && outcome.id) {
      console.log(`[notarize] id=${outcome.id} submitted`);
      return outcome.id;
    }
    if (outcome.status && outcome.status !== "In Progress") break;
    if (attempt < SUBMIT_ATTEMPTS) await sleep((POLL_DELAYS_SECONDS[attempt - 1] ?? 30) * 1000);
  }
  if (stdout) console.log(stdout);
  return null;
}

function dumpNotaryLog(id) {
  run("xcrun", ["notarytool", "log", id, ...credentials()]);
}

function notaryInfo(id) {
  const result = run("xcrun", ["notarytool", "info", id, ...credentials(), "--output-format", "json"], { capture: true });
  let outcome = {};
  try { outcome = JSON.parse(result.stdout ?? ""); } catch { /* an unreachable notary answers nothing */ }
  return { status: outcome.status ?? null };
}

/**
 * Waits for Apple's verdict. A poll that cannot reach the notary is retried, so
 * a transient network failure never turns into a rejection; only an explicit
 * `Invalid`/`Rejected` verdict or an exhausted budget fails the build.
 */
export async function awaitNotarization(id, { info = notaryInfo, dumpLog = dumpNotaryLog, delays = POLL_DELAYS_SECONDS, sleepFn = sleep, log = console.log } = {}) {
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const { status } = await info(id);
    log(`[notarize] id=${id} status=${status ?? "unknown"}`);
    if (status === "Accepted") return "Accepted";
    if (status === "Invalid" || status === "Rejected") {
      dumpLog(id);
      return status;
    }
    if (attempt < delays.length) await sleepFn(delays[attempt] * 1000);
  }
  return "Unknown";
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
  await notarize(appPath);
  await staple(appPath);
}
