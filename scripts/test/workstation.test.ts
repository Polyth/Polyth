import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  WORKSTATION_FLAVOR,
  asarFiles,
  assertWorkstationPackage,
  resourcesDirOf,
  sha256Sums,
  workstationBuildConfig,
  workstationBuilderArgs,
  workstationPackageIds,
  workstationSbom,
} from "../ci/workstation.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** A small repository: workstation package `ws`, feature package `other`, library `lib`. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workstation-"));
  const put = (path: string, content: unknown) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content));
  };
  put("packages/ws/package.json", { name: "@polyth/ws", polyth: { serverEntry: "./x.ts", editions: ["workstation"] } });
  put("packages/other/package.json", { name: "@polyth/other", polyth: { serverEntry: "./x.ts" } });
  put("packages/lib/package.json", { name: "@polyth/lib" });
  put("node_modules/left-pad/package.json", { name: "left-pad", version: "1.3.0", license: "WTFPL" });
  put("node_modules/@scope/pkg/package.json", { name: "@scope/pkg", version: "2.0.1" });
  put("node_modules/playwright-core/package.json", { name: "playwright-core", version: "1.0.0" });
  put("apps/desktop/package.json", {
    version: "1.2.3",
    devDependencies: { electron: "^44.9.3" },
    build: {
      productName: "Polyth",
      files: ["dist/**/*"],
      extraResources: [
        { from: "../web/dist", to: "web" },
        { from: "resources/chromium/${platform}-${arch}", to: "chromium/${platform}-${arch}" },
        { from: "../../packages", to: "packages", filter: ["*/dist/web/**/*", "*/assets/**/*"] },
        { from: "resources/polyth-link", to: "polyth-link", filter: ["polyth-link-host"] },
        { from: "build/icon.png", to: "icon.png" },
      ],
      publish: { provider: "github", owner: "Polyth", repo: "Polyth", releaseType: "release" },
    },
  });
  put("apps/desktop/opencode.json", { version: "2.0.16", repository: "anomalyco/opencode" });
  const metafile = (inputs: string[], externals: string[] = []) => {
    put("apps/desktop/build-meta/main.metafile.json", {
      inputs: Object.fromEntries(inputs.map((input) => [input, { bytes: 1 }])),
      outputs: { "dist/main.js": { imports: externals.map((path) => ({ path, kind: "import-statement", external: true })) } },
    });
    return join(root, "apps/desktop/build-meta/main.metafile.json");
  };
  const resources = (...paths: string[]) => {
    mkdirSync(join(root, "out/resources"), { recursive: true });
    for (const path of paths) put(join("out/resources", path), "x");
    return join(root, "out/resources");
  };
  return { root, put, metafile, resources, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** @electron/asar's createPackage, or a minimal writer of the same format: a
 *  pickle with the header pickle's size, then a pickle holding the JSON tree. */
async function asarWriter(): Promise<(dir: string, out: string) => Promise<void>> {
  for (const candidate of [join(REPO, "tools/release/node_modules/@electron/asar/lib/asar.js"), join(REPO, "node_modules/@electron/asar/lib/asar.js")]) {
    if (existsSync(candidate)) return ((await import(pathToFileURL(candidate).href)) as { createPackage: (dir: string, out: string) => Promise<void> }).createPackage;
  }
  return async (dir, out) => {
    const tree = (path: string): { files: Record<string, unknown> } => ({
      files: Object.fromEntries(readdirSync(path, { withFileTypes: true }).map((entry) =>
        [entry.name, entry.isDirectory() ? tree(join(path, entry.name)) : { size: 1, offset: "0" }])),
    });
    const json = Buffer.from(JSON.stringify(tree(dir)));
    const padded = Math.ceil(json.length / 4) * 4;
    const header = Buffer.alloc(16 + padded);
    header.writeUInt32LE(4, 0);
    header.writeUInt32LE(8 + padded, 4);
    header.writeUInt32LE(4 + padded, 8);
    header.writeUInt32LE(json.length, 12);
    json.copy(header, 16);
    writeFileSync(out, header);
  };
}

const CLEAN_INPUTS = ["../../packages/ws/src/a.ts", "../../packages/lib/src/b.ts", "../../node_modules/left-pad/index.js"];

test("workstation package ids come from polyth.editions, sorted", () => {
  const f = fixture();
  try {
    assert.deepEqual(workstationPackageIds(f.root), ["ws"]);
    f.put("packages/aa/package.json", { polyth: { editions: ["workstation"] } });
    assert.deepEqual(workstationPackageIds(f.root), ["aa", "ws"]);
  } finally {
    f.done();
  }
  const real = workstationPackageIds(REPO);
  assert.ok(real.length > 0 && real.includes("backend-claude"), real.join(","));
  assert.deepEqual(real, [...real].sort());
});

test("the derived electron-builder config drops Chromium and Link and narrows packages", () => {
  const f = fixture();
  try {
    const file = join(f.root, "eb.json");
    assert.deepEqual(workstationBuilderArgs({ repoRoot: f.root, file, packageIds: ["ws", "aa"] }), ["--config", file]);
    const config = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(config.artifactName, "${productName}-${version}-${os}-${arch}-workstation.${ext}");
    assert.deepEqual(config.extraResources.map((entry: { to: string }) => entry.to), ["web", "packages", "icon.png"]);
    assert.deepEqual(config.extraResources[1].filter, ["ws/dist/web/**/*", "ws/assets/**/*", "aa/dist/web/**/*", "aa/assets/**/*"]);
    assert.deepEqual(config.files, ["dist/**/*", "!**/node_modules/playwright-core/**"]);
    assert.deepEqual(config.publish, { provider: "github", owner: "Polyth", repo: "Polyth", releaseType: "release", channel: "workstation" });
    assert.equal(config.productName, "Polyth");
  } finally {
    f.done();
  }
  // The real configuration: nothing but the edition survives.
  const base = JSON.parse(readFileSync(join(REPO, "apps/desktop/package.json"), "utf8")).build;
  const config = workstationBuildConfig(base, { packageIds: ["backend-claude"] });
  const targets = config.extraResources.map((entry: { to: string }) => entry.to);
  assert.ok(!targets.some((to: string) => to.startsWith("chromium") || to.startsWith("polyth-link")), targets.join(","));
  assert.ok(targets.includes("opencode/${platform}-${arch}") && targets.includes("web"));
  assert.equal(base.artifactName.includes("workstation"), false, "the base config is not mutated");
  assert.equal(base.extraResources.some((entry: { to: string }) => entry.to === "chromium/${platform}-${arch}"), true);
});

test("the package check passes a clean workstation package", () => {
  const f = fixture();
  try {
    const resources = f.resources("packages/ws/dist/web/index.js", "web/index.html");
    assert.doesNotThrow(() => assertWorkstationPackage({ resourcesDir: resources, metafilePath: f.metafile(CLEAN_INPUTS), packageIds: ["ws"], repoRoot: f.root }));
    // An .app/win-unpacked layout resolves its resources directory.
    assert.equal(resourcesDirOf(join(f.root, "out")), resources);
    mkdirSync(join(f.root, "mac/Polyth.app/Contents/Resources"), { recursive: true });
    assert.equal(resourcesDirOf(join(f.root, "mac")), join(f.root, "mac/Polyth.app/Contents/Resources"));
  } finally {
    f.done();
  }
});

test("the package check fails on every forbidden payload", () => {
  const cases: Array<[string, string[], string[], RegExp]> = [
    ["chromium", ["chromium/darwin-arm64/chrome"], CLEAN_INPUTS, /resources\/chromium is packaged/],
    ["link", ["polyth-link/polyth-link-host"], CLEAN_INPUTS, /resources\/polyth-link holds polyth-link-host/],
    ["foreign package resources", ["packages/other/dist/web/x.js"], CLEAN_INPUTS, /resources\/packages\/other is not a workstation package/],
    ["foreign feature package in the bundle", [], [...CLEAN_INPUTS, "../../packages/other/src/serverEntry.ts"], /main bundle includes packages\/other/],
    ["playwright-core in the bundle", [], [...CLEAN_INPUTS, "../../node_modules/playwright-core/lib/index.js"], /main bundle includes or imports playwright-core/],
  ];
  for (const [label, files, inputs, message] of cases) {
    const f = fixture();
    try {
      const resources = f.resources("web/index.html", ...files);
      assert.throws(
        () => assertWorkstationPackage({ resourcesDir: resources, metafilePath: f.metafile(inputs), packageIds: ["ws"], repoRoot: f.root }),
        message,
        label,
      );
    } finally {
      f.done();
    }
  }
  // Framework libraries without a server entry are allowed; an empty polyth-link directory is fine.
  const f = fixture();
  try {
    const resources = f.resources("web/index.html");
    mkdirSync(join(resources, "polyth-link"));
    assert.doesNotThrow(() => assertWorkstationPackage({
      resourcesDir: resources, metafilePath: f.metafile([...CLEAN_INPUTS, "../../packages/lib/src/c.ts"]), packageIds: ["ws"], repoRoot: f.root,
    }));
  } finally {
    f.done();
  }
});

test("the SBOM is CycloneDX 1.5 with bundled packages, Electron and OpenCode", () => {
  const f = fixture();
  try {
    const metafile = f.metafile([
      ...CLEAN_INPUTS, "../../node_modules/left-pad/lib/other.js", "../../node_modules/@scope/pkg/dist/i.js",
      "../../node_modules/missing/index.js", "desktop-server-packages:virtual",
    ]);
    const sbom = workstationSbom({ metafilePath: metafile, repoRoot: f.root, version: "1.2.3", timestamp: "2026-11-09T00:00:00.000Z" });
    assert.equal(sbom.bomFormat, "CycloneDX");
    assert.equal(sbom.specVersion, "1.5");
    assert.match(sbom.serialNumber, /^urn:uuid:[0-9a-f-]{36}$/);
    assert.equal(sbom.metadata.component.version, "1.2.3");
    const byName = Object.fromEntries(sbom.components.map((c: { name: string }) => [c.name, c]));
    assert.deepEqual(Object.keys(byName).sort(), ["@scope/pkg", "electron", "left-pad", "missing", "opencode"]);
    assert.equal(byName["left-pad"].purl, "pkg:npm/left-pad@1.3.0");
    assert.deepEqual(byName["left-pad"].licenses, [{ expression: "WTFPL" }]);
    assert.equal(byName["@scope/pkg"].purl, "pkg:npm/%40scope/pkg@2.0.1");
    assert.equal(byName.electron.version, "44.9.3");
    assert.equal(byName.opencode.version, "2.0.16");
    assert.equal(sbom.components.filter((c: { name: string }) => c.name === "left-pad").length, 1);
    assert.ok(!("version" in byName.missing));
  } finally {
    f.done();
  }
});

test("sha256Sums writes sha256sum format sorted by name", () => {
  const f = fixture();
  try {
    f.put("b.txt", "b");
    f.put("a.txt", "abc");
    const text = sha256Sums([join(f.root, "b.txt"), join(f.root, "a.txt")]);
    assert.equal(text, [
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  a.txt",
      "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d  b.txt",
      "",
    ].join("\n"));
  } finally {
    f.done();
  }
  assert.equal(WORKSTATION_FLAVOR, "workstation");
});

test("the package check sees an external playwright-core import and one shipped in app.asar", async () => {
  const f = fixture();
  try {
    const resources = f.resources("web/index.html");
    assert.throws(() => assertWorkstationPackage({
      resourcesDir: resources, metafilePath: f.metafile(CLEAN_INPUTS, ["electron", "playwright-core"]), packageIds: ["ws"], repoRoot: f.root,
    }), /imports playwright-core/);
    assert.doesNotThrow(() => assertWorkstationPackage({
      resourcesDir: resources, metafilePath: f.metafile(CLEAN_INPUTS, ["electron", "electron-updater"]), packageIds: ["ws"], repoRoot: f.root,
    }));

    // An archive written by @electron/asar (electron-builder's own writer) when
    // the release tools are installed, else by the format's own layout.
    const createPackage = await asarWriter();
    const app = join(f.root, "app");
    f.put("app/dist/main.js", "x");
    f.put("app/node_modules/ok/index.js", "x");
    await createPackage(app, join(resources, "app.asar"));
    assert.deepEqual(asarFiles(join(resources, "app.asar")).sort(), ["dist/main.js", "node_modules/ok/index.js"]);
    assert.doesNotThrow(() => assertWorkstationPackage({ resourcesDir: resources, metafilePath: f.metafile(CLEAN_INPUTS), packageIds: ["ws"], repoRoot: f.root }));

    f.put("app/node_modules/playwright-core/index.js", "x");
    await createPackage(app, join(resources, "app.asar"));
    assert.throws(() => assertWorkstationPackage({ resourcesDir: resources, metafilePath: f.metafile(CLEAN_INPUTS), packageIds: ["ws"], repoRoot: f.root }),
      /app\.asar ships node_modules\/playwright-core/);
  } finally {
    f.done();
  }
});
