#!/usr/bin/env node
// Adds the Notification Service Extension (sealed push content) to the Xcode
// project: target, file references, build phases, configurations, the App
// dependency and the "Embed Foundation Extensions" phase. Idempotent, and it
// throws when the project shape is not the one it knows. Following
// configure-ios-polyth-link.mjs it is applied at build time (native:ios).
//
// POLYTH_IOS_NOTIFICATION_SERVICE=0 leaves the project untouched, so the app
// builds without the extension (signed nightlies use this when the extension's
// App Store signing files cannot be fetched).
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT = resolve(here, "../ios/App/App.xcodeproj/project.pbxproj");

const PREFIX = "A2D15C0D2F5B";
const id = (n) => `${PREFIX}${n.toString(16).toUpperCase().padStart(12, "0")}`;
export const IDS = {
  swiftRef: id(1),
  plistRef: id(2),
  entitlementsRef: id(3),
  productRef: id(4),
  group: id(5),
  swiftBuild: id(6),
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
};

// Existing objects of the Capacitor project this patch attaches to.
const APP_TARGET = "504EC3031FED79650016851F";
const PROJECT = "504EC2FC1FED79650016851F";
const MAIN_GROUP_APP = "504EC3061FED79650016851F";
const PRODUCTS_GROUP = "504EC3051FED79650016851F";
const APP_RESOURCES_PHASE = "504EC3021FED79650016851F";

const NAME = "NotificationService";
const BUNDLE_ID = "com.polyth.mobile.NotificationService";

function once(source, marker, what) {
  const first = source.indexOf(marker);
  if (first < 0 || source.indexOf(marker, first + 1) >= 0) {
    throw new Error(`Xcode project shape changed (${what}); cannot install ${NAME} safely.`);
  }
  return first;
}

/** Insert `text` right after the unique `marker`. */
function after(source, marker, text, what) {
  const at = once(source, marker, what) + marker.length;
  return source.slice(0, at) + text + source.slice(at);
}

/** Insert `text` right before the unique `marker`. */
function before(source, marker, text, what) {
  const at = once(source, marker, what);
  return source.slice(0, at) + text + source.slice(at);
}

function configuration(objectId, name) {
  const debug = name === "Debug";
  return `\t\t${objectId} /* ${name} */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tCODE_SIGN_ENTITLEMENTS = ${NAME}/${NAME}.entitlements;
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tCURRENT_PROJECT_VERSION = 1;
\t\t\t\tINFOPLIST_FILE = ${NAME}/Info.plist;
\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 15.0;
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

  let p = project;
  p = before(p, "/* End PBXBuildFile section */\n",
    `\t\t${IDS.swiftBuild} /* ${NAME}.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${IDS.swiftRef} /* ${NAME}.swift */; };\n`
    + `\t\t${IDS.embedBuild} /* ${NAME}.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = ${IDS.productRef} /* ${NAME}.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };\n`,
    "PBXBuildFile section");

  // New sections, placed where Xcode itself sorts them.
  p = after(p, "/* End PBXBuildFile section */\n",
    `\n/* Begin PBXContainerItemProxy section */
\t\t${IDS.proxy} /* PBXContainerItemProxy */ = {
\t\t\tisa = PBXContainerItemProxy;
\t\t\tcontainerPortal = ${PROJECT} /* Project object */;
\t\t\tproxyType = 1;
\t\t\tremoteGlobalIDString = ${IDS.target};
\t\t\tremoteInfo = ${NAME};
\t\t};
/* End PBXContainerItemProxy section */

/* Begin PBXCopyFilesBuildPhase section */
\t\t${IDS.embedPhase} /* Embed Foundation Extensions */ = {
\t\t\tisa = PBXCopyFilesBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tdstPath = "";
\t\t\tdstSubfolderSpec = 13;
\t\t\tfiles = (
\t\t\t\t${IDS.embedBuild} /* ${NAME}.appex in Embed Foundation Extensions */,
\t\t\t);
\t\t\tname = "Embed Foundation Extensions";
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXCopyFilesBuildPhase section */
`, "PBXBuildFile section end");

  p = before(p, "/* End PBXFileReference section */\n",
    `\t\t${IDS.swiftRef} /* ${NAME}.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${NAME}.swift; sourceTree = "<group>"; };\n`
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
\t\t\t\t${IDS.swiftRef} /* ${NAME}.swift */,
\t\t\t\t${IDS.plistRef} /* Info.plist */,
\t\t\t\t${IDS.entitlementsRef} /* ${NAME}.entitlements */,
\t\t\t);
\t\t\tpath = ${NAME};
\t\t\tsourceTree = "<group>";
\t\t};
`, "PBXGroup section");

  // App target: embed phase after Resources, dependency on the extension.
  const appTarget = `\t\t${APP_TARGET} /* App */ = {\n\t\t\tisa = PBXNativeTarget;\n`;
  once(p, appTarget, "App PBXNativeTarget");
  p = after(p, `\t\t\t\t${APP_RESOURCES_PHASE} /* Resources */,\n\t\t\t);\n\t\t\tbuildRules = (\n\t\t\t);\n\t\t\tdependencies = (\n`,
    `\t\t\t\t${IDS.dependency} /* PBXTargetDependency */,\n`, "App target dependencies");
  p = after(p, `\t\t\t\t${APP_RESOURCES_PHASE} /* Resources */,\n`,
    `\t\t\t\t${IDS.embedPhase} /* Embed Foundation Extensions */,\n`, "App target buildPhases");
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

  // Project: attributes and target list.
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
\t\t\t\t${IDS.swiftBuild} /* ${NAME}.swift in Sources */,
\t\t\t);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
`, "PBXSourcesBuildPhase section");
  p = after(p, "/* End PBXSourcesBuildPhase section */\n",
    `\n/* Begin PBXTargetDependency section */
\t\t${IDS.dependency} /* PBXTargetDependency */ = {
\t\t\tisa = PBXTargetDependency;
\t\t\ttarget = ${IDS.target} /* ${NAME} */;
\t\t\ttargetProxy = ${IDS.proxy} /* PBXContainerItemProxy */;
\t\t};
/* End PBXTargetDependency section */
`, "PBXSourcesBuildPhase section end");

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

export async function configureNotificationService({ projectPath = DEFAULT_PROJECT, env = process.env } = {}) {
  if (env.POLYTH_IOS_NOTIFICATION_SERVICE === "0") {
    console.warn("configure-ios-notification-service: POLYTH_IOS_NOTIFICATION_SERVICE=0, building the app without the Notification Service Extension.");
    return false;
  }
  const project = await readFile(projectPath, "utf8");
  const patched = patchProject(project);
  if (patched === project) return false;
  await writeFile(projectPath, patched);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await configureNotificationService({ projectPath: process.argv[2] ? resolve(process.argv[2]) : DEFAULT_PROJECT });
}
