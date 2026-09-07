// WP9: managed plugin registry — manifest validation, path traversal, staged
// atomic install, kernel-scoped disposal, log redaction and bounds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstalledPluginDto, RouteHandler, UiSlotItem } from "@polyth/contracts";
import { createContext } from "@polyth/kernel";
import { createPluginRegistry, parseManifest, redactSecrets, TRUST_GRANTS, type PluginRegistry } from "../src/index.ts";
import { testSpaceStorage } from "./helpers.ts";

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
  assert.throws(() => parseManifest(manifest({ entries: { worker: "./worker.mjs" } })), /unknown manifest entry key/);
  for (const entry of ["/tmp/server.mjs", "../server.mjs", "dist\\server.mjs", "C:/server.mjs"]) {
    assert.throws(
      () => parseManifest(manifest({ entries: { server: entry } })),
      /must be a relative path/,
    );
  }
  assert.throws(() => parseManifest(manifest({ contributions: [{ slot: "x" }] })), /slot, id, and module/);
  // Unknown slot names are rejected at the manifest boundary, never cast through.
  assert.throws(
    () => parseManifest(manifest({ contributions: [{ slot: "not.a.slot", id: "a", module: "m" }] })),
    /unknown ui slot "not\.a\.slot"/,
  );
  const m = parseManifest(manifest());
  assert.equal(m.id, "sample.widget");
  assert.equal(m.contributions!.length, 1);
  assert.deepEqual(
    parseManifest(manifest({ entries: { ui: "./dist/ui.mjs" } })).entries,
    { ui: "./dist/ui.mjs" },
  );
  const widget = parseManifest(manifest({
    contributions: [{ slot: "widget.catalog", id: "sample.widget", module: "sample-widget" }],
  }));
  assert.equal(widget.contributions?.[0]?.slot, "widget.catalog");
  // every trust class has visible grant text
  assert.ok(TRUST_GRANTS[m.trust].length > 0);
});

test("plugins may own zero or many full and mini widgets", () => {
  const withoutWidgets = parseManifest(manifest({ widgets: undefined }));
  assert.deepEqual(withoutWidgets.widgets, []);

  const widgets = [
    {
      id: "sample.overview",
      module: "sample-overview",
      title: "Overview",
      description: "Project overview",
      kind: "widget",
      defaultSlot: "workspace.main",
      supportedSlots: ["workspace.main", "workspace.right"],
    },
    {
      id: "sample.refresh",
      module: "sample-refresh",
      title: "Refresh",
      description: "Refresh sample data",
      kind: "mini-widget",
      defaultSlot: "session.header.actions",
      supportedSlots: ["session.header.actions", "app.header.actions"],
      defaultVisible: true,
    },
  ];
  const parsed = parseManifest(manifest({ widgets }));
  assert.deepEqual(parsed.widgets?.map((widget) => widget.id), ["sample.overview", "sample.refresh"]);
  assert.equal(parsed.widgets?.[1]?.kind, "mini-widget");
  assert.throws(
    () => parseManifest(manifest({ widgets: [{ ...widgets[0], supportedSlots: ["workspace.right"] }] })),
    /must include defaultSlot/,
  );
  assert.throws(
    () => parseManifest(manifest({ widgets: [widgets[0], widgets[0]] })),
    /duplicate widget id/,
  );
});

test("managed activation contributes every plugin-owned widget and disposes them together", async () => {
  const { dir, trusted } = scaffold();
  const source = join(trusted, "sample", "polyth-plugin.json");
  writeFileSync(source, manifest({
    contributions: [],
    widgets: [
      {
        id: "sample.one",
        module: "sample-one",
        title: "One",
        description: "First",
        kind: "widget",
        defaultSlot: "workspace.main",
        supportedSlots: ["workspace.main"],
      },
      {
        id: "sample.two",
        module: "sample-two",
        title: "Two",
        description: "Second",
        kind: "mini-widget",
        defaultSlot: "composer.trailing",
        supportedSlots: ["composer.trailing", "session.header.actions"],
      },
    ],
  }));
  const reg = createPluginRegistry({ dir, trustedDir: trusted });
  const installed = await reg.install("file:sample");
  assert.deepEqual(installed.widgets?.map((widget) => widget.id), ["sample.one", "sample.two"]);
  assert.deepEqual(installed.contributions.map((item) => item.slot), ["widget.catalog", "widget.catalog"]);

  await reg.enable("sample.widget");
  assert.equal(reg.scopeState("sample.widget")?.contributions, 2);
  await reg.disable("sample.widget");
  assert.equal(reg.scopeState("sample.widget"), null);
  await reg.dispose();
});

test("file install stages atomically; traversal and duplicates rejected", async () => {
  const { dir, trusted } = scaffold();
  const reg = createPluginRegistry({ dir, trustedDir: trusted });

  await assert.rejects(() => reg.install("file:../outside"), /escapes the trusted/);
  await assert.rejects(() => reg.install("file:/etc/passwd"), /relative/);
  await assert.rejects(() => reg.install("git+ssh://host/repo"), /git and npm package sources are disabled/);
  await assert.rejects(() => reg.install("npm:left-pad"), /git and npm package sources are disabled/);

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

test("disable clears scope and persists disabled state when disposal fails", async () => {
  const { dir, trusted } = scaffold();
  const changes: InstalledPluginDto[] = [];
  let reg!: PluginRegistry;
  reg = createPluginRegistry({
    dir,
    trustedDir: trusted,
    slots: {
      add() {
        return {
          dispose() {
            throw new Error("dispose failed");
          },
        };
      },
    },
    onChange: (id) => {
      const row = reg.list().find((plugin) => plugin.id === id);
      if (row) changes.push(row);
    },
  });
  await reg.install("file:sample");
  await reg.enable("sample.widget");

  await assert.rejects(() => reg.disable("sample.widget"), /dispose: plugin:sample\.widget/);

  const state = reg.list().find((plugin) => plugin.id === "sample.widget");
  assert.equal(state?.enabled, false);
  assert.equal(state?.status, "disabled");
  assert.equal(reg.scopeState("sample.widget"), null);
  assert.deepEqual(
    changes.at(-1) && { enabled: changes.at(-1)!.enabled, status: changes.at(-1)!.status },
    { enabled: false, status: "disabled" },
  );
  await reg.dispose();
});

test("entries.server on a trusted file install loads and disposes the server plugin", async () => {
  const { dir, trusted } = scaffold();
  const pluginDir = join(trusted, "sample");
  writeFileSync(join(pluginDir, "polyth-plugin.json"), manifest({
    trust: "workspace",
    entries: { server: "./server.mjs" },
  }));
  writeFileSync(join(pluginDir, "server.mjs"), `
    export default (host) => ({
      manifest: { id: host.pluginId, version: "1.0.0", trust: "workspace" },
      setup(context) {
        const route = host.routes.add(async () => true);
        context.effect(() => route.dispose());
      },
    });
  `);
  const root = createContext("test-root");
  const activeRoutes = new Set<RouteHandler>();
  const reg = createPluginRegistry({
    dir,
    trustedDir: trusted,
    root,
    routes: {
      add(handler) {
        activeRoutes.add(handler);
        return { dispose: () => { activeRoutes.delete(handler); } };
      },
    },
  });

  await reg.install("file:sample");
  await reg.enable("sample.widget");
  assert.equal(activeRoutes.size, 1);
  await reg.disable("sample.widget");
  assert.equal(activeRoutes.size, 0);
  await reg.dispose();
  await root.dispose();
});

test("low-trust manifests cannot install executable server entries", async () => {
  const { dir, trusted } = scaffold();
  writeFileSync(
    join(trusted, "sample", "polyth-plugin.json"),
    manifest({ entries: { server: "./server.mjs" } }),
  );
  writeFileSync(join(trusted, "sample", "server.mjs"), "export default () => ({})");
  const reg = createPluginRegistry({ dir, trustedDir: trusted });
  await assert.rejects(() => reg.install("file:sample"), /ui-only.*cannot declare entries\.server/);
  await reg.dispose();
});

test("concurrent disable then enable is serialized per plugin", async () => {
  const { dir, trusted } = scaffold();
  const storage = testSpaceStorage(join(dir, "..", "space"));
  const active = new Set<UiSlotItem>();
  let markDisposalStarted!: () => void;
  const disposalStarted = new Promise<void>((resolve) => { markDisposalStarted = resolve; });
  let releaseDisposal!: () => void;
  const disposalGate = new Promise<void>((resolve) => { releaseDisposal = resolve; });
  const reg = createPluginRegistry({
    dir,
    trustedDir: trusted,
    slots: {
      add(item) {
        active.add(item);
        return {
          async dispose() {
            markDisposalStarted();
            await disposalGate;
            active.delete(item);
          },
        };
      },
    },
  });
  await reg.install("file:sample");
  await reg.enable("sample.widget", storage);

  const disabling = reg.disable("sample.widget", storage);
  await disposalStarted;
  const enabling = reg.enable("sample.widget", storage);
  releaseDisposal();
  await Promise.all([disabling, enabling]);

  const state = reg.detail("sample.widget", storage);
  assert.equal(state?.enabled, true);
  assert.equal(state?.status, "ready");
  assert.equal(active.size, 1, "the final enabled state retains one active contribution");
  await reg.dispose();
});

test("remove serializes teardown against later lifecycle transitions", async () => {
  const { dir, trusted } = scaffold();
  let markDisposalStarted!: () => void;
  const disposalStarted = new Promise<void>((resolve) => { markDisposalStarted = resolve; });
  let releaseDisposal!: () => void;
  const disposalGate = new Promise<void>((resolve) => { releaseDisposal = resolve; });
  const reg = createPluginRegistry({
    dir,
    trustedDir: trusted,
    slots: {
      add() {
        return {
          async dispose() {
            markDisposalStarted();
            await disposalGate;
          },
        };
      },
    },
  });
  await reg.install("file:sample");
  await reg.enable("sample.widget");

  const removing = reg.remove("sample.widget");
  await disposalStarted;
  const enabling = reg.enable("sample.widget");
  releaseDisposal();

  assert.equal(await removing, true);
  await assert.rejects(() => enabling, /not installed/);
  assert.deepEqual(reg.list(), []);
  await reg.dispose();
});

test("onChange publishes persisted enable and disable states", async () => {
  const { dir, trusted } = scaffold();
  const storage = testSpaceStorage(join(dir, "..", "space"));
  const changes: InstalledPluginDto[] = [];
  let reg!: PluginRegistry;
  reg = createPluginRegistry({
    dir,
    trustedDir: trusted,
    onChange: (id) => {
      changes.push(reg.detail(id, storage));
    },
  });
  await reg.install("file:sample");
  await reg.enable("sample.widget", storage);
  await reg.disable("sample.widget", storage);

  assert.deepEqual(
    changes.slice(-2).map((plugin) => ({ enabled: plugin.enabled, status: plugin.status })),
    [
      { enabled: true, status: "ready" },
      { enabled: false, status: "disabled" },
    ],
  );
  await reg.dispose();
});

test("integrity mismatch fails activation without losing the install", async () => {
  const { dir, trusted } = scaffold();
  const reg = createPluginRegistry({ dir, trustedDir: trusted });
  await reg.install("file:sample");
  // Tamper after install: enable must refuse and report an error status.
  writeFileSync(join(reg.installDir("sample.widget"), "polyth-plugin.json"), manifest({ name: "Tampered" }));
  await assert.rejects(() => reg.enable("sample.widget"), /integrity/);
  const row = reg.list().find((p) => p.id === "sample.widget")!;
  assert.equal(row.status, "error");
  assert.match(row.lastError ?? "", /integrity/);

  const before = readFileSync(join(reg.installDir("sample.widget"), "polyth-plugin.json"), "utf8");
  await assert.rejects(() => reg.reload("sample.widget"), /integrity/);
  assert.equal(reg.list().find((p) => p.id === "sample.widget")?.status, "error");
  assert.equal(readFileSync(join(reg.installDir("sample.widget"), "polyth-plugin.json"), "utf8"), before);
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
  reg.log("sample.widget", "https://example/cb?code=oauthcodevalue&code_verifier=pkceverifiervalue");
  const lines = reg.logs("sample.widget").map((l) => l.line);
  for (const l of lines) {
    assert.doesNotMatch(l, /sk-abcdefghijklmnopqrstuvwx|abc123def456|ghp_ABCDEF|supersecret123|oauthcodevalue|pkceverifiervalue/);
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

test("legacy trust classes do not invent sandbox network.fetch capabilities", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-legacy-trust-"));
  writeFileSync(join(dir, "polyth-plugin.json"), JSON.stringify({
    id: "sample.network",
    name: "Legacy network",
    version: "1.0.0",
    trust: "network",
    capabilities: ["polyth.demo"],
    contributions: [],
  }));
  const { loadCanonicalManifest } = await import("../src/canonical.ts");
  const loaded = loadCanonicalManifest(dir);
  assert.equal(loaded.canonical.runtime?.kind, "trusted-local");
  assert.equal((loaded.canonical.capabilities ?? []).some((cap) => cap.name === "network.fetch"), false);
  assert.equal(loaded.legacy.trust, "network");
});
