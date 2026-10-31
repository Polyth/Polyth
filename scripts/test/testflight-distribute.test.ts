import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import {
  appStoreConnectToken,
  distributeTestFlightBuild,
  externalTestFlightRequested,
  planDistribution,
} from "../ci/testflight-distribute.mjs";

const group = (id: string, isInternalGroup: boolean, hasAccessToAllBuilds = false) => ({
  id, attributes: { name: id, isInternalGroup, hasAccessToAllBuilds },
});

test("only manual test/stable runs reach external testers unless overridden", () => {
  assert.equal(externalTestFlightRequested({ POLYTH_RELEASE_CHANNEL: "nightly" }), false);
  assert.equal(externalTestFlightRequested({}), false);
  assert.equal(externalTestFlightRequested({ POLYTH_RELEASE_CHANNEL: "test" }), true);
  assert.equal(externalTestFlightRequested({ POLYTH_RELEASE_CHANNEL: "stable" }), true);
  assert.equal(externalTestFlightRequested({ POLYTH_RELEASE_CHANNEL: "stable", POLYTH_IOS_TESTFLIGHT_EXTERNAL: "0" }), false);
  assert.equal(externalTestFlightRequested({ POLYTH_RELEASE_CHANNEL: "nightly", POLYTH_IOS_TESTFLIGHT_EXTERNAL: "true" }), true);
});

test("the API token is an ES256 JWT Apple can verify", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const token = appStoreConnectToken({ issuerId: "issuer", keyId: "KEY", privateKey: pem.replace(/\n/g, "\\n") }, 1_000_000);
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "ES256", kid: "KEY", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(claims.aud, "appstoreconnect-v1");
  assert.equal(claims.iss, "issuer");
  assert.ok(claims.exp - claims.iat <= 20 * 60);
  assert.ok(verify("sha256", Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url")));
});

test("internal all-builds groups are automatic; the rest are added", () => {
  const groups = [group("team", true, true), group("qa", true), group("public", false)];
  const external = planDistribution(groups, { external: true });
  assert.deepEqual(external.automatic.map((g) => g.id), ["team"]);
  assert.deepEqual(external.add.map((g) => g.id), ["qa", "public"]);
  assert.equal(external.external, true);
  const internal = planDistribution(groups, { external: false });
  assert.deepEqual(internal.add.map((g) => g.id), ["qa"]);
  assert.deepEqual(internal.skipped.map((g) => g.id), ["public"]);
  assert.equal(internal.external, false);
});

function fakeApi(states: string[], { localizations = [] as unknown[], submitted = false, blockedFor = 0 } = {}) {
  const calls: Array<[string, string, unknown]> = [];
  let blocked = blockedFor;
  let expired = false;
  const api = async (method: string, path: string, body?: unknown) => {
    calls.push([method, path, body]);
    if (path.includes("betaReviewState")) return { data: [{ id: "old", attributes: { version: "31" } }] };
    if (path.includes("sort=-uploadedDate")) return { data: [{ id: "b1", attributes: { version: "32" } }] };
    if (method === "GET" && path.startsWith("/v1/builds?")) {
      const state = states.shift();
      return { data: state ? [{ id: "b1", attributes: { version: "32", processingState: state, usesNonExemptEncryption: false } }] : [] };
    }
    if (method === "PATCH" && path === "/v1/builds/old") { expired = true; return {}; }
    if (method === "POST" && path === "/v1/betaAppReviewSubmissions" && !expired && blocked-- > 0) {
      throw Object.assign(new Error("422"), { codes: ["ENTITY_UNPROCESSABLE.ANOTHER_BUILD_IN_REVIEW"] });
    }
    if (path === "/v1/apps/123/betaGroups?limit=200") {
      return { data: [group("team", true, true), group("qa", true), group("public", false)] };
    }
    if (path === "/v1/builds/b1/betaBuildLocalizations") return { data: localizations };
    if (path === "/v1/builds/b1/betaAppReviewSubmission") return { data: submitted ? { id: "s", attributes: {} } : null };
    return { data: { attributes: { betaReviewState: "WAITING_FOR_REVIEW" } } };
  };
  return { api, calls };
}

test("waits for processing, submits for review, then adds the build to every group", async () => {
  const { api, calls } = fakeApi(["", "PROCESSING", "VALID"]);
  let clock = 0;
  await distributeTestFlightBuild({
    api, appId: "123", buildNumber: "32", whatsNew: "notes",
    sleep: async () => { clock += 1000; }, now: () => clock, log: () => {},
  });
  const writes = calls.filter(([method]) => method !== "GET").map(([method, path, body]) => [method, path, body]);
  assert.deepEqual(writes.map(([method, path]) => `${method} ${path}`), [
    "POST /v1/betaGroups/qa/relationships/builds",
    "POST /v1/betaBuildLocalizations",
    "POST /v1/betaAppReviewSubmissions",
    "POST /v1/betaGroups/public/relationships/builds",
  ]);
  assert.deepEqual((writes[1][2] as { data: { attributes: unknown } }).data.attributes, { locale: "en-US", whatsNew: "notes" });
});

test("a known marketing version pins the build lookup; the newest upload does not", async () => {
  const pinned = fakeApi(["VALID"]);
  await distributeTestFlightBuild({
    api: pinned.api, appId: "123", buildNumber: "32", marketingVersion: "1.2.204", whatsNew: "n", log: () => {},
  });
  const lookup = pinned.calls.find(([method, path]) => method === "GET" && path.includes("filter[version]=32"));
  assert.ok(lookup?.[1].includes("&filter[preReleaseVersion.version]=1.2.204&"));

  const newest = fakeApi(["VALID"]);
  await distributeTestFlightBuild({ api: newest.api, appId: "123", buildNumber: null, whatsNew: "n", log: () => {} });
  assert.ok(newest.calls.every(([, path]) => !path.includes("preReleaseVersion")));
});

test("a retry keeps existing notes and does not resubmit", async () => {
  const { api, calls } = fakeApi(["VALID"], {
    localizations: [{ id: "l1", attributes: { locale: "en-US", whatsNew: "kept" } }],
    submitted: true,
  });
  await distributeTestFlightBuild({ api, appId: "123", buildNumber: "32", whatsNew: "new", log: () => {} });
  const writes = calls.filter(([method]) => method !== "GET").map(([method, path]) => `${method} ${path}`);
  assert.deepEqual(writes, [
    "POST /v1/betaGroups/qa/relationships/builds",
    "POST /v1/betaGroups/public/relationships/builds",
  ]);
});

test("a build blocked by another review keeps internal testers and names the blocker", async () => {
  const { api, calls } = fakeApi(["VALID"], { blockedFor: 99 });
  await assert.rejects(distributeTestFlightBuild({ api, appId: "123", buildNumber: "32", whatsNew: "n", log: () => {} }),
    /build\(s\) 31 of the same version are already in review/);
  const writes = calls.filter(([method]) => method !== "GET").map(([method, path]) => `${method} ${path}`);
  assert.ok(writes.includes("POST /v1/betaGroups/qa/relationships/builds"));
  assert.ok(!writes.includes("POST /v1/betaGroups/public/relationships/builds"));
  assert.ok(!writes.includes("PATCH /v1/builds/old"), "nothing is expired without supersede");
});

test("a blocked submission is retried while the review wait lasts", async () => {
  const { api, calls } = fakeApi(["VALID"], { blockedFor: 2 });
  let clock = 0;
  await distributeTestFlightBuild({
    api, appId: "123", buildNumber: "32", whatsNew: "n", reviewWaitMs: 10_000,
    sleep: async () => { clock += 1000; }, now: () => clock, log: () => {},
  });
  assert.equal(calls.filter(([method, path]) => method === "POST" && path === "/v1/betaAppReviewSubmissions").length, 3);
  assert.ok(calls.some(([, path]) => path === "/v1/betaGroups/public/relationships/builds"));
});

test("supersede expires an older build in review, then submits the newest upload", async () => {
  const { api, calls } = fakeApi(["VALID"], { blockedFor: 99 });
  const result = await distributeTestFlightBuild({ api, appId: "123", buildNumber: null, whatsNew: "n", supersede: true, log: () => {} });
  assert.equal(result.buildNumber, "32");
  const writes = calls.filter(([method]) => method !== "GET").map(([method, path]) => `${method} ${path}`);
  assert.deepEqual(writes.slice(-3), [
    "PATCH /v1/builds/old",
    "POST /v1/betaAppReviewSubmissions",
    "POST /v1/betaGroups/public/relationships/builds",
  ]);
});

test("a build that never finishes processing fails loudly", async () => {
  const { api } = fakeApi(Array(10).fill("PROCESSING"));
  let clock = 0;
  await assert.rejects(distributeTestFlightBuild({
    api, appId: "123", buildNumber: "32", whatsNew: "n", maxWaitMs: 3000,
    sleep: async () => { clock += 1000; }, now: () => clock, log: () => {},
  }), /not processed within/);
  const failed = fakeApi(["FAILED"]);
  await assert.rejects(distributeTestFlightBuild({ api: failed.api, appId: "123", buildNumber: "32", whatsNew: "n", log: () => {} }),
    /processing ended FAILED/);
});
