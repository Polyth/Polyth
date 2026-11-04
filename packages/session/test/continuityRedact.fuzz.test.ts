import assert from "node:assert/strict";
import test from "node:test";
import { redactContinuity } from "../src/continuity.ts";
import { FUZZ_SEED, assertBoundedTime, forEachFuzzInput } from "./fuzzInput.ts";

const TOKENS = ["-----BEGIN ", "-----END ", "PRIVATE KEY-----", "RSA ", "OPENSSH ", "Bearer ", "sk-ant-abcdefgh", "ghp_abcdefghijkl", "password=", "api_key: ", "eyJa.b.c", "\"", "'"];
const KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfuzzbodyline\n-----END RSA PRIVATE KEY-----";

test("redactContinuity never throws and removes a PEM private key embedded anywhere", () => {
  forEachFuzzInput(TOKENS, (input) => {
    // Noise must not itself open a BEGIN marker that swallows the key into a larger block.
    const noise = input.replace(/-----BEGIN|PRIVATE KEY-----/g, "");
    for (const at of [0, Math.floor(noise.length / 2), noise.length]) {
      const text = `${noise.slice(0, at)}${KEY}${noise.slice(at)}`;
      const out = redactContinuity(text);
      assert.ok(!out.includes("MIIEowIBAAKCAQEAfuzzbodyline"), "key body survived");
    }
  });
});

test("redactContinuity removes known secrets wherever they appear", () => {
  forEachFuzzInput(TOKENS, (input) => {
    const secret = `s3cr3t-${FUZZ_SEED}`;
    assert.ok(!redactContinuity(`${input}${secret}${input}`, [secret]).includes(secret));
  });
});

test("redactContinuity handles 50k repetitions of each token in bounded time", () => {
  assertBoundedTime(TOKENS, (input) => redactContinuity(input));
});
