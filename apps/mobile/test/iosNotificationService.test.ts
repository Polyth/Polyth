import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/configure-ios-notification-service.mjs", import.meta.url));
const realProject = fileURLToPath(new URL("../ios/App/App.xcodeproj/project.pbxproj", import.meta.url));
const iosApp = fileURLToPath(new URL("../ios/App/", import.meta.url));

const APP_TARGET = "504EC3031FED79650016851F";

async function withProject<T>(body: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "polyth-pbx-"));
  try {
    const path = join(dir, "project.pbxproj");
    await copyFile(realProject, path);
    return await body(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function configure(path: string, env: Record<string, string> = {}) {
  return run(process.execPath, [script, path], { env: { ...process.env, POLYTH_IOS_NOTIFICATION_SERVICE: "", ...env } });
}

/** Splits the objects section into id -> body (top-level entries only). */
function objects(text: string): Map<string, string> {
  const start = text.indexOf("objects = {\n") + "objects = {\n".length;
  const end = text.indexOf("\n\t};\n\trootObject");
  const section = text.slice(start, end).split("\n");
  const found = new Map<string, string>();
  let current: string | null = null;
  let body: string[] = [];
  for (const line of section) {
    const open = /^\t\t([0-9A-F]{24}) .*= \{(.*)$/.exec(line);
    if (current === null && open) {
      if (/\};\s*$/.test(line)) {
        assert.ok(!found.has(open[1]), `duplicate object ${open[1]}`);
        found.set(open[1], line);
      } else {
        current = open[1];
        body = [line];
      }
    } else if (current !== null) {
      body.push(line);
      if (line === "\t\t};") {
        assert.ok(!found.has(current), `duplicate object ${current}`);
        found.set(current, body.join("\n"));
        current = null;
      }
    }
  }
  assert.equal(current, null, "unterminated object");
  return found;
}

test("the extension patch is idempotent", async () => {
  await withProject(async (path) => {
    await configure(path);
    const once = await readFile(path, "utf8");
    assert.notEqual(once, await readFile(realProject, "utf8"));
    await configure(path);
    assert.equal(await readFile(path, "utf8"), once);
  });
});

test("POLYTH_IOS_NOTIFICATION_SERVICE=0 leaves the project byte-identical", async () => {
  await withProject(async (path) => {
    await configure(path, { POLYTH_IOS_NOTIFICATION_SERVICE: "0" });
    assert.equal(await readFile(path, "utf8"), await readFile(realProject, "utf8"));
  });
});

test("every new object is defined once and nothing dangles", async () => {
  await withProject(async (path) => {
    await configure(path);
    const text = await readFile(path, "utf8");
    const all = objects(text);
    const added = [...all.keys()].filter((key) => key.startsWith("A2D15C0D2F5B"));
    assert.equal(added.length, 17);

    // Every 24-hex id referenced anywhere resolves to a defined object (or the root).
    const root = /rootObject = ([0-9A-F]{24})/.exec(text)![1];
    for (const ref of new Set(text.match(/\b[0-9A-F]{24}\b/g))) {
      assert.ok(ref === root || all.has(ref), `dangling reference ${ref}`);
    }
    // Every new object is reachable from somewhere other than its own definition.
    for (const key of added) {
      const mentions = text.split(key).length - 1;
      assert.ok(mentions >= 2, `${key} is defined but never referenced`);
    }
  });
});

test("App depends on and embeds the extension", async () => {
  await withProject(async (path) => {
    await configure(path);
    const text = await readFile(path, "utf8");
    const all = objects(text);
    const app = all.get(APP_TARGET)!;
    const dependency = /dependencies = \(\n((?:\t+[0-9A-F]{24}.*\n)*)/.exec(app)![1];
    const depId = /([0-9A-F]{24})/.exec(dependency)![1];
    const dep = all.get(depId)!;
    assert.match(dep, /isa = PBXTargetDependency;/);
    const targetId = /target = ([0-9A-F]{24})/.exec(dep)![1];
    const proxyId = /targetProxy = ([0-9A-F]{24})/.exec(dep)![1];
    const target = all.get(targetId)!;
    assert.match(target, /productType = "com\.apple\.product-type\.app-extension";/);
    assert.match(all.get(proxyId)!, new RegExp(`remoteGlobalIDString = ${targetId};`));

    // The embed phase is on App, targets the Plug-Ins folder and copies the appex.
    const phases = /buildPhases = \(\n((?:\t+[0-9A-F]{24}.*\n)*)/.exec(app)![1];
    const embedId = [...phases.matchAll(/([0-9A-F]{24}) \/\* Embed Foundation Extensions \*\//g)][0][1];
    const embed = all.get(embedId)!;
    assert.match(embed, /isa = PBXCopyFilesBuildPhase;/);
    assert.match(embed, /dstSubfolderSpec = 13;/);
    const buildFileId = /([0-9A-F]{24}) \/\* NotificationService\.appex in Embed/.exec(embed)![1];
    const productId = /fileRef = ([0-9A-F]{24})/.exec(all.get(buildFileId)!)![1];
    assert.match(all.get(productId)!, /path = NotificationService\.appex;/);
    assert.match(target, new RegExp(`productReference = ${productId}`));

    // Project lists the target; bundle id and deployment target match the contract.
    assert.match(text, new RegExp(`targets = \\(\\n\\t+${APP_TARGET} /\\* App \\*/,\\n\\t+${targetId} /\\* NotificationService \\*/,`));
    const configList = /buildConfigurationList = ([0-9A-F]{24})/.exec(target)![1];
    const configs = [...all.get(configList)!.matchAll(/^\t{4}([0-9A-F]{24}) \/\*/gm)].map((m) => all.get(m[1])!);
    assert.equal(configs.length, 2);
    for (const config of configs) {
      assert.match(config, /PRODUCT_BUNDLE_IDENTIFIER = com\.polyth\.mobile\.NotificationService;/);
      assert.match(config, /IPHONEOS_DEPLOYMENT_TARGET = 15\.0;/);
      assert.match(config, /INFOPLIST_FILE = NotificationService\/Info\.plist;/);
      assert.match(config, /CODE_SIGN_ENTITLEMENTS = NotificationService\/NotificationService\.entitlements;/);
    }
    // The sources the project names exist on disk.
    for (const file of ["NotificationService.swift", "Info.plist", "NotificationService.entitlements"]) {
      await readFile(join(iosApp, "NotificationService", file), "utf8");
    }
  });
});

test("a project of an unknown shape is refused, not guessed", async () => {
  await withProject(async (path) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, (await readFile(realProject, "utf8")).replace("/* End PBXGroup section */", "/* End PBXGroup section changed */"));
    await assert.rejects(configure(path), /shape changed/);
  });
});

test("the entitlements keep the app's own keychain group first", async () => {
  const app = await readFile(join(iosApp, "App/App.entitlements"), "utf8");
  const groups = [...app.matchAll(/<string>(\$\(AppIdentifierPrefix\)[^<]+)<\/string>/g)].map((m) => m[1]);
  assert.deepEqual(groups, ["$(AppIdentifierPrefix)com.polyth.mobile", "$(AppIdentifierPrefix)com.polyth.mobile.push-content"]);
  const extension = await readFile(join(iosApp, "NotificationService/NotificationService.entitlements"), "utf8");
  assert.match(extension, /\$\(AppIdentifierPrefix\)com\.polyth\.mobile\.push-content/);
  for (const plist of ["App/Info.plist", "NotificationService/Info.plist"]) {
    assert.match(await readFile(join(iosApp, plist), "utf8"), /<key>AppIdentifierPrefix<\/key>\s*<string>\$\(AppIdentifierPrefix\)<\/string>/);
  }
});
