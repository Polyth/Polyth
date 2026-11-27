#!/usr/bin/env node
// Uploads a signed Android App Bundle to Google Play and releases it on one
// track: edits.insert, bundle upload, tracks.update, edits.commit.
// `remote-build.mjs` runs this after `:app:bundleRelease` when the upload key
// and a service account are present. Uses the Android Publisher REST API
// directly (RS256 JWT from node:crypto) so the release needs no extra package.
// Nothing is retried: a failed or unconfirmed request fails the build.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const API = "https://androidpublisher.googleapis.com";
export const PLAY_PACKAGE = "com.polyth.mobile";

const CHANNEL_TRACKS = { nightly: "internal", test: "alpha", stable: "production" };
const STATUSES = ["draft", "completed"];

function fail(message) {
  throw new Error(message);
}

/**
 * `alpha` is Play's closed testing track. Production releases wait in the
 * console as drafts. POLYTH_ANDROID_PLAY_STATUS=draft is needed while the Play
 * app itself is still a draft app, which accepts nothing else.
 */
export function playRelease(env) {
  const channel = (env.POLYTH_RELEASE_CHANNEL ?? "").trim();
  const track = (env.POLYTH_ANDROID_PLAY_TRACK ?? "").trim()
    || (Object.hasOwn(CHANNEL_TRACKS, channel) ? CHANNEL_TRACKS[channel] : "");
  if (!track) {
    fail(`No Google Play track for POLYTH_RELEASE_CHANNEL=${JSON.stringify(channel)}; `
      + `use ${Object.keys(CHANNEL_TRACKS).join(", ")} or set POLYTH_ANDROID_PLAY_TRACK`);
  }
  const status = (env.POLYTH_ANDROID_PLAY_STATUS ?? "").trim() || (track === "production" ? "draft" : "completed");
  if (!STATUSES.includes(status)) {
    fail(`POLYTH_ANDROID_PLAY_STATUS must be one of ${STATUSES.join(", ")}, got ${JSON.stringify(status)}`);
  }
  return { track, status };
}

/** Errors never quote the input: it holds the private key. */
export function parseServiceAccount(text) {
  let account = null;
  // JSON.parse messages echo the source text, so its error is dropped.
  try { account = JSON.parse(text); } catch { /* reported below */ }
  if (typeof account?.client_email !== "string" || typeof account?.private_key !== "string") {
    fail("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON must be a service account key file with client_email and private_key");
  }
  return account;
}

export function serviceAccountAssertion(account, now = Date.now()) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const iat = Math.floor(now / 1000);
  // Google rejects assertions that live longer than one hour.
  const input = `${encode({ alg: "RS256", typ: "JWT", kid: account.private_key_id })}.${encode({
    iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600,
  })}`;
  const signature = sign("sha256", Buffer.from(input), createPrivateKey(account.private_key));
  return `${input}.${signature.toString("base64url")}`;
}

async function request(fetchImpl, label, url, init) {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!response.ok) {
    const detail = json?.error?.message ?? json?.error_description ?? json?.error ?? text.slice(0, 500);
    fail(`${label} -> ${response.status} ${detail}`);
  }
  return json;
}

export async function uploadBundle({
  account, bundle, releaseName, track, status, packageName = PLAY_PACKAGE, fetchImpl = fetch, log = console.log,
}) {
  const token = (await request(fetchImpl, "OAuth token", TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: serviceAccountAssertion(account),
    }).toString(),
  }))?.access_token;
  if (!token) fail("Google returned no access token");

  const api = (label, method, url, body, contentType = "application/json") => request(fetchImpl, label, url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": contentType } : {}) },
    body,
  });
  const app = `androidpublisher/v3/applications/${encodeURIComponent(packageName)}`;

  const editId = (await api("edits.insert", "POST", `${API}/${app}/edits`))?.id;
  if (!editId) fail("edits.insert returned no edit id");
  const edit = `${app}/edits/${encodeURIComponent(editId)}`;

  log(`play: uploading ${bundle.length} bytes to edit ${editId}`);
  const versionCode = (await api("bundles.upload", "POST", `${API}/upload/${edit}/bundles?uploadType=media`,
    bundle, "application/octet-stream"))?.versionCode;
  if (!Number.isInteger(versionCode)) fail("bundles.upload returned no versionCode");

  await api("tracks.update", "PUT", `${API}/${edit}/tracks/${encodeURIComponent(track)}`, JSON.stringify({
    track,
    releases: [{ name: releaseName, versionCodes: [String(versionCode)], status }],
  }));
  await api("edits.commit", "POST", `${API}/${edit}:commit`);
  log(`play: committed versionCode ${versionCode} to track ${track} (${status})`);
  return { track, status, versionCode, editId };
}

async function main(env, bundlePath) {
  if (!bundlePath) fail("usage: play-upload.mjs <app.aab>");
  const missing = ["GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", "POLYTH_VERSION"].filter((name) => !(env[name] ?? "").trim());
  if (missing.length) fail(`play-upload needs ${missing.join(", ")}`);
  const summary = await uploadBundle({
    account: parseServiceAccount(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON),
    bundle: readFileSync(bundlePath),
    releaseName: env.POLYTH_VERSION.trim(),
    ...playRelease(env),
  });
  if (env.POLYTH_ANDROID_PLAY_SUMMARY) {
    writeFileSync(env.POLYTH_ANDROID_PLAY_SUMMARY, `${JSON.stringify(summary, null, 2)}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.env, process.argv[2]).catch((error) => {
    console.error(`play-upload: ${error.message}`);
    process.exit(1);
  });
}
