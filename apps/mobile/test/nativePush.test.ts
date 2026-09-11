import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseNativePushOpen } from "../src/nativePushPayload.ts";

test("native push bridge exposes only semantic claim and pending-open values", async () => {
  const source = await readFile(new URL("../src/nativePush.ts", import.meta.url), "utf8");
  assert.match(source, /interface NativePushClaim[\s\S]*subscriptionId[\s\S]*claimToken[\s\S]*claimExpiresAt/);
  assert.match(source, /consumePendingOpen\(\)/);
  assert.doesNotMatch(source, /providerToken|manageToken|senderSecret|identitySecret/);
});

test("local notification suppression requires matching authoritative server state", async () => {
  const [native, web, coordinator] = await Promise.all([
    readFile(new URL("../src/nativePush.ts", import.meta.url), "utf8"),
    readFile(new URL("../../web/src/nativePush.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/nativePushController.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(native, /nativeProjectionEnabled = status\.state === "enabled"/);
  assert.match(web, /setNativePushAuthoritativeProjection\(status\.state === "enabled"\)/);
  assert.match(coordinator, /server\.subscriptionId === local\.subscriptionId/);
});

test("native push pending opens accept only a known mapping and canonical notification UUID", () => {
  assert.deepEqual(parseNativePushOpen({
    connectionId: "connection-1",
    accountId: "account-1",
    notificationId: "6C4E4EBC-72EA-4FFB-8F59-84655C7FA5AD",
  }), {
    connectionId: "connection-1",
    accountId: "account-1",
    notificationId: "6c4e4ebc-72ea-4ffb-8f59-84655c7fa5ad",
  });
  assert.equal(parseNativePushOpen({
    connectionId: "connection-1",
    accountId: "account-1",
    notificationId: "not-a-notification",
  }), undefined);
  assert.equal(parseNativePushOpen({
    connectionId: "../other",
    accountId: "account-1",
    notificationId: "6c4e4ebc-72ea-4ffb-8f59-84655c7fa5ad",
  }), undefined);
});

test("native source keeps provider material out of the Capacitor web contract", async () => {
  const [swift, android] = await Promise.all([
    readFile(new URL("../ios/App/App/AppDelegate.swift", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/com/polyth/mobile/PolythPushPlugin.java", import.meta.url), "utf8"),
  ]);
  assert.match(swift, /CAPPluginMethod\(name: "enable"/);
  assert.match(android, /@PluginMethod\s+public void enable/);
  assert.doesNotMatch(swift, /call\.resolve\([^\n]*providerToken/);
  assert.doesNotMatch(android, /call\.resolve\([^\n]*providerToken/);
});

test("native platforms keep permission, token rotation, foreground dedupe, and channels native", async () => {
  const [swift, android, manifest, gradle, rootGradle] = await Promise.all([
    readFile(new URL("../ios/App/App/AppDelegate.swift", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/com/polyth/mobile/PolythPushPlugin.java", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8"),
    readFile(new URL("../android/app/build.gradle", import.meta.url), "utf8"),
    readFile(new URL("../android/build.gradle", import.meta.url), "utf8"),
  ]);
  assert.match(swift, /UNUserNotificationCenterDelegate/);
  assert.match(swift, /didRegisterForRemoteNotificationsWithDeviceToken/);
  assert.match(swift, /if !mappingIds\(\)\.isEmpty[\s\S]*registerForRemoteNotifications\(\)/);
  assert.match(swift, /willPresent[\s\S]*exact \? \[\] : \[\.banner, \.list, \.sound\]/);
  assert.match(swift, /polyth-native-push-binding-v1/);
  assert.match(android, /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.TIRAMISU/);
  assert.match(android, /if \(permissionRequested\(getContext\(\)\)\) \{[\s\S]*"denied"[\s\S]*\} else \{[\s\S]*"disabled"/);
  assert.match(android, /markPermissionRequested\(getContext\(\)\)/);
  assert.match(android, /FOREGROUND_MAPPING/);
  assert.match(android, /ACTIVITY_CHANNEL = "polyth_activity"/);
  assert.match(android, /ATTENTION_CHANNEL = "polyth_attention"/);
  assert.match(android, /onProviderToken/);
  assert.match(android, /cipher\.updateAAD\(name\.getBytes\(StandardCharsets\.UTF_8\)\)/);
  assert.match(android, /Explicit re-enable replaces this connection\/account's/);
  assert.match(swift, /Explicit re-enable replaces this connection\/account's/);
  assert.match(manifest, /PolythFirebaseMessagingService/);
  assert.match(gradle, /firebase-bom:34\.18\.0/);
  assert.match(rootGradle, /google-services:4\.5\.0/);
  assert.match(gradle, /POLYTH_FCM_CONFIGURED/);
});

test("pending native opens are one bounded id and never provider-directed URLs", async () => {
  const [swift, android] = await Promise.all([
    readFile(new URL("../ios/App/App/AppDelegate.swift", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/com/polyth/mobile/PolythPushPlugin.java", import.meta.url), "utf8"),
  ]);
  for (const source of [swift, android]) {
    assert.match(source, /notificationId/);
    assert.doesNotMatch(source, /sessionId.*payload|projectId.*payload|payload.*https?:\/\//);
  }
});

test("receipt validation never creates an open; only a validated notification tap carries bounded routing state", async () => {
  const [swift, scene, android, activity] = await Promise.all([
    readFile(new URL("../ios/App/App/AppDelegate.swift", import.meta.url), "utf8"),
    readFile(new URL("../ios/App/App/SceneDelegate.swift", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/com/polyth/mobile/PolythPushPlugin.java", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/com/polyth/mobile/MainActivity.java", import.meta.url), "utf8"),
  ]);
  const androidReceipt = android.slice(android.indexOf("static void receiveMessage"), android.indexOf("static boolean recordTap"));
  assert.doesNotMatch(androidReceipt, /store\.put\(KEY_PENDING|seen\(context/);
  assert.match(android, /static boolean recordTap[\s\S]*store\.put\(KEY_PENDING/);
  assert.match(android, /putExtra\("polyth\.nativePush\.subscriptionId"/);
  assert.match(activity, /PolythPushPlugin\.recordTap/);
  const willPresent = swift.slice(swift.indexOf("func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent"), swift.indexOf("func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive"));
  assert.doesNotMatch(willPresent, /recordTapped|seen\(/);
  assert.match(swift, /didReceive response[\s\S]*UNNotificationDefaultActionIdentifier[\s\S]*recordTapped/);
  assert.match(scene, /connectionOptions\.notificationResponse[\s\S]*recordTapped/);
  assert.match(swift, /forwardedNotificationDelegate[\s\S]*willPresent: notification/);
  assert.match(swift, /forwardedNotificationDelegate[\s\S]*didReceive: response/);
});

test("relay requests have a build-owned iOS environment, strict rotation shapes, and refuse redirects", async () => {
  const [swift, android, info] = await Promise.all([
    readFile(new URL("../ios/App/App/AppDelegate.swift", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/com/polyth/mobile/PolythPushPlugin.java", import.meta.url), "utf8"),
    readFile(new URL("../ios/App/App/Info.plist", import.meta.url), "utf8"),
  ]);
  assert.match(info, /PolythPushEnvironment[\s\S]*POLYTH_PUSH_ENVIRONMENT/);
  assert.match(swift, /"environment": environment/);
  assert.match(swift, /RelayRedirectGuard[\s\S]*completionHandler\(nil\)/);
  assert.match(android, /setInstanceFollowRedirects\(false\)/);
  const androidRotate = android.slice(android.indexOf("private static void rotateProviderToken"), android.indexOf("static void receiveMessage"));
  const swiftRotate = swift.slice(swift.indexOf("private func rotate(token:"), swift.indexOf("private func binding"));
  assert.match(androidRotate, /new JSONObject\(\)\.put\("providerToken", providerToken\)/);
  assert.doesNotMatch(androidRotate, /binding/);
  assert.match(swiftRotate, /\["providerToken": token\]/);
  assert.doesNotMatch(swiftRotate, /binding/);
  assert.match(swift, /\^sub_\[A-Za-z0-9_-\]\{22\}\$/);
  assert.match(android, /sub_\[A-Za-z0-9_-\]\{22\}/);
});

test("a foreign-server foreground notification retains the intent for the bundled trusted hub", async () => {
  const [runtime, screen, web, activity, android, swift] = await Promise.all([
    readFile(new URL("../src/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/ConnectionScreen.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../web/src/nativePush.ts", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/com/polyth/mobile/MainActivity.java", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/com/polyth/mobile/PolythPushPlugin.java", import.meta.url), "utf8"),
    readFile(new URL("../ios/App/App/AppDelegate.swift", import.meta.url), "utf8"),
  ]);
  assert.match(runtime, /const pendingPushOpen = await consumeNativePushOpen/);
  assert.match(screen, /controller\.connect\(pending\.connectionId\)/);
  assert.match(screen, /const pending = launch\.pendingPushOpen;[\s\S]*next\.connectionId === pending\.connectionId[\s\S]*nativePushOpen=\$\{encodeURIComponent\(pending\.notificationId\)\}/);
  assert.match(screen, /bootstrapUrlWithNext\(next\.bootstrapUrl, nextPath\)/);
  assert.doesNotMatch(web, /consumeNativePushOpen/);
  assert.match(web, /fetch\(`\/api\/notifications\/\$\{encodeURIComponent\(notificationId\)\}`/);
  assert.match(web, /await openSession\(record\.sessionId\)[\s\S]*\/api\/notifications\/read/);
  assert.match(activity, /recordTap[\s\S]*https:\/\/localhost/);
  assert.match(swift, /recordTapped[\s\S]*returnToConnectionHub/);
  assert.match(android, /consumePendingOpen\(PluginCall call\) \{[\s\S]*?requireBundled\(call\)/);
  assert.match(swift, /func consumePendingOpen\(_ call: CAPPluginCall\) \{[\s\S]*?requireBundled\(call\)/);
});

test("pending push intent survives proxy bootstrap and waits for authenticated hydration", async () => {
  const [screen, bootstrap, init] = await Promise.all([
    readFile(new URL("../src/ConnectionScreen.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../web/src/bootstrap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../web/src/init.ts", import.meta.url), "utf8"),
  ]);
  assert.match(screen, /\/?\?nativePushOpen=/);
  assert.doesNotMatch(screen, /bootstrapUrlWithNext\([^\n]+\)[\s\S]{0,120}searchParams\.set\("nativePushOpen"/);
  assert.match(bootstrap, /init\(\)\.then\(openPendingNativePushAfterHydration\)/);
  assert.match(init, /export function init\(\): Promise<void>[\s\S]*return initialHydration/);
});

test("loopback semantic push access is pinned to the exact active Link proxy", async () => {
  const [androidLink, androidPush, swift] = await Promise.all([
    readFile(new URL("../android/app/src/main/java/com/polyth/mobile/PolythLinkPlugin.java", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/com/polyth/mobile/PolythPushPlugin.java", import.meta.url), "utf8"),
    readFile(new URL("../ios/App/App/AppDelegate.swift", import.meta.url), "utf8"),
  ]);
  assert.match(androidLink, /current\.equals\(prefs\.getString\(ACTIVE_PROXY_ORIGIN, null\)\)/);
  assert.match(androidLink, /rememberTransport[\s\S]*putString\(ACTIVE_PROXY_ORIGIN, origin\)/);
  assert.match(androidPush, /PolythLinkPlugin\.ownsCurrentProxy/);
  assert.match(swift, /current == UserDefaults\.standard\.string\(forKey: "polyth-link\.active-proxy-origin"\)/);
  assert.match(swift, /rememberTransport[\s\S]*UserDefaults\.standard\.set\(origin, forKey: activeProxyOriginKey\)/);
  assert.match(swift, /bundled\(call\) \|\| PolythLinkPlugin\.ownsCurrentProxy/);
});

test("forgetting a trusted connection revokes only its native push mappings", async () => {
  const [androidPush, androidLink, swift] = await Promise.all([
    readFile(new URL("../android/app/src/main/java/com/polyth/mobile/PolythPushPlugin.java", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/com/polyth/mobile/PolythLinkPlugin.java", import.meta.url), "utf8"),
    readFile(new URL("../ios/App/App/AppDelegate.swift", import.meta.url), "utf8"),
  ]);
  assert.match(androidLink, /PolythPushPlugin\.forgetConnection\(getContext\(\), connectionId\)/);
  assert.match(androidPush, /for \(JSONObject mapping : store\.mappings\(\)\) \{[\s\S]*connectionId\.equals\(mapping\.optString\("connectionId"\)\)/);
  assert.match(swift, /PolythPushPlugin\.shared\.forgetConnection\(connectionID\)/);
  assert.match(swift, /for item in items where item\.connectionId == connectionId/);
});

test("a fresh iOS install cannot reuse a Keychain-surviving pending push identity", async () => {
  const swift = await readFile(new URL("../ios/App/App/AppDelegate.swift", import.meta.url), "utf8");
  assert.match(swift, /installMarker = "polyth-native-push\.install-v1"/);
  assert.match(swift, /if !UserDefaults\.standard\.bool\(forKey: Self\.installMarker\)[\s\S]*secureRemoveAll\(\)[\s\S]*setMappingIds\(\[\]\)/);
});
