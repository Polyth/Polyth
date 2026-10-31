import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANTIGRAVITY_CLIENT_VERSION,
  antigravityClientHeaders,
  antigravityUserAgent,
  warnIfGeminiGroupMissing,
} from "../src/providers/antigravityClient.ts";

// Google gates the Gemini quota group by the advertised client version, so the
// stale literal is a correctness bug, not cosmetics. See antigravityClient.ts.
test("Antigravity does not advertise the client version Google stopped serving Gemini quota to", () => {
  assert.notEqual(ANTIGRAVITY_CLIENT_VERSION, "1.11.5");
  assert.match(ANTIGRAVITY_CLIENT_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(!(antigravityClientHeaders({ platform: "win32", arch: "x64" })["User-Agent"] ?? "").includes("1.11.5"));
});

test("the Antigravity User-Agent names the host platform in Go's os/arch form", () => {
  const version = ANTIGRAVITY_CLIENT_VERSION;
  assert.equal(antigravityUserAgent("win32", "x64"), `antigravity/${version} windows/amd64`);
  assert.equal(antigravityUserAgent("darwin", "arm64"), `antigravity/${version} darwin/arm64`);
  assert.equal(antigravityUserAgent("linux", "x64"), `antigravity/${version} linux/amd64`);
  // An architecture this client does not know keeps the 64-bit default, and an
  // unknown platform keeps the pair the provider has always sent.
  assert.equal(antigravityUserAgent("linux", "ia32"), `antigravity/${version} linux/amd64`);
  assert.equal(antigravityUserAgent("freebsd", "x64"), `antigravity/${version} windows/amd64`);
});

test("the Antigravity client headers carry the identity and the metadata blob", () => {
  const headers = antigravityClientHeaders({ platform: "darwin", arch: "arm64" });
  assert.equal(headers["User-Agent"], `antigravity/${ANTIGRAVITY_CLIENT_VERSION} darwin/arm64`);
  assert.equal(headers["X-Goog-Api-Client"], "google-cloud-sdk vscode_cloudshelleditor/0.1");
  assert.match(headers["Client-Metadata"] ?? "", /"pluginType":"GEMINI"/u);
});

// A summary that carries groups but none for Gemini is exactly what an outdated
// client version gets back, and it used to be indistinguishable from a provider
// that simply has no Gemini limits.
test("a summary whose groups are all third-party logs one warning naming the version", () => {
  const logged: string[] = [];
  const warn = (message: string) => logged.push(message);
  assert.equal(warnIfGeminiGroupMissing([{ displayName: "Claude" }], true, warn), undefined);
  assert.deepEqual(logged, [], "a Gemini group is present, so nothing is missing");

  warnIfGeminiGroupMissing([], false, warn);
  assert.deepEqual(logged, [], "an empty summary says nothing about a missing group");

  const groups = [{ displayName: "Claude models" }, { displayName: "GPT models" }];
  warnIfGeminiGroupMissing(groups, false, warn);
  assert.equal(logged.length, 1);
  const message = logged[0] ?? "";
  assert.match(message, /no Gemini quota group/u);
  assert.ok(message.includes(ANTIGRAVITY_CLIENT_VERSION), "the warning must name the constant to change");

  // Once per process: a refresh loop must not repeat it.
  warnIfGeminiGroupMissing(groups, false, warn);
  assert.equal(logged.length, 1);
});
