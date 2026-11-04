#!/usr/bin/env node
// Adds the PolythLiveActivity widget extension (Dynamic Island / Lock Screen
// Live Activity) to the Xcode project: target, file references, build phases,
// configurations, the App dependency and its own embed phase. The App target
// itself already compiles PolythLiveActivityPlugin.swift and the shared
// PolythActivityAttributes.swift (committed); this patch compiles that same
// attributes file into the extension. Idempotent, throws on an unknown project
// shape, and works whether or not configure-ios-notification-service.mjs ran
// first (and leaves that script's anchors intact when it runs afterwards).
//
// POLYTH_IOS_LIVE_ACTIVITY=0 leaves the project untouched, so the app builds
// without the extension (the plugin then reports Live Activities unsupported).
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT = resolve(here, "../ios/App/App.xcodeproj/project.pbxproj");

const PREFIX = "A2D15C0D2F5C";
const id = (n) => `${PREFIX}${n.toString(16).toUpperCase().padStart(12, "0")}`;
export const IDS = {
  widgetRef: id(1),
  plistRef: id(2),
  productRef: id(3),
  group: id(4),
  widgetBuild: id(5),
  attributesBuild: id(6),
  embedBuild: id(7),
  sources: id(8),
  frameworks: id(9),
  resources: id(10),
  target: id(11),
  configList: id(12),
  debug: id(13),
  release: id(14),
  proxy: id(15),
  dependency: id(16),
  embedPhase: id(17),
  entitlementsRef: id(18),
};

// Existing objects of the Capacitor project this patch attaches to.
const APP_TARGET = "504EC3031FED79650016851F";
const PROJECT = "504EC2FC1FED79650016851F";
const MAIN_GROUP_APP = "504EC3061FED79650016851F";
const APP_RESOURCES_PHASE = "504EC3021FED79650016851F";
/** Committed App-group file shared with the extension. */
const ATTRIBUTES_REF = "A2D15C0D2F5A000000000003";

const NAME = "PolythLiveActivity";
const WIDGET = "PolythLiveActivityWidget.swift";
const BUNDLE_ID = "com.polyth.mobile.LiveActivity";
const EMBED = "Embed Live Activity Extension";

function once(source, marker, what) {
  const first = source.indexOf(marker);
  if (first < 0 || source.indexOf(marker, first + 1) >= 0) {
    throw new Error(`Xcode project shape changed (${what}); cannot install ${NAME} safely.`);
  }
  return first;
}

function after(source, marker, text, what) {
  const at = once(source, marker, what) + marker.length;
  return source.slice(0, at) + text + source.slice(at);
}

function before(source, marker, text, what) {
  const at = once(source, marker, what);
  return source.slice(0, at) + text + source.slice(at);
}

/** Adds `objects` to an existing `name` section, or opens that section right
 *  after the end of `anchorSection`. The notification-service patch creates
 *  some of these sections too; reusing them keeps one header per section. */
function intoSection(source, name, objects, anchorSection) {
  const end = `/* End ${name} section */\n`;
  const at = source.indexOf(end);
  if (at >= 0) return source.slice(0, at) + objects + source.slice(at);
  return after(source, `/* End ${anchorSection} section */\n`,
    `\n/* Begin ${name} section */\n${objects}${end}`, `${anchorSection} section end`);
}

/** Rewrites the body of one top-level object, located by its unique header. */
function editObject(source, header, what, edit) {
  const start = once(source, header, what);
  const end = source.indexOf("\n\t\t};\n", start);
  if (end < 0) throw new Error(`Xcode project shape changed (${what} end); cannot install ${NAME} safely.`);
  const body = source.slice(start, end);
  return source.slice(0, start) + edit(body) + source.slice(end);
}

function configuration(objectId, name) {
  const debug = name === "Debug";
  return `\t\t${objectId} /* ${name} */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tAPPLICATION_EXTENSION_API_ONLY = YES;
\t\t\t\tCODE_SIGN_ENTITLEMENTS = ${NAME}/${NAME}.entitlements;
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tINFOPLIST_FILE = ${NAME}/Info.plist;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 16.2;
\t\t\t\tLD_RUNPATH_SEARCH_PATHS = (
\t\t\t\t\t"$(inherited)",
\t\t\t\t\t"@executable_path/Frameworks",
\t\t\t\t\t"@executable_path/../../Frameworks",
\t\t\t\t);
\t\t\t\tMARKETING_VERSION = 1.0;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${BUNDLE_ID};
\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";
\t\t\t\tSKIP_INSTALL = YES;
\t\t\t\tSWIFT_ACTIVE_COMPILATION_CONDITIONS = ${debug ? "DEBUG" : '""'};
\t\t\t\tSWIFT_VERSION = 5.0;
\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";
\t\t\t};
\t\t\tname = ${name};
\t\t};
`;
}

/** Returns the patched project text (identical text when already patched). */
export function patchProject(project) {
  const present = Object.values(IDS).filter((value) => project.includes(value));
  if (present.length === Object.values(IDS).length && project.includes(`${IDS.target} /* ${NAME} */ = {`)) {
    return project;
  }
  if (present.length > 0) {
    throw new Error(`Xcode project is partially patched for ${NAME}; restore project.pbxproj and retry.`);
  }
  once(project, `\t\t${ATTRIBUTES_REF} /* PolythActivityAttributes.swift */ = {isa = PBXFileReference;`, "shared attributes file");

  let p = project;
  p = before(p, "/* End PBXBuildFile section */\n",
    `\t\t${IDS.widgetBuild} /* ${WIDGET} in Sources */ = {isa = PBXBuildFile; fileRef = ${IDS.widgetRef} /* ${WIDGET} */; };\n`
    + `\t\t${IDS.attributesBuild} /* PolythActivityAttributes.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${ATTRIBUTES_REF} /* PolythActivityAttributes.swift */; };\n`
    + `\t\t${IDS.embedBuild} /* ${NAME}.appex in ${EMBED} */ = {isa = PBXBuildFile; fileRef = ${IDS.productRef} /* ${NAME}.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };\n`,
    "PBXBuildFile section");

  p = intoSection(p, "PBXContainerItemProxy", `\t\t${IDS.proxy} /* PBXContainerItemProxy */ = {
\t\t\tisa = PBXContainerItemProxy;
\t\t\tcontainerPortal = ${PROJECT} /* Project object */;
\t\t\tproxyType = 1;
\t\t\tremoteGlobalIDString = ${IDS.target};
\t\t\tremoteInfo = ${NAME};
\t\t};
`, "PBXBuildFile");

  p = intoSection(p, "PBXCopyFilesBuildPhase", `\t\t${IDS.embedPhase} /* ${EMBED} */ = {
\t\t\tisa = PBXCopyFilesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tdstPath = "";
\t\t\tdstSubfolderSpec = 13;
\t\t\tfiles = (
\t\t\t\t${IDS.embedBuild} /* ${NAME}.appex in ${EMBED} */,
\t\t\t);
\t\t\tname = "${EMBED}";
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
`, "PBXContainerItemProxy");

  p = before(p, "/* End PBXFileReference section */\n",
    `\t\t${IDS.widgetRef} /* ${WIDGET} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${WIDGET}; sourceTree = "<group>"; };\n`
    + `\t\t${IDS.plistRef} /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };\n`
    + `\t\t${IDS.entitlementsRef} /* ${NAME}.entitlements */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = ${NAME}.entitlements; sourceTree = "<group>"; };\n`
    + `\t\t${IDS.productRef} /* ${NAME}.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = ${NAME}.appex; sourceTree = BUILT_PRODUCTS_DIR; };\n`,
    "PBXFileReference section");

  p = before(p, "/* End PBXFrameworksBuildPhase section */\n",
    `\t\t${IDS.frameworks} /* Frameworks */ = {
\t\t\tisa = PBXFrameworksBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
`, "PBXFrameworksBuildPhase section");

  // Groups: the extension folder beside App, its product beside App.app.
  p = after(p, `\t\t\t\t${MAIN_GROUP_APP} /* App */,\n`,
    `\t\t\t\t${IDS.group} /* ${NAME} */,\n`, "main group children");
  p = after(p, `\t\t\t\t504EC3041FED79650016851F /* App.app */,\n`,
    `\t\t\t\t${IDS.productRef} /* ${NAME}.appex */,\n`, "Products group children");
  p = before(p, "/* End PBXGroup section */\n",
    `\t\t${IDS.group} /* ${NAME} */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t${IDS.widgetRef} /* ${WIDGET} */,
\t\t\t\t${IDS.plistRef} /* Info.plist */,
\t\t\t\t${IDS.entitlementsRef} /* ${NAME}.entitlements */,
\t\t\t);
\t\t\tpath = ${NAME};
\t\t\tsourceTree = "<group>";
\t\t};
`, "PBXGroup section");

  // App target: the embed phase goes before Resources and the dependency at
  // the head of the list, which keeps the notification-service anchors
  // ("Resources */,\n\t\t\t);\n...dependencies = (\n") byte-identical.
  p = editObject(p, `\t\t${APP_TARGET} /* App */ = {\n\t\t\tisa = PBXNativeTarget;\n`, "App PBXNativeTarget", (body) => {
    let next = before(body, `\t\t\t\t${APP_RESOURCES_PHASE} /* Resources */,\n`,
      `\t\t\t\t${IDS.embedPhase} /* ${EMBED} */,\n`, "App target buildPhases");
    next = after(next, "\t\t\tdependencies = (\n", `\t\t\t\t${IDS.dependency} /* PBXTargetDependency */,\n`, "App target dependencies");
    return next;
  });
  p = before(p, "/* End PBXNativeTarget section */\n",
    `\t\t${IDS.target} /* ${NAME} */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${IDS.configList} /* Build configuration list for PBXNativeTarget "${NAME}" */;
\t\t\tbuildPhases = (
\t\t\t\t${IDS.sources} /* Sources */,
\t\t\t\t${IDS.frameworks} /* Frameworks */,
\t\t\t\t${IDS.resources} /* Resources */,
\t\t\t);
\t\t\tbuildRules = (
\t\t\t);
\t\t\tdependencies = (
\t\t\t);
\t\t\tname = ${NAME};
\t\t\tproductName = ${NAME};
\t\t\tproductReference = ${IDS.productRef} /* ${NAME}.appex */;
\t\t\tproductType = "com.apple.product-type.app-extension";
\t\t};
`, "PBXNativeTarget section");

  p = after(p, `\t\t\t\t\t${APP_TARGET} = {\n\t\t\t\t\t\tCreatedOnToolsVersion = 9.2;\n\t\t\t\t\t\tLastSwiftMigration = 1100;\n\t\t\t\t\t\tProvisioningStyle = Automatic;\n\t\t\t\t\t};\n`,
    `\t\t\t\t\t${IDS.target} = {\n\t\t\t\t\t\tCreatedOnToolsVersion = 15.0;\n\t\t\t\t\t\tProvisioningStyle = Automatic;\n\t\t\t\t\t};\n`, "TargetAttributes");
  p = after(p, `\t\t\ttargets = (\n\t\t\t\t${APP_TARGET} /* App */,\n`,
    `\t\t\t\t${IDS.target} /* ${NAME} */,\n`, "project targets");

  p = before(p, "/* End PBXResourcesBuildPhase section */\n",
    `\t\t${IDS.resources} /* Resources */ = {
\t\t\tisa = PBXResourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
`, "PBXResourcesBuildPhase section");

  p = before(p, "/* End PBXSourcesBuildPhase section */\n",
    `\t\t${IDS.sources} /* Sources */ = {
\t\t\tisa = PBXSourcesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (
\t\t\t\t${IDS.widgetBuild} /* ${WIDGET} in Sources */,
\t\t\t\t${IDS.attributesBuild} /* PolythActivityAttributes.swift in Sources */,
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
`, "PBXSourcesBuildPhase section");
  p = intoSection(p, "PBXTargetDependency", `\t\t${IDS.dependency} /* PBXTargetDependency */ = {
\t\t\tisa = PBXTargetDependency;
\t\t\ttarget = ${IDS.target} /* ${NAME} */;
\t\t\ttargetProxy = ${IDS.proxy} /* PBXContainerItemProxy */;
\t\t};
`, "PBXSourcesBuildPhase");

  p = before(p, "/* End XCBuildConfiguration section */\n",
    configuration(IDS.debug, "Debug") + configuration(IDS.release, "Release"), "XCBuildConfiguration section");
  p = before(p, "/* End XCConfigurationList section */\n",
    `\t\t${IDS.configList} /* Build configuration list for PBXNativeTarget "${NAME}" */ = {
\t\t\tisa = XCConfigurationList;
\t\t\tbuildConfigurations = (
\t\t\t\t${IDS.debug} /* Debug */,
\t\t\t\t${IDS.release} /* Release */,
\t\t\t);
\t\t\tdefaultConfigurationIsVisible = 0;
\t\t\tdefaultConfigurationName = Release;
\t\t};
`, "XCConfigurationList section");
  return p;
}

export async function configureLiveActivity({ projectPath = DEFAULT_PROJECT, env = process.env } = {}) {
  if (env.POLYTH_IOS_LIVE_ACTIVITY === "0") {
    console.warn("configure-ios-live-activity: POLYTH_IOS_LIVE_ACTIVITY=0, building the app without the Live Activity extension.");
    return false;
  }
  const project = await readFile(projectPath, "utf8");
  const patched = patchProject(project);
  if (patched === project) return false;
  await writeFile(projectPath, patched);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await configureLiveActivity({ projectPath: process.argv[2] ? resolve(process.argv[2]) : DEFAULT_PROJECT });
}
