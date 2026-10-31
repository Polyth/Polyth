import test from "node:test";
import assert from "node:assert/strict";
import { PACKAGE_CLASSIFIER_ORDER, packageClassifiers, classifyPackage } from "../src/classify.ts";
import { parsePackageManifestDocument } from "../src/manifest.ts";

const v2 = (over: Record<string, unknown> = {}) => parsePackageManifestDocument({
  manifestVersion: 2,
  id: "com-example-demo",
  version: "1.0.0",
  display: { name: "Demo", description: "Demo package" },
  runtime: { kind: "sandboxed", ui: { entry: "ui.ts" } },
  ...over,
});

test("classifiers come from the real contribution graph, not from copy", () => {
  const manifest = v2({
    contributes: {
      widgets: [{ id: "w1", title: "Widget", description: "A widget" }],
      commands: [{ id: "c1", name: "demo", description: "A command" }],
    },
    capabilities: ["ui.render", "storage.package"],
  });
  const ids = packageClassifiers(manifest);
  assert.deepEqual(ids, ["widget", "command", "sandboxed", "storage"]);

  // A description that names a category the manifest does not declare must not
  // create one: the filter list can only offer what the package really adds.
  const claimsOnly = v2({ display: { name: "Demo", description: "Widgets, commands, network access" } });
  assert.deepEqual(packageClassifiers(claimsOnly), ["sandboxed"]);
});

test("access classifiers track declared capabilities and connections", () => {
  const ids = packageClassifiers(v2({
    capabilities: [
      { name: "network.fetch", origins: ["https://api.example.com"] },
      "auth.connection",
      "clipboard.write",
      { name: "model.generate", modelClasses: ["utility"] },
    ],
    connections: [{
      id: "jira",
      label: "Jira",
      kind: "token",
      origins: ["https://api.example.com"],
    }],
  }));
  assert.deepEqual(ids, [
    "sandboxed",
    "network",
    "credentials",
    "model",
    "clipboard",
  ]);
});

test("runtime classifiers describe how the package actually executes", () => {
  const trusted = v2({ runtime: { kind: "trusted-local", server: "server.ts" } });
  assert.deepEqual(packageClassifiers(trusted), ["server", "trusted"]);
  const headless = v2({ runtime: undefined, capabilities: ["ui.toast"] });
  assert.deepEqual(packageClassifiers(headless), ["sandboxed"]);
  // A capability that is not a package category must not invent one: ui.toast
  // is common to nearly every package, so it is not a filter dimension.
  assert.equal(packageClassifiers(v2({ capabilities: ["ui.toast", "ui.render"] })).includes("notification" as never), false);
});

test("the taxonomy order is stable, grouped, and complete", () => {
  const ids = PACKAGE_CLASSIFIER_ORDER.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  const groups = new Set(PACKAGE_CLASSIFIER_ORDER.map((item) => item.group));
  assert.deepEqual([...groups].sort(), ["access", "adds", "runtime"]);
  const serverOrder = packageClassifiers(v2({
    contributes: { widgets: [{ id: "w", title: "W", description: "W" }] },
    capabilities: [
      "ui.render",
      { name: "network.fetch", origins: ["https://api.example.com"] },
    ],
    connections: [{ id: "c", label: "C", kind: "token", origins: ["https://api.example.com"] }],
  }));
  assert.deepEqual(serverOrder, [...serverOrder].sort((left, right) => ids.indexOf(left) - ids.indexOf(right)));
  // Every produced classifier is a member of the published order, so the UI can
  // always label what the server sends.
  const produced = new Set(classifyPackage(v2({
    contributes: {
      surfaces: [{ id: "s", title: "S" }],
      composerActions: [{ id: "ca", label: "CA" }],
      attachmentProviders: [{ id: "ap", label: "AP" }],
      messageActions: [{ id: "ma", label: "MA" }],
      sessionActions: [{ id: "sa", label: "SA" }],
      commands: [{ id: "c", name: "c", description: "c" }],
      toolRenderers: [{ id: "tr", matcher: { prefix: "x" } }],
      statusBadges: [{ id: "sb", label: "SB" }],
      settingsSections: [{ id: "ss", title: "SS" }],
      contextProviders: [{ id: "cp", label: "CP" }],
      widgets: [{ id: "w", title: "W", description: "W" }],
    },
    capabilities: ["ui.openExternalUrl", "session.read", "project.readMetadata", "attachments.create"],
  })).map((item) => item.id));
  for (const id of produced) assert.ok(ids.includes(id), `${id} is not in PACKAGE_CLASSIFIER_ORDER`);
  assert.ok(produced.size >= 14, `expected a broad taxonomy, got ${produced.size}`);
});
