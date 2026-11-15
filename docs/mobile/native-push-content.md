# Native push content (sealed end to end)

A phone notification shows the same title and body as the notification-centre
record, while Polyth's push service, APNs and FCM see only the generic text
("Polyth / A task completed"). The host seals the text for one device key; only
that device can open it. This document is the contract the host, the push
service and both native apps implement; change it here first.

The device's content key is registered with its server alongside its token
over Polyth Link ([notifications](platform-behavior.md#notifications)); a
server with its own APNs key seals the same way. A Live Activity push cannot be sealed
(iOS hands its `content-state` to the widget unopened), so it carries no text
at all, only a state, counts and times; the widget draws the words from the
App's own copy. See [Live Activity](platform-behavior.md#live-activity-dynamic-island).

## Device content key

- One key per registration, generated natively in `enable`: a P-256 ECDH
  key pair and a 16-byte random auth secret (the Web Push key shape).
- Public half, sent to the host: `p256dh` = the uncompressed point
  `0x04 ‖ X ‖ Y` (65 bytes) and `auth` (16 bytes), both base64url without
  padding (87 and 22 characters).
- The private key and auth never leave native secure storage and never cross
  into JavaScript:
  - Android: inside the subscription's mapping in `SecureStore` (already
    AndroidKeyStore-wrapped), private key as PKCS#8.
  - iOS: a Keychain generic password, service
    `com.polyth.mobile.native-push.content`, account = subscription id, access
    group `$(AppIdentifierPrefix)com.polyth.mobile.push-content` (shared with the
    Notification Service Extension), accessibility
    `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. The app keeps
    `$(AppIdentifierPrefix)com.polyth.mobile` first in `keychain-access-groups`
    so every existing item keeps its default group.
- Lifetime: created by `enable`, replaced by a re-enable, deleted with its
  mapping (disable, forgotten connection, fresh-install wipe). It belongs to
  its subscription id: `getStatus` returns the public half with the
  registration (iOS reads it back from the Keychain, Android from the
  mapping), so the foreground re-send carries it, and the host keeps a stored
  key when the same subscription id is re-sent without one (an older app's
  status omitted it, and each foreground re-send used to wipe the key, so
  every phone showed the generic text).

## Bridge and claim

- `PolythPush.enable()` resolves `{ subscriptionId, claimToken, claimExpiresAt,
  contentKey?: { p256dh, auth } }`. A build without sealed content omits
  `contentKey`.
- The app redeems the claim with `POST /api/native-push { claimToken,
  contentKey? }`. The host validates `contentKey` (p256dh decodes to 65 bytes,
  starts with `0x04` and is a point on P-256; auth decodes to 16 bytes) and
  answers `invalid-input` otherwise. It stores the key with the subscription in
  `native-push.json` (mode 0600). No key for a new subscription id means the
  generic text, as before; no key for the stored subscription id keeps the
  stored one.

## Sealing (host)

- Plaintext: UTF-8 JSON `{"v":1,"title":T,"body":B}` with the centre record's
  title and body (already redacted and capped).
- `sealed` = base64url of RFC 8291 `aes128gcm`: header `salt (16) ‖ rs (4, =
  4096) ‖ idlen (1, = 65) ‖ keyid (65, ephemeral public key)`, then one record:
  AES-128-GCM of `plaintext ‖ 0x02` followed by its 16-byte tag
  (`encryptWebPush` in `packages/server/src/push.ts`).
- At most 3072 base64url characters; a longer body is shortened before
  sealing, never dropped.

## Push service

- `POST /v1/send` takes the alert with an optional `sealed` (base64url,
  ≤ 3072). The service never inspects it.
- APNs, only with `sealed`: `aps["mutable-content"] = 1` and a top-level
  `sealed`; the alert stays generic.
- FCM, only with `sealed`: a data-only message (no `notification`, no
  `android.notification`) with `android.priority = "high"`, `ttl` and
  `data.sealed`; the app posts the notification itself.
- Lifetime (APNs `apns-expiration`, FCM `ttl`, `pushTtlSeconds` in
  `packages/push-relay/src/providers.ts`): 12 hours for what a person must act
  on (`question`, `permission`, `failed`, `mention`, `message`), 1 hour for
  `completed`, 5 minutes for `subagent`. The server retries an alert no longer
  than this. Both people kinds alert on the
  Android attention channel; their generic text is "Someone mentioned you" /
  "New message" until the device opens `sealed`. The push service, the Android plugin
  (`pushKind`) and the iOS delegate (`payloadKind`) each refuse a kind they do
  not list, so a new host notification kind must join all three.
- A provider payload over 4096 bytes is delivered without `sealed`.

## Opening (device)

RFC 8291 §3.4, receiver side, with `ua` = this device and `as` = the host's
ephemeral key:

1. `salt = b[0..16]`, `rs = u32be(b[16..20])` (≥ 18), `idlen = b[20]` (= 65),
   `as_public = b[21..86]` (starts with `0x04`), `record = b[86..]`
   (17 ≤ length ≤ rs).
2. `ecdh_secret = ECDH(ua_private, as_public)` (32 bytes).
3. `PRK_key = HMAC-SHA256(key = auth, data = ecdh_secret)`.
4. `key_info = "WebPush: info" ‖ 0x00 ‖ ua_public ‖ as_public`.
5. `IKM = HMAC-SHA256(key = PRK_key, data = key_info ‖ 0x01)`.
6. `PRK = HMAC-SHA256(key = salt, data = IKM)`.
7. `CEK = HMAC-SHA256(key = PRK, data = "Content-Encoding: aes128gcm" ‖ 0x00 ‖ 0x01)[0..16]`.
8. `NONCE = HMAC-SHA256(key = PRK, data = "Content-Encoding: nonce" ‖ 0x00 ‖ 0x01)[0..12]`.
9. `padded = AES-128-GCM-open(CEK, NONCE, record[..-16], tag = record[-16..])`,
   no additional data.
10. Drop trailing `0x00` bytes; the last remaining byte must be `0x02`; drop it.
11. Parse the JSON: `v` must be 1, `title` and `body` strings. Remove control
    characters, cap the title at 120 and the body at 400 characters.

Any failure shows the generic text; a sealed notification is never dropped.

Known-answer vector (RFC 8291 Appendix A), verified against step 1–10:

| Value | base64url |
| --- | --- |
| UA private key | `q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94` |
| UA public key | `BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4` |
| Auth secret | `BTBZMqHH6r4Tts7J_aSIgg` |
| AS private key | `yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw` |
| Salt | `DGv6ra1nlYgDCS1FRnbzlw` |
| Message | `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN` |
| Plaintext | `When I grow up, I want to be a watermelon` |

## Compatibility

| Host | Push service | App | Result |
| --- | --- | --- | --- |
| new | new | new | sealed text on the phone |
| new | any | old | no content key, no `sealed`: generic text |
| old | any | new | host ignores `contentKey`: generic text |

## Verification status

**Tested in Node:** host and push-service sealing, the registration, the RFC vector, and the
Xcode project patch (`apps/mobile/test/iosNotificationService.test.ts`: idempotent,
no dangling object ids, App depends on and embeds the extension, switch `0`
leaves the file byte-identical).

**Implemented, source-only (never compiled: the development host has no JDK,
Android SDK, Swift or Xcode):**

- Android: `PolythSealedPush` (steps 1-11; JVM unit test with the RFC vector in
  `PolythSealedPushTest`), the content key in the subscription mapping, and the
  sealed path in `receiveMessage` (generic text on any failure).
- iOS: the content key in the shared Keychain group (value = 32-byte raw private
  key ‖ 16-byte auth, account = subscription id), the `keychain-access-groups`
  entitlements, and the `NotificationService` extension. The Xcode target is
  added at build time by `scripts/configure-ios-notification-service.mjs`
  (run from `native:ios`), so unsigned simulator builds include it. For signed
  builds `scripts/ci/remote-build.mjs` fetches the extension's signing files and,
  if that fails — or if the archive with the extension fails — logs a
  `WITHOUT the Notification Service Extension` warning and ships the app
  without it (`POLYTH_IOS_NOTIFICATION_SERVICE=0`), so TestFlight never breaks
  over the extension. The IPA check logs whether
  `NotificationService.appex` is embedded.

**A person must confirm once:**

1. The first signed build creates the `com.polyth.mobile.NotificationService`
   App ID and App Store profile (`fetch-signing-files --create`); check the
   build log has no "WITHOUT the Notification Service Extension" warning and that the IPA's
   `Payload/App.app/PlugIns/NotificationService.appex` exists and is signed.
2. The Firebase/Apple side needs nothing extra for the extension; the push
   service's FCM project must accept data-only high-priority messages.
3. On a physical iPhone and Android phone: enable push, trigger a notification
   and confirm the real title/body appears (and that a build or key mismatch
   shows the generic text rather than nothing). The iOS Keychain access group
   sharing and the Android background data-message delivery are unverified until
   then.
