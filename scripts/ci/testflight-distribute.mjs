#!/usr/bin/env node
// Makes an uploaded iOS build available to every TestFlight tester: waits for
// App Store Connect to finish processing it, submits it for external beta
// review and adds it to every beta group that does not already receive every
// build. `remote-build.mjs` runs this after the upload for manual `test` and
// `stable` builder runs only (the nightly stays internal so Apple does not
// review a build every night), and on its own for the builder's distribute-only
// `testflight` target, which takes the newest upload. Uses the App Store Connect API directly
// (ES256 JWT from node:crypto) because codemagic-cli-tools only takes group
// names and cannot list them.
import { createPrivateKey, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.appstoreconnect.apple.com";
const DEFAULT_LOCALE = "en-US";

/** Manual test/stable builder runs go to external testers; nightly does not. */
export function externalTestFlightRequested(env) {
  const override = (env.POLYTH_IOS_TESTFLIGHT_EXTERNAL ?? "").trim().toLowerCase();
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  return ["test", "stable"].includes((env.POLYTH_RELEASE_CHANNEL ?? "").trim());
}

export function appStoreConnectToken({ issuerId, keyId, privateKey }, now = Date.now()) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const iat = Math.floor(now / 1000);
  // Apple rejects tokens that live longer than 20 minutes.
  const input = `${encode({ alg: "ES256", kid: keyId, typ: "JWT" })}.${encode({
    iss: issuerId, iat, exp: iat + 19 * 60, aud: "appstoreconnect-v1",
  })}`;
  // CI secrets sometimes arrive with literal "\n" instead of newlines.
  const key = createPrivateKey(privateKey.includes("\\n") ? privateKey.replace(/\\n/g, "\n") : privateKey);
  const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${signature.toString("base64url")}`;
}

export function createApi(credentials, fetchImpl = fetch) {
  return async function api(method, path, body) {
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${appStoreConnectToken(credentials)}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (!response.ok) {
      const detail = json?.errors?.map((error) => `${error.code}: ${error.detail ?? error.title}`).join("; ")
        ?? text.slice(0, 500);
      const error = new Error(`${method} ${path} -> ${response.status} ${detail}`);
      error.codes = json?.errors?.map((entry) => entry.code) ?? [];
      throw error;
    }
    return json;
  };
}

/**
 * Internal groups with access to all builds receive the build automatically;
 * every other internal group, and every external group when requested, gets
 * it added explicitly.
 */
export function planDistribution(groups, { external }) {
  const automatic = [];
  const add = [];
  const skipped = [];
  for (const group of groups) {
    const { isInternalGroup, hasAccessToAllBuilds } = group.attributes ?? {};
    if (isInternalGroup && hasAccessToAllBuilds) automatic.push(group);
    else if (isInternalGroup || external) add.push(group);
    else skipped.push(group);
  }
  return { automatic, add, skipped, external: external && add.some((group) => !group.attributes?.isInternalGroup) };
}

const groupNames = (groups) => groups.map((group) => `"${group.attributes?.name ?? group.id}"`).join(", ") || "none";

const BUILD_FIELDS = "fields[builds]=version,processingState,usesNonExemptEncryption,expired";
const IN_REVIEW = "ANOTHER_BUILD_IN_REVIEW";

/**
 * Apple reviews one build per train at a time. With `supersede`, older builds
 * still waiting for (or in) beta review are expired so the new one can go;
 * otherwise the submission is retried until `reviewWaitMs` runs out.
 */
async function submitForBetaReview({ api, appId, build, supersede, reviewWaitMs, pollMs, sleep, now, log }) {
  const number = build.attributes.version;
  const deadline = now() + reviewWaitMs;
  for (let superseded = false; ;) {
    try {
      const created = await api("POST", "/v1/betaAppReviewSubmissions", {
        data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: build.id } } } },
      });
      log(`testflight: submitted build ${number} for external beta review (${created?.data?.attributes?.betaReviewState ?? "submitted"})`);
      return;
    } catch (error) {
      if (!error.codes?.some((code) => code.includes(IN_REVIEW))) throw error;
      const blockers = ((await api("GET", `/v1/builds?filter[app]=${appId}`
        + `&filter[betaAppReviewSubmission.betaReviewState]=WAITING_FOR_REVIEW,IN_REVIEW&${BUILD_FIELDS}&limit=20`)
        .catch(() => null))?.data ?? []).filter((entry) => entry.id !== build.id);
      const names = blockers.map((entry) => entry.attributes?.version ?? entry.id).join(", ") || "unknown";
      const older = blockers.length > 0 && blockers.every((entry) => Number(entry.attributes?.version) < Number(number));
      if (supersede && older && !superseded) {
        for (const blocker of blockers) {
          await api("PATCH", `/v1/builds/${blocker.id}`, { data: { type: "builds", id: blocker.id, attributes: { expired: true } } });
          log(`testflight: expired older build ${blocker.attributes?.version} that was waiting for beta review`);
        }
        superseded = true;
        continue;
      }
      if (now() >= deadline) {
        fail(`build ${number} cannot be submitted for external beta review yet: build(s) ${names} of the same version are already in review. `
          + "Re-run the testflight target once that review completes, or set POLYTH_IOS_TESTFLIGHT_SUPERSEDE=1 to expire the older build.");
      }
      log(`testflight: build(s) ${names} already in beta review; retrying build ${number} later`);
      await sleep(pollMs);
    }
  }
}

export async function distributeTestFlightBuild({
  api, appId, buildNumber, marketingVersion = null, whatsNew, external = true, locale = DEFAULT_LOCALE,
  maxWaitMs = 45 * 60_000, pollMs = 30_000, reviewWaitMs = 0, supersede = false,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  now = Date.now, log = console.log,
}) {
  if (!buildNumber) {
    // Distribute-only runs take the newest upload.
    const latest = (await api("GET", `/v1/builds?filter[app]=${appId}&sort=-uploadedDate&${BUILD_FIELDS}&limit=1`))?.data?.[0];
    if (!latest) fail("the app has no TestFlight builds");
    buildNumber = latest.attributes.version;
    log(`testflight: newest build is ${buildNumber}`);
  }
  // A build number is unique only within a marketing version: concurrent channel runs can upload
  // the same number for two versions, so pin the version this run built when it is known.
  const versionFilter = marketingVersion
    ? `&filter[preReleaseVersion.version]=${encodeURIComponent(marketingVersion)}` : "";
  const deadline = now() + maxWaitMs;
  let build = null;
  for (;;) {
    const found = await api("GET", `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(buildNumber)}`
      + `${versionFilter}&${BUILD_FIELDS}&limit=1`);
    build = found?.data?.[0] ?? null;
    const state = build?.attributes?.processingState;
    if (state === "VALID") break;
    if (state === "FAILED" || state === "INVALID") fail(`TestFlight build ${buildNumber} processing ended ${state}`);
    if (now() >= deadline) {
      fail(`TestFlight build ${buildNumber} was not processed within ${Math.round(maxWaitMs / 60_000)} min (state ${state ?? "not found"})`);
    }
    log(`testflight: build ${buildNumber} ${state ? `is ${state}` : "is not visible yet"}; waiting`);
    await sleep(pollMs);
  }
  if (build.attributes.expired) fail(`TestFlight build ${buildNumber} is expired`);
  if (build.attributes.usesNonExemptEncryption == null) {
    log(`testflight: build ${buildNumber} has no export compliance answer; testers will see "Missing Compliance"`);
  }

  const groups = (await api("GET", `/v1/apps/${appId}/betaGroups?limit=200`))?.data ?? [];
  const plan = planDistribution(groups, { external });
  log(`testflight: automatic ${groupNames(plan.automatic)}; adding to ${groupNames(plan.add)}`
    + (plan.skipped.length ? `; not for this channel ${groupNames(plan.skipped)}` : ""));

  const addTo = async (group) => {
    await api("POST", `/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: "builds", id: build.id }] });
    log(`testflight: added build ${buildNumber} to "${group.attributes?.name ?? group.id}"`);
  };
  // Internal testers first: a blocked external review must not cost them the build.
  for (const group of plan.add.filter((entry) => entry.attributes?.isInternalGroup)) await addTo(group);

  if (plan.external) {
    // External review needs "What to Test" for the build.
    const localizations = (await api("GET", `/v1/builds/${build.id}/betaBuildLocalizations`))?.data ?? [];
    const existing = localizations.find((entry) => entry.attributes?.locale === locale);
    if (existing) {
      if (!existing.attributes?.whatsNew) {
        await api("PATCH", `/v1/betaBuildLocalizations/${existing.id}`, {
          data: { type: "betaBuildLocalizations", id: existing.id, attributes: { whatsNew } },
        });
      }
    } else {
      await api("POST", "/v1/betaBuildLocalizations", {
        data: {
          type: "betaBuildLocalizations",
          attributes: { locale, whatsNew },
          relationships: { build: { data: { type: "builds", id: build.id } } },
        },
      });
    }
    const submission = await api("GET", `/v1/builds/${build.id}/betaAppReviewSubmission`).catch(() => null);
    if (submission?.data) {
      log(`testflight: build ${buildNumber} is already submitted for beta review (${submission.data.attributes?.betaReviewState ?? "unknown state"})`);
    } else {
      await submitForBetaReview({ api, appId, build, supersede, reviewWaitMs, pollMs, sleep, now, log });
    }
  }

  for (const group of plan.add.filter((entry) => !entry.attributes?.isInternalGroup)) await addTo(group);
  return { buildId: build.id, buildNumber, ...plan };
}

function fail(message) {
  throw new Error(message);
}

async function main(env) {
  const required = ["APP_STORE_CONNECT_ISSUER_ID", "APP_STORE_CONNECT_KEY_IDENTIFIER",
    "APP_STORE_CONNECT_PRIVATE_KEY", "APP_STORE_APPLE_ID"];
  const missing = required.filter((name) => !(env[name] ?? "").trim());
  if (missing.length) fail(`testflight-distribute needs ${missing.join(", ")}`);
  // Unset = the newest upload (the builder's distribute-only `testflight` target).
  const buildNumber = env.POLYTH_IOS_CURRENT_PROJECT_VERSION?.trim() || null;
  const version = env.POLYTH_IOS_MARKETING_VERSION?.trim();
  const whatsNew = env.POLYTH_IOS_WHATS_NEW?.trim()
    || `Polyth ${version ? `${version} ` : ""}${buildNumber ? `(${buildNumber}) ` : ""}test build. Please report anything that looks wrong.`;
  const minutes = (name, fallback) => {
    const value = Number(env[name] || fallback);
    return (Number.isFinite(value) && value >= 0 ? value : fallback) * 60_000;
  };
  const result = await distributeTestFlightBuild({
    api: createApi({
      issuerId: env.APP_STORE_CONNECT_ISSUER_ID.trim(),
      keyId: env.APP_STORE_CONNECT_KEY_IDENTIFIER.trim(),
      privateKey: env.APP_STORE_CONNECT_PRIVATE_KEY,
    }),
    appId: env.APP_STORE_APPLE_ID.trim(),
    buildNumber,
    // The distribute-only run takes the newest upload, whatever its version.
    marketingVersion: buildNumber ? version || null : null,
    whatsNew,
    external: externalTestFlightRequested(env),
    locale: env.POLYTH_IOS_TESTFLIGHT_LOCALE?.trim() || DEFAULT_LOCALE,
    maxWaitMs: minutes("POLYTH_IOS_TESTFLIGHT_WAIT_MINUTES", 45),
    reviewWaitMs: minutes("POLYTH_IOS_TESTFLIGHT_REVIEW_WAIT_MINUTES", 0),
    supersede: ["1", "true"].includes((env.POLYTH_IOS_TESTFLIGHT_SUPERSEDE ?? "").trim().toLowerCase()),
  });
  if (env.POLYTH_IOS_TESTFLIGHT_SUMMARY) {
    const summary = {
      build: result.buildNumber,
      automatic: result.automatic.map((group) => group.attributes?.name),
      added: result.add.map((group) => group.attributes?.name),
      skipped: result.skipped.map((group) => group.attributes?.name),
      externalReview: result.external,
    };
    writeFileSync(env.POLYTH_IOS_TESTFLIGHT_SUMMARY, `${JSON.stringify(summary, null, 2)}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.env).catch((error) => {
    console.error(`testflight-distribute: ${error.message}`);
    process.exit(1);
  });
}
