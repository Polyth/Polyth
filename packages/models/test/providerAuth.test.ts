import assert from "node:assert/strict";
import test from "node:test";
import {
  authError,
  buildProviderAuthView,
  canTransition,
  classifyAuthUrl,
  discoveryStatus,
  extractDeviceFlow,
  fingerprintAuthMethod,
  firstIncompleteField,
  isAuthErrorCode,
  mapUpstreamAuthError,
  normalizeAuthMethod,
  parseAuthorizationCode,
  pruneHiddenValues,
  redactSecrets,
  resolveCredentialSource,
  urlHasLoopbackRedirect,
  visiblePrompts,
  withSelectDefaults,
} from "../src/auth/index.ts";
import { validateWellKnownDocument } from "../src/auth/wellKnown.ts";

const BIZARRE_SECRET = "zz!!not-a-token!!xyz-42";

test("discovery distinguishes loaded-empty from failed and unavailable", () => {
  assert.equal(discoveryStatus(true, false, false, 0), "empty");
  assert.equal(discoveryStatus(true, false, false, 2), "loaded");
  assert.equal(discoveryStatus(false, true, false, 0), "failed");
  assert.equal(discoveryStatus(false, false, true, 0), "unavailable");
});

test("api methods gain a secret key field; oauth does not invent one", () => {
  const api = normalizeAuthMethod({ type: "api", label: "API key", upstreamIndex: 0 }, "acme");
  assert.equal(api.fields[0]?.kind, "secret");
  const oauth = normalizeAuthMethod({ type: "oauth", label: "Sign in", upstreamIndex: 0 }, "acme");
  assert.equal(oauth.fields.length, 0);
  assert.equal(api.id.includes("acme:0:"), true);
});

test("method fingerprint changes when prompts or type change at the same index", () => {
  const oauth = { type: "oauth" as const, label: "Sign in", upstreamIndex: 1 };
  const replaced = { type: "api" as const, label: "Sign in", upstreamIndex: 1 };
  const prompted = {
    type: "oauth" as const,
    label: "Sign in",
    upstreamIndex: 1,
    prompts: [{ type: "text" as const, key: "url", message: "URL" }],
  };
  assert.notEqual(fingerprintAuthMethod(oauth), fingerprintAuthMethod(replaced));
  assert.notEqual(fingerprintAuthMethod(oauth), fingerprintAuthMethod(prompted));
});

test("conditional prompts hide and prune stale values", () => {
  const prompts = [
    { type: "select" as const, key: "kind", message: "Kind", options: [{ label: "Cloud", value: "cloud" }, { label: "Enterprise", value: "ent" }] },
    { type: "text" as const, key: "url", message: "URL", when: { key: "kind", op: "eq" as const, value: "ent" } },
    { type: "text" as const, key: "secret", message: "Token", when: { key: "kind", op: "neq" as const, value: "cloud" } },
  ];
  assert.deepEqual(visiblePrompts(prompts, { kind: "cloud" }).map((p) => p.key), ["kind"]);
  assert.deepEqual(pruneHiddenValues(prompts, { kind: "cloud", url: "https://stale.example", secret: "hidden-secret" }), { kind: "cloud" });
  assert.deepEqual(visiblePrompts(prompts, { kind: "ent" }).map((p) => p.key), ["kind", "url", "secret"]);
});

test("select defaults and required visible fields", () => {
  const fields = normalizeAuthMethod({
    type: "api",
    label: "API key",
    upstreamIndex: 0,
    prompts: [
      { type: "select", key: "kind", message: "Kind", options: [{ label: "Cloud", value: "cloud" }, { label: "Ent", value: "ent" }] },
      { type: "text", key: "url", message: "URL", when: { key: "kind", op: "eq", value: "ent" } },
    ],
  }, "acme").fields;
  const defaults = withSelectDefaults(fields, {});
  assert.equal(defaults.kind, "cloud");
  assert.equal(firstIncompleteField(fields, defaults), "key");
  assert.equal(firstIncompleteField(fields, { ...defaults, key: "x", kind: "ent" }), "url");
  assert.equal(firstIncompleteField(fields, { ...defaults, key: "x", kind: "cloud", url: "stale" }), undefined);
});

test("authorization callback paste extracts the code locally and never returns the URL", () => {
  assert.deepEqual(parseAuthorizationCode("abc-123"), { ok: true, code: "abc-123" });
  assert.deepEqual(
    parseAuthorizationCode("http://localhost:4096/callback?code=from%20url&state=nope"),
    { ok: true, code: "from url" },
  );
  assert.equal(parseAuthorizationCode("http://localhost:4096/callback?authorization_code=alias").ok, true);
  const denied = parseAuthorizationCode("http://localhost/cb?error=access_denied");
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "AUTH_DENIED");
  const missing = parseAuthorizationCode("https://example.test/callback?state=only");
  assert.equal(missing.ok, false);
  const js = parseAuthorizationCode("javascript:alert(1)");
  assert.equal(js.ok, false);
});

test("device flow prefers structured fields, keeps instructions, and does not invent expiry from oauth urls", () => {
  assert.equal(extractDeviceFlow({ user_code: "WXYZ-9999", instructions: "ignore" }).userCode, "WXYZ-9999");
  assert.equal(extractDeviceFlow({ instructions: "Enter code AB12-CD34 at https://example.test/device" }).userCode, "AB12-CD34");
  assert.equal(extractDeviceFlow({ userCode: "not-hyphenated" }).userCode, "not-hyphenated");
  const fromOauthUrl = extractDeviceFlow({
    instructions: "Continue in the browser",
    url: "https://login.example/oauth/authorize",
  });
  assert.equal(fromOauthUrl.verificationUri, undefined);
  assert.equal(fromOauthUrl.expiresIn, undefined);
});

test("url classification never uses provider ids", () => {
  assert.equal(classifyAuthUrl("https://login.example/oauth/authorize?client_id=1"), "authorization");
  assert.equal(classifyAuthUrl("https://example.test/device"), "device_verification");
  assert.equal(classifyAuthUrl("https://example.test/docs/api-keys"), "informational");
  assert.equal(classifyAuthUrl("javascript:alert(1)"), "unknown");
  assert.equal(urlHasLoopbackRedirect("https://id.example/authorize?redirect_uri=http://127.0.0.1:4096/cb"), true);
});

test("failed discovery does not become an API key method", () => {
  const view = buildProviderAuthView({
    providerId: "openrouter",
    methods: undefined,
    metadata: { id: "openrouter", name: "OpenRouter", env: ["OPENROUTER_API_KEY"] },
    connected: false,
    discovery: { status: "failed", provenance: [], revision: "r", authorityId: "a", generation: 1, error: authError("AUTH_DISCOVERY_FAILED") },
  });
  assert.equal(view.methods.length, 0);
  assert.equal(view.discovery.status, "failed");
});

test("environment credentials remain after stored removal; connected provenance stays unknown", () => {
  const env = resolveCredentialSource({ connected: true, envPresent: ["OPENAI_API_KEY"] });
  assert.equal(env?.source, "environment");
  const unknown = resolveCredentialSource({ connected: true, envPresent: [] });
  assert.equal(unknown?.source, "unknown");
  assert.equal(unknown?.verification, "verified");
  const saved = resolveCredentialSource({ connected: false, envPresent: [], justSaved: true });
  assert.equal(saved?.verification, "saved");
});

test("exact secret values are redacted even when they dodge token regexes", () => {
  const redacted = redactSecrets(`oops ${BIZARRE_SECRET} and Bearer abcdefghijklmnop`, [BIZARRE_SECRET]);
  assert.equal(redacted.includes(BIZARRE_SECRET), false);
  assert.equal(redacted.includes("abcdefghijklmnop"), false);
  const mapped = mapUpstreamAuthError(Object.assign(new Error(`provider said ${BIZARRE_SECRET}`), { code: "AUTH_FROM_THE_FUTURE" }), [BIZARRE_SECRET]);
  assert.equal(isAuthErrorCode("AUTH_FROM_THE_FUTURE"), false);
  assert.equal(mapped.code, "AUTH_CALLBACK_FAILED");
  assert.equal(mapped.message.includes("undefined"), false);
  assert.equal(mapped.details?.includes(BIZARRE_SECRET), false);
});

test("state machine fences terminal phases", () => {
  assert.equal(canTransition("waiting", "connected"), true);
  assert.equal(canTransition("cancelled", "connected"), false);
  assert.equal(canTransition("stale", "connected"), false);
  assert.equal(canTransition("waiting", "stale"), true);
});

test("well-known documents require command argv and auth.env", () => {
  assert.equal(validateWellKnownDocument("https://org.test", "<html>", "text/html", 200).ok, false);
  assert.equal(validateWellKnownDocument("https://org.test", { auth: { command: "rm -rf /" } }, "application/json", 200).ok, false);
  assert.equal(validateWellKnownDocument("https://org.test", { auth: { command: ["opencode"] } }, "application/json", 200).ok, false);
  assert.equal(validateWellKnownDocument("https://org.test", { auth: { command: ["ok"], env: "not valid" } }, "application/json", 200).ok, false);
  const ok = validateWellKnownDocument("https://org.test", { auth: { command: ["opencode", "auth", "login"], env: "OPENCODE_ORG_TOKEN" } }, "application/json", 200);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.document.command, ["opencode", "auth", "login"]);
    assert.equal(ok.document.env, "OPENCODE_ORG_TOKEN");
  }
});

test("upstream oauth-unavailable maps to a stable error, not raw UX copy", () => {
  const mapped = mapUpstreamAuthError(Object.assign(new Error("provider oauth unavailable"), { code: "unsupported" }));
  assert.equal(mapped.code, "AUTH_CAPABILITY_UNAVAILABLE");
  assert.equal(mapped.message.includes("provider oauth unavailable"), false);
});
