import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const liveActivity = fileURLToPath(new URL("../scripts/configure-ios-live-activity.mjs", import.meta.url));
const notificationService = fileURLToPath(new URL("../scripts/configure-ios-notification-service.mjs", import.meta.url));
const realProject = fileURLToPath(new URL("../ios/App/App.xcodeproj/project.pbxproj", import.meta.url));
const iosApp = fileURLToPath(new URL("../ios/App/", import.meta.url));

const APP_TARGET = "504EC3031FED79650016851F";
const ATTRIBUTES_REF = "A2D15C0D2F5A000000000003";

async function withProject<T>(body: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "polyth-pbx-la-"));
  try {
    const path = join(dir, "project.pbxproj");
    await copyFile(realProject, path);
    return await body(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function configure(script: string, path: string, env: Record<string, string> = {}) {
  return run(process.execPath, [script, path], {
    env: { ...process.env, POLYTH_IOS_NOTIFICATION_SERVICE: "", POLYTH_IOS_LIVE_ACTIVITY: "", ...env },
  });
}

/** Splits the objects section into id -> body (top-level entries only). */
function objects(text: string): Map<string, string> {
  const start = text.indexOf("objects = {\n") + "objects = {\n".length;
  const end = text.indexOf("\n\t};\n\trootObject");
  const found = new Map<string, string>();
  let current: string | null = null;
  let body: string[] = [];
  for (const line of text.slice(start, end).split("\n")) {
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

function assertClosedGraph(text: string): Map<string, string> {
  const all = objects(text);
  const root = /rootObject = ([0-9A-F]{24})/.exec(text)![1];
  for (const ref of new Set(text.match(/\b[0-9A-F]{24}\b/g))) {
    assert.ok(ref === root || all.has(ref), `dangling reference ${ref}`);
  }
  return all;
}

/** App embeds `appex` through a Plug-Ins copy phase and depends on its target. */
function assertEmbedded(all: Map<string, string>, appex: string): string {
  const app = all.get(APP_TARGET)!;
  const phases = /buildPhases = \(\n((?:\t+[0-9A-F]{24}.*\n)*)/.exec(app)![1];
  const phaseIds = [...phases.matchAll(/([0-9A-F]{24})/g)].map((match) => match[1]);
  const embed = phaseIds.map((phase) => all.get(phase)!).find((body) => body.includes(`/* ${appex}.appex in `));
  assert.ok(embed, `${appex} is not in an App build phase`);
  assert.match(embed, /isa = PBXCopyFilesBuildPhase;/);
  assert.match(embed, /dstSubfolderSpec = 13;/);
  const buildFileId = new RegExp(`([0-9A-F]{24}) /\\* ${appex}\\.appex in `).exec(embed)![1];
  const productId = /fileRef = ([0-9A-F]{24})/.exec(all.get(buildFileId)!)![1];
  const target = [...all.values()].find((body) => body.includes("isa = PBXNativeTarget;") && body.includes(`productReference = ${productId}`));
  assert.ok(target, `no target produces ${appex}`);
  const targetId = /^\t\t([0-9A-F]{24})/.exec(target)![1];
  const dependencies = /dependencies = \(\n((?:\t+[0-9A-F]{24}.*\n)*)/.exec(app)![1];
  const dependsOn = [...dependencies.matchAll(/([0-9A-F]{24})/g)]
    .map((match) => all.get(match[1])!)
    .some((dep) => dep.includes(`target = ${targetId}`));
  assert.ok(dependsOn, `App does not depend on ${appex}`);
  return target;
}

test("the Live Activity patch is idempotent and opt-out leaves the project byte-identical", async () => {
  await withProject(async (path) => {
    await configure(liveActivity, path);
    const once = await readFile(path, "utf8");
    assert.notEqual(once, await readFile(realProject, "utf8"));
    await configure(liveActivity, path);
    assert.equal(await readFile(path, "utf8"), once);
  });
  await withProject(async (path) => {
    await configure(liveActivity, path, { POLYTH_IOS_LIVE_ACTIVITY: "0" });
    assert.equal(await readFile(path, "utf8"), await readFile(realProject, "utf8"));
  });
});

test("the extension target compiles the widget and the App's shared attributes", async () => {
  await withProject(async (path) => {
    await configure(liveActivity, path);
    const text = await readFile(path, "utf8");
    const all = assertClosedGraph(text);
    const added = [...all.keys()].filter((key) => key.startsWith("A2D15C0D2F5C"));
    assert.equal(added.length, 17);
    for (const key of added) assert.ok(text.split(key).length - 1 >= 2, `${key} is defined but never referenced`);

    const target = assertEmbedded(all, "PolythLiveActivity");
    assert.match(target, /productType = "com\.apple\.product-type\.app-extension";/);
    const sourcesId = /buildPhases = \(\n\t+([0-9A-F]{24}) \/\* Sources \*\//.exec(target)![1];
    const sources = all.get(sourcesId)!;
    const compiled = [...sources.matchAll(/^\t{4}([0-9A-F]{24}) /gm)].map((match) => /fileRef = ([0-9A-F]{24})/.exec(all.get(match[1])!)![1]);
    assert.ok(compiled.includes(ATTRIBUTES_REF), "the extension must compile the App's PolythActivityAttributes.swift");
    assert.equal(compiled.length, 2);

    const configList = /buildConfigurationList = ([0-9A-F]{24})/.exec(target)![1];
    const configs = [...all.get(configList)!.matchAll(/^\t{4}([0-9A-F]{24}) \/\*/gm)].map((match) => all.get(match[1])!);
    assert.equal(configs.length, 2);
    for (const config of configs) {
      assert.match(config, /PRODUCT_BUNDLE_IDENTIFIER = com\.polyth\.mobile\.LiveActivity;/);
      assert.match(config, /IPHONEOS_DEPLOYMENT_TARGET = 16\.2;/);
      assert.match(config, /INFOPLIST_FILE = PolythLiveActivity\/Info\.plist;/);
    }
    for (const file of ["PolythLiveActivity/PolythLiveActivityWidget.swift", "PolythLiveActivity/Info.plist", "App/PolythActivityAttributes.swift"]) {
      await readFile(join(iosApp, file), "utf8");
    }
  });
});

test("Live Activity and Notification Service patches compose in either order", async () => {
  for (const order of [[notificationService, liveActivity], [liveActivity, notificationService]]) {
    await withProject(async (path) => {
      for (const script of order) await configure(script, path);
      const text = await readFile(path, "utf8");
      const all = assertClosedGraph(text);
      assertEmbedded(all, "PolythLiveActivity");
      assertEmbedded(all, "NotificationService");
      assert.match(text, /targets = \(\n\t+504EC3031FED79650016851F \/\* App \*\/,\n(\t+[0-9A-F]{24} \/\* (NotificationService|PolythLiveActivity) \*\/,\n){2}\t+\);/);
      // Re-running both is still a no-op.
      for (const script of order) await configure(script, path);
      assert.equal(await readFile(path, "utf8"), text);
    });
  }
});

test("a project of an unknown shape is refused, not guessed", async () => {
  await withProject(async (path) => {
    await writeFile(path, (await readFile(realProject, "utf8")).replace("/* End PBXGroup section */", "/* End PBXGroup section changed */"));
    await assert.rejects(configure(liveActivity, path), /shape changed/);
  });
});

test("the Live Activity draws Polyth's mark in every presentation", async () => {
  const widget = await readFile(join(iosApp, "PolythLiveActivity/PolythLiveActivityWidget.swift"), "utf8");
  // One filled outline, so a gradient or a state colour applies to the whole ribbon.
  assert.match(widget, /struct PolythMark: Shape/);
  assert.match(widget, /\.subtracting\(cut\.cgPath\)\.union\(tail\.cgPath\)/);
  // The app icon's colours, not a system tint.
  for (const hex of ["0x16E0F7", "0x2B5CFF", "0x6A2BFF", "0xE45CF2"]) assert.ok(widget.includes(`rgb(${hex})`), hex);
  // The brand leads every presentation; state glyphs sit beside it, never instead of it.
  for (const slot of ["compactLeading", "minimal"]) {
    assert.match(widget, new RegExp(`\\} ${slot}: \\{\\n\\s+Mark\\(`), `${slot} must draw the mark`);
  }
  assert.match(widget, /DynamicIslandExpandedRegion\(\.leading\) \{\n\s+Mark\(/);
  assert.match(widget, /struct LockScreen[\s\S]*?HStack\(alignment: \.top, spacing: 12\) \{\n\s+Mark\(/);
});

test("the App declares, registers and gates the Live Activity plugin", async () => {
  const plist = await readFile(join(iosApp, "App/Info.plist"), "utf8");
  assert.match(plist, /<key>NSSupportsLiveActivities<\/key>\s*<true\/>/);
  const scene = await readFile(join(iosApp, "App/SceneDelegate.swift"), "utf8");
  assert.match(scene, /registerPluginInstance\(PolythLiveActivityPlugin\(\)\)/);
  const plugin = await readFile(join(iosApp, "App/PolythLiveActivityPlugin.swift"), "utf8");
  assert.match(plugin, /let jsName = "PolythLiveActivity"/);
  // Only the bundled shell or the current Link proxy page may write to the Lock Screen.
  assert.match(plugin, /PolythLinkPlugin\.ownsCurrentProxy\(url\)/);
  assert.doesNotMatch(plugin, /pushType: \.token/);
  const extension = await readFile(join(iosApp, "PolythLiveActivity/Info.plist"), "utf8");
  assert.match(extension, /<string>com\.apple\.widgetkit-extension<\/string>/);
});

test("the activity turns stale when the page's confirmation runs out, and stale work draws no clock", async () => {
  const plugin = await readFile(join(iosApp, "App/PolythLiveActivityPlugin.swift"), "utf8");
  // The page names the stale date; native only bounds it (never past 15 minutes).
  assert.match(plugin, /Self\.staleDate\(call\.getDouble\("staleAt"\)\)/);
  assert.match(plugin, /min\(max\(Date\(timeIntervalSince1970: ms \/ 1000\), now\), latest\)/);
  assert.match(plugin, /ActivityContent\(state: state, staleDate: staleDate\)/);
  assert.doesNotMatch(plugin, /if current\.content\.state != state/, "a heartbeat with unchanged content must still move the stale date");
  const widget = await readFile(join(iosApp, "PolythLiveActivity/PolythLiveActivityWidget.swift"), "utf8");
  assert.match(widget, /if state\.state == "working", !stale, let startedAt = state\.startedAt \{\n\s+Text\(timerInterval:/);
  for (const use of ["Trailing(state: state, stale: stale)", "Trailing(state: context.state, stale: context.isStale)", "CompactTrailing(state: context.state, stale: context.isStale)"]) {
    assert.ok(widget.includes(use), use);
  }
});
