// WP9: managed plugin registry — manifest validation, path traversal, staged
// atomic install, kernel-scoped disposal, log redaction and bounds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistry, parseManifest, redactSecrets, TRUST_GRANTS } from "../src/index.ts";

const manifest = (over: Record<string, unknown> = {}) => JSON.stringify({
  id: "sample.widget",
  name: "Sample Widget",
  version: "1.0.0",
  trust: "ui-only",
  capabilities: ["polyth.demo"],
  contributions: [{ slot: "contextRail.tabs", id: "sample.tab", module: "sample-widget" }],
  ...over,
});

function scaffold(): { dir: string; trusted: string } {
  const root = mkdtempSync(join(tmpdir(), "polyth-plug-"));
  const dir = join(root, "installed");
  const trusted = join(root, "trusted");
  mkdirSync(trusted, { recursive: true });
  const pkg = join(trusted, "sample");
  mkdirSync(pkg);
  writeFileSync(join(pkg, "polyth-plugin.json"), manifest());
  writeFileSync(join(pkg, "package.json"), '{"name":"sample","version":"1.0.0"}');
  return { dir, trusted };
}

test("manifest parsing rejects malformed input, keeps valid descriptors", () => {
  assert.throws(() => parseManifest("{nope"), /valid JSON/);
  assert.throws(() => parseManifest(JSON.stringify({ id: "UPPER", name: "x", version: "1.0.0", trust: "pure" })), /identifier/);
  assert.throws(() => parseManifest(manifest({ trust: "root-of-all" })), /trust must be one of/);
  assert.throws(() => parseManifest(manifest({ version: "latest" })), /semver/);
  assert.throws(() => parseManifest(manifest({ contributions: [{ slot: "x" }] })), /slot, id, and module/);
  // Unknown slot names are rejected at the manifest boundary, never cast through.
  assert.throws(
    () => parseManifest(manifest({ contributions: [{ slot: "not.a.slot", id: "a", module: "m" }] })),
    /unknown ui slot "not\.a\.slot"/,
  );
  const m = parseManifest(manifest());
  assert.equal(m.id, "sample.widget");
  assert.equal(m.contributions!.length, 1);
  const widget = parseManifest(manifest({
    contributions: [{ slot: "widget.catalog", id: "sample.widget", module: "sample-widget" }],
  }));
  assert.equal(widget.contributions?.[0]?.slot, "widget.catalog");
  // every trust class has visible grant text
  assert.ok(TRUST_GRANTS[m.trust].length > 0);
});

test("file install stages atomically; traversal and duplicates rejected", async () => {
  const { dir, trusted } = scaffold();
  const reg = createPluginRegistry({ dir, trustedDir: trusted });

  await assert.rejects(() => reg.install("file:../outside"), /escapes the trusted/);
  await assert.rejects(() => reg.install("file:/etc/passwd"), /relative/);
  await assert.rejects(() => reg.install("git+ssh://host/repo"), /npm:.*file:/s);

  const dto = await reg.install("file:sample");
  assert.equal(dto.id, "sample.widget");
  assert.equal(dto.status, "installed");
  assert.equal(dto.enabled, false);
  assert.deepEqual(dto.contributions.map((c) => c.id), ["sample.tab"]);

  await assert.rejects(() => reg.install("file:sample"), /already installed/);
  await reg.dispose();
});

test("enable is atomic; disable disposes the kernel scope completely", async () => {
  const { dir, trusted } = scaffold();
  const reg = createPluginRegistry({ dir, trustedDir: trusted });
  await reg.install("file:sample");

  const enabled = await reg.enable("sample.widget");
  assert.equal(enabled.status, "ready");
  const state = reg.scopeState("sample.widget");
  assert.ok(state, "kernel scope exists while enabled");
  assert.equal(state!.contributions, 1);

  const disabled = await reg.disable("sample.widget");
  assert.equal(disabled.status, "disabled");
  assert.equal(reg.scopeState("sample.widget"), null, "scope fully disposed");
  await reg.dispose();
});

test("integrity mismatch fails activation without losing the install", async () => {
  const { dir, trusted } = scaffold();
  const reg = createPluginRegistry({ dir, trustedDir: trusted });
  await reg.install("file:sample");
  // Tamper after install: enable must refuse and report an error status.
  writeFileSync(join(dir, "sample.widget", "polyth-plugin.json"), manifest({ name: "Tampered" }));
  await assert.rejects(() => reg.enable("sample.widget"), /integrity/);
  const row = reg.list().find((p) => p.id === "sample.widget")!;
  assert.equal(row.status, "error");
  assert.match(row.lastError ?? "", /integrity/);

  // reload re-reads the manifest and recomputes integrity → healthy again
  const reloaded = await reg.reload("sample.widget");
  assert.equal(reloaded.status, "installed");
  const ok = await reg.enable("sample.widget");
  assert.equal(ok.status, "ready");
  await reg.dispose();
});

test("remove tears down scope, files, and logs", async () => {
  const { dir, trusted } = scaffold();
  const reg = createPluginRegistry({ dir, trustedDir: trusted });
  await reg.install("file:sample");
  await reg.enable("sample.widget");
  reg.log("sample.widget", "hello");
  assert.equal(await reg.remove("sample.widget"), true);
  assert.equal(await reg.remove("sample.widget"), false);
  assert.equal(reg.scopeState("sample.widget"), null);
  assert.deepEqual(reg.logs("sample.widget"), []);
  assert.deepEqual(reg.list(), []);
  await reg.dispose();
});

test("logs are bounded and secrets are redacted", async () => {
  const { dir, trusted } = scaffold();
  const reg = createPluginRegistry({ dir, trustedDir: trusted });
  await reg.install("file:sample");

  reg.log("sample.widget", "token sk-abcdefghijklmnopqrstuvwx done");
  reg.log("sample.widget", "auth: Bearer abc123def456ghi789");
  reg.log("sample.widget", "gh token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
  reg.log("sample.widget", "password=supersecret123 rest");
  const lines = reg.logs("sample.widget").map((l) => l.line);
  for (const l of lines) {
    assert.doesNotMatch(l, /sk-abcdefghijklmnopqrstuvwx|abc123def456|ghp_ABCDEF|supersecret123/);
    assert.match(l, /\[redacted\]/);
  }

  for (let i = 0; i < 600; i++) reg.log("sample.widget", `line ${i}`);
  const all = reg.logs("sample.widget", { limit: 500 });
  assert.ok(all.length <= 500, "ring buffer bounded");
  await reg.dispose();
});

test("redactSecrets leaves ordinary text alone", () => {
  const s = "installed 42 packages in 3s (no vulnerabilities)";
  assert.equal(redactSecrets(s), s);
});
