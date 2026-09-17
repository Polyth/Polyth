import assert from "node:assert/strict";
import test from "node:test";
import { clearAuthCsrf } from "../src/authClient.ts";
import {
  signInWithPasskey,
  toPublicKeyCreationOptions,
  toPublicKeyRequestOptions,
} from "../src/passkeys.ts";

const bytes = (value: BufferSource): number[] => {
  if (value instanceof ArrayBuffer) return [...new Uint8Array(value)];
  return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)];
};
const buffer = (...value: number[]): ArrayBuffer => new Uint8Array(value).buffer;

test("passkey option bridge decodes canonical base64url byte fields", () => {
  const creation = toPublicKeyCreationOptions({
    challenge: "AQIDBA",
    rp: { id: "localhost", name: "Polyth" },
    user: { id: "dXNyX2FsaWNl", name: "alice", displayName: "Alice" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials: [{ type: "public-key", id: "BQY" }],
  });
  assert.deepEqual(bytes(creation.challenge), [1, 2, 3, 4]);
  assert.equal(new TextDecoder().decode(creation.user.id), "usr_alice");
  assert.deepEqual(bytes(creation.excludeCredentials?.[0]?.id ?? new Uint8Array()), [5, 6]);

  const request = toPublicKeyRequestOptions({
    challenge: "BwgJ",
    rpId: "localhost",
    userVerification: "required",
  });
  assert.deepEqual(bytes(request.challenge), [7, 8, 9]);
  assert.equal(request.rpId, "localhost");
});

test("passkey sign-in submits the exact assertion bytes then resolves canonical account scope", async () => {
  const previousFetch = globalThis.fetch;
  clearAuthCsrf();
  const calls: string[] = [];
  let requested: CredentialRequestOptions | undefined;
  try {
    const firstCsrf = "a".repeat(64);
    const nextCsrf = "b".repeat(64);
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      calls.push(path);
      if (path === "/api/auth/status") {
        return new Response(JSON.stringify({
          required: true,
          authorized: false,
          scope: "anonymous",
          state: "ready",
          methods: ["password", "passkey"],
          csrfToken: firstCsrf,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path === "/api/auth/passkeys/authenticate/options") {
        assert.equal((init?.headers as Record<string, string>)["x-polyth-csrf"], firstCsrf);
        return new Response(JSON.stringify({
          challenge: "AQIDBA",
          rpId: "localhost",
          timeout: 60_000,
          userVerification: "required",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path === "/api/auth/passkeys/authenticate/complete") {
        assert.deepEqual(JSON.parse(String(init?.body)), {
          credentialId: "AQI",
          clientDataJSON: "AwQ",
          authenticatorData: "BQ",
          signature: "Bgc",
          userHandle: "CA",
        });
        return new Response(JSON.stringify({ ok: true, csrfToken: nextCsrf }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/api/auth/accounts") {
        return new Response(JSON.stringify({
          currentAccountId: "usr_alice",
          canManage: false,
          accounts: [{ id: "usr_alice", name: "Alice", current: true }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch ${path}`);
    };

    const result = await signInWithPasskey({
      async get(options) {
        requested = options;
        return {
          id: "credential",
          type: "public-key",
          rawId: buffer(1, 2),
          response: {
            clientDataJSON: buffer(3, 4),
            authenticatorData: buffer(5),
            signature: buffer(6, 7),
            userHandle: buffer(8),
          },
        } as unknown as Credential;
      },
    });

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(bytes(requested?.publicKey?.challenge ?? new Uint8Array()), [1, 2, 3, 4]);
    assert.equal(requested?.publicKey?.rpId, "localhost");
    assert.deepEqual(calls, [
      "/api/auth/status",
      "/api/auth/passkeys/authenticate/options",
      "/api/auth/passkeys/authenticate/complete",
      "/api/auth/accounts",
    ]);
  } finally {
    clearAuthCsrf();
    globalThis.fetch = previousFetch;
  }
});
