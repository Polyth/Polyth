import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseNativePushClaim } from "../src/nativePush.ts";
import { parseNativePushOpen, parseNativePushOpenId } from "../src/nativePushPayload.ts";

test("native push bridge exposes only the token for the page's own server and pending-open values", async () => {
  const source = await readFile(new URL("../src/nativePush.ts", import.meta.url), "utf8");
  // The page registers the token with its server, which sends through Polyth's push service.
  assert.match(source, /interface NativePushClaim[\s\S]*providerToken[\s\S]*platform\?: "android"[\s\S]*environment/);
  assert.match(source, /consumePendingOpen\(\)/);
  assert.doesNotMatch(source, /claimToken|manageToken|senderSecret|identitySecret/);
});

test("a registration is an iOS hex token with its environment or an Android FCM token", () => {
  const subscriptionId = `sub_${"s".repeat(22)}`;
  const ios = { subscriptionId, providerToken: "ab".repeat(32), environment: "sandbox" };
  assert.deepEqual(parseNativePushClaim(ios), ios);
  assert.equal(parseNativePushClaim({ ...ios, environment: undefined }), undefined);
  assert.equal(parseNativePushClaim({ ...ios, providerToken: "fcm:not-hex-token" }), undefined);
  assert.equal(parseNativePushClaim({ ...ios, platform: "ios" }), undefined);
  const android = { subscriptionId, providerToken: "fcm:opaque-token-abcdefgh", platform: "android" };
  assert.deepEqual(parseNativePushClaim(android), android);
  assert.equal(parseNativePushClaim({ ...android, providerToken: "has space in it" }), undefined);
  assert.deepEqual(parseNativePushClaim({ ...ios, contentKey: { p256dh: "bad", auth: "bad" } }), ios, "a bad content key is dropped");
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
  // A backgrounded page keeps its registration: re-reading the status there
  // (native answers "disabled" off the foreground) brought the local copies
  // back beside the server's pushes.
  assert.match(web, /export async function reconcileNativePushForeground[\s\S]*?if \(!active\) return;\n[\s\S]*?await authoritativeStatus\(\);\n\}/);
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
  // iOS resolves the token only in direct mode (no relay origin in the build).
  const direct = swift.slice(swift.indexOf("private func registerDirect("), swift.indexOf("private func rotate(token:"));
  assert.match(swift, /if relayOrigin\(\) == nil \{ registerDirect\(/);
  assert.match(direct, /"providerToken": token, "environment": environment/);
  const relayed = swift.slice(swift.indexOf("private func register(token:"), swift.indexOf("private func registerDirect("));
  assert.doesNotMatch(relayed, /"providerToken": token\]?\)?, "environment"|result\["providerToken"\]/);
  // Android hands the FCM token to the page the same way; the private content key never.
  assert.match(android, /result\.put\("platform", "android"\);\s*result\.put\("providerToken", providerToken\)/);
  assert.doesNotMatch(android, /result\.put\("contentPrivate"|HttpURLConnection|openConnection/);
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

test("iOS has a build-owned environment and strict rotation shapes; Android keeps a rotated token locally", async () => {
  const [swift, android, info] = await Promise.all([
    readFile(new URL("../ios/App/App/AppDelegate.swift", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/com/polyth/mobile/PolythPushPlugin.java", import.meta.url), "utf8"),
    readFile(new URL("../ios/App/App/Info.plist", import.meta.url), "utf8"),
  ]);
  assert.match(info, /PolythPushEnvironment[\s\S]*POLYTH_PUSH_ENVIRONMENT/);
  assert.match(swift, /"environment": environment/);
  assert.match(swift, /RelayRedirectGuard[\s\S]*completionHandler\(nil\)/);
  assert.doesNotMatch(info, /PolythPushRelayOrigin/, "no build talks to a relay itself");
  const androidRotate = android.slice(android.indexOf("private static void rotateProviderToken"), android.indexOf("static void receiveMessage"));
  const swiftRotate = swift.slice(swift.indexOf("private func rotate(token:"), swift.indexOf("private func binding"));
  // Re-registered with the server by the page on the next foreground (getStatus carries it).
  assert.match(androidRotate, /store\.put\(KEY_MAPPING \+ mapping\.getString\("subscriptionId"\), mapping\.put\("providerToken", providerToken\)\)/);
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
  assert.match(web, /fetch\(`\/api\/notifications\/\$\{encodeURIComponent\(id\)\}`/);
  assert.match(web, /open: \(sessionId\) => focusSession\(sessionId\)[\s\S]*\/api\/notifications\/read/);
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
  assert.match(bootstrap, /const hydrated = init\(\);[\s\S]*hydrated\.then\(openPendingNativePushAfterHydration\)/);
  assert.match(init, /export function init\(\): Promise<void>[\s\S]*return initialHydration/);
  // Boot restoration rewrites the address before hydration ends, so the id
  // is read while the module loads (apps/web/test/nativePushOpen.test.ts).
  const web = await readFile(new URL("../../web/src/nativePush.ts", import.meta.url), "utf8");
  assert.match(web, /\nlet landedOpen = typeof location === "undefined" \? undefined : landedNativePushOpen\(location\.search\);/);
  assert.doesNotMatch(web, /async function openPendingNativePushAfterHydration[\s\S]*location\.search/);
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

test("the claim bridge validates the content key, drops an invalid one, and keeps private material out of JS", async () => {
  const source = await readFile(new URL("../src/nativePush.ts", import.meta.url), "utf8");
  const web = await readFile(new URL("../../web/src/nativePush.ts", import.meta.url), "utf8");
  assert.match(source, /contentKey\?: NativePushContentKey/);
  assert.match(source, /\{87\}/);
  assert.match(source, /\{22\}/);
  assert.match(source, /0x04/);
  assert.match(source, /dropped, not fatal/);
  assert.doesNotMatch(source, /privateKey|private_key|pkcs8/i);
  assert.match(web, /claim: \(claim\) => request<\{ subscriptionId: string \}>\("\/api\/native-push", json\("POST", \{ \.\.\.claim \}\)\)/);
});

test("both platforms return the content key's public half in getStatus, so a re-send keeps it", async () => {
  const [ios, android] = await Promise.all([
    readFile(new URL("../ios/App/App/AppDelegate.swift", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/com/polyth/mobile/PolythPushPlugin.java", import.meta.url), "utf8"),
  ]);
  assert.match(ios, /func contentPublicKey\(_ subscriptionId: String\) -> \[String: String\]\?/);
  assert.match(ios, /status\["contentKey"\] = contentKey/);
  assert.match(ios, /self\.contentPublicKey\(item\.subscriptionId\)/);
  assert.match(android, /mapping\.optString\("contentPublic", ""\)/);
  assert.match(android, /mapping\.optString\("contentAuth", ""\)/);
  assert.match(android, /result\.put\("contentKey", new JSObject\(\)\.put\("p256dh", contentPublic\)\.put\("auth", contentAuth\)\)/);
});

test("refreshNativePushStatus keeps the content key inside the registration, never on the status", async () => {
  const source = await readFile(new URL("../src/nativePush.ts", import.meta.url), "utf8");
  assert.match(source, /const registration = parseNativePushClaim\(raw\)/);
  assert.match(source, /providerToken: _token, environment: _environment, platform: _platform, contentKey: _contentKey, \.\.\.status/);
  assert.match(source, /\{ \.\.\.status, registration \}/);
  const claim = { subscriptionId: `sub_${"s".repeat(22)}`, providerToken: "ab".repeat(32), environment: "production" };
  const key = { p256dh: Buffer.alloc(65, 4).toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") };
  assert.deepEqual(parseNativePushClaim({ ...claim, contentKey: key })?.contentKey, key, "a valid key stays on the registration");
});

test("the page of the tap's own server takes the tap in place; every other page leaves it for the hub", async () => {
  const [swift, android, activity, bridge, web] = await Promise.all([
    readFile(new URL("../ios/App/App/AppDelegate.swift", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/com/polyth/mobile/PolythPushPlugin.java", import.meta.url), "utf8"),
    readFile(new URL("../android/app/src/main/java/com/polyth/mobile/MainActivity.java", import.meta.url), "utf8"),
    readFile(new URL("../src/nativePush.ts", import.meta.url), "utf8"),
    readFile(new URL("../../web/src/nativePush.ts", import.meta.url), "utf8"),
  ]);
  const between = (source: string, from: string, to: string): string => {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start + from.length);
    assert.ok(start >= 0 && end > start, `${from} … ${to}`);
    return source.slice(start, end);
  };

  // iOS. Offered only to the exact active proxy of the connection the tap
  // belongs to; a page that does not claim in time goes to the hub after all.
  const offer = between(swift, "private func offerToLivePage", "private func returnToHubUnlessClaimed");
  assert.match(offer, /guard PolythLinkPlugin\.ownsCurrentProxy\(self\.webView\?\.url\),\s*UserDefaults\.standard\.string\(forKey: "polyth-link\.last-connection-id"\) == pending\.connectionId else \{\s*self\.returnToConnectionHub\(\); return/);
  assert.match(offer, /triggerWindowJSEvent\(eventName: Self\.pendingOpenEvent\)/);
  assert.doesNotMatch(offer, /notificationId"|data:/, "the event carries nothing");
  const fallback = between(swift, "private func returnToHubUnlessClaimed", "private func returnToConnectionHub");
  assert.match(fallback, /guard self\.claimedOpen != notificationId,[\s\S]*self\.returnToConnectionHub\(\)/);
  assert.match(swift, /recordTapped[\s\S]*?secureSet\(JSONEncoder\(\)\.encode\(pending\), account: Self\.pendingKey\)\s*self\.claimedOpen = nil\s*self\.offerToLivePage\(pending\)/);
  // The claim hands out the id alone, to that proxy and account, and removes
  // nothing: a foreign page can neither read nor discard another server's tap.
  const claim = between(swift, "@objc func claimPendingOpen", "@objc func settlePendingOpen");
  assert.match(claim, /PolythLinkPlugin\.ownsCurrentProxy\(self\.webView\?\.url\)/);
  assert.match(claim, /pending\.connectionId == connectionId, pending\.accountId == account/);
  assert.match(claim, /call\.resolve\(\["notificationId": pending\.notificationId\.lowercased\(\)\]\)/);
  assert.doesNotMatch(claim, /secureRemove|"connectionId":|"accountId":/);
  const settle = between(swift, "@objc func settlePendingOpen", "@objc func setForeground");
  assert.match(settle, /requireSemanticReader\(call\)/);
  assert.match(settle, /if self\.claimedOpen == settled \{[\s\S]*pending\.notificationId\.lowercased\(\) == settled \{\s*self\.secureRemove\(Self\.pendingKey\)/);

  // Android, the same contract.
  const androidOffer = between(android, "static boolean offerPendingOpenToLivePage", "private static boolean livePageServes");
  assert.match(androidOffer, /!livePageServes\(context, bridge, pending\.optString\("connectionId"\)\)\) return false;/);
  assert.match(androidOffer, /bridge\.triggerWindowJSEvent\(PENDING_OPEN_EVENT\);/);
  assert.match(androidOffer, /if \(id\.equals\(CLAIMED_OPEN\.get\(\)\)\) return;[\s\S]*returnToHub\.run\(\)/);
  const serves = between(android, "private static boolean livePageServes", "\n    }\n");
  assert.match(serves, /PolythLinkPlugin\.ownsCurrentProxy\(context, PolythLinkOrigin\.currentUrl\(bridge\)\)/);
  assert.match(serves, /connectionId\.equals\([\s\S]*"last_connection_id"/);
  const androidClaim = between(android, "public void claimPendingOpen(PluginCall call)", "public void settlePendingOpen(PluginCall call)");
  assert.match(androidClaim, /livePageServes\(getContext\(\), getBridge\(\), pending\.optString\("connectionId"\)\)/);
  assert.match(androidClaim, /accountId\.equals\(pending\.optString\("accountId"\)\)/);
  assert.doesNotMatch(androidClaim, /secure\.take|secure\.remove|result\.put\("connectionId"|result\.put\("accountId"/);
  const androidSettle = between(android, "public void settlePendingOpen(PluginCall call)", "public void setForeground(PluginCall call)");
  assert.match(androidSettle, /requireSemanticReader\(call\)/);
  assert.match(androidSettle, /CLAIMED_OPEN\.compareAndSet\(settled, null\)[\s\S]*secure\.remove\(KEY_PENDING\)/);
  assert.match(activity, /offerPendingOpenToLivePage\(getApplicationContext\(\), getBridge\(\), returnToHub\)\) returnToHub\.run\(\)/);

  // One event name on both platforms and in the page.
  assert.match(swift, /pendingOpenEvent = "polythNativePushOpen"/);
  assert.match(android, /PENDING_OPEN_EVENT = "polythNativePushOpen"/);
  assert.match(bridge, /export const NATIVE_PUSH_OPEN_EVENT = "polythNativePushOpen";/);
  // The page listens once it is hydrated, claims with its own account, and
  // releases the tap when it is done with it.
  assert.match(web, /window\.addEventListener\(NATIVE_PUSH_OPEN_EVENT, \(\) => \{ void taps\.take\(\); \}\)/);
  assert.match(web, /claimNativePushOpen\(\{ accountId: activeBrowserAccountId\(\) \}\)/);
  assert.match(web, /settle: \(notificationId\) => settleNativePushOpen\(notificationId\)/);
});

test("a claimed tap reaches the page as a canonical notification id and nothing else", () => {
  const id = "3F2B1C4D-5E6F-4A7B-8C9D-0E1F2A3B4C5D";
  assert.equal(parseNativePushOpenId({ notificationId: id }), id.toLowerCase());
  assert.equal(parseNativePushOpenId({}), undefined);
  assert.equal(parseNativePushOpenId(undefined), undefined);
  assert.equal(parseNativePushOpenId({ notificationId: "https://example.test/x" }), undefined);
  assert.equal(parseNativePushOpenId({ notificationId: 7 }), undefined);
});

test("a tapped notification's chat is looked up before the launch restores anything", async () => {
  const [web, bootstrap, init] = await Promise.all([
    readFile(new URL("../../web/src/nativePush.ts", import.meta.url), "utf8"),
    readFile(new URL("../../web/src/bootstrap.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../web/src/init.ts", import.meta.url), "utf8"),
  ]);
  // Only with this device's registration already confirmed: the inbox is
  // never read on the word of a landing address alone.
  assert.match(web, /export function startNativePushOpen\(\): void \{[\s\S]*?!nativePushLocalProjectionEnabled\(\)\) return;[\s\S]*?offerNativePushBootTarget\(/);
  assert.match(bootstrap, /startNativePushOpen\(\);\s*const hydrated = init\(\);/);
  assert.match(bootstrap, /const tapClaimed = claimNativePushOpenAtBoot\(\)[\s\S]*?await reconcileNativePushForeground\(true\)[\s\S]*?await tapClaimed;/);
  assert.match(init, /const tappedSessionId = fromUrl\.sessionId \? undefined : await takeNativePushBootTarget\(\);/);
});
