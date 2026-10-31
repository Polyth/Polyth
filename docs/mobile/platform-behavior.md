# Polyth mobile platform behavior

## Navigation and lifecycle

- Cold launch restores the active validated Polyth host, then lets the
  canonical app restore project and session state.
- Foreground resume immediately nudges the existing reconnect-safe sync client.
  A New Chat worktree/branch read that lost its transport (no HTTP response)
  asks for a reconnect and reads again once the socket is back; only a second
  transport loss for the same location shows the connection error. This is
  for reads only (`apps/web/src/retryAfterReconnect.ts`); a mutation without a
  response keeps its unknown-outcome handling and is never replayed.
- Every GET/HEAD through `sessionFetch` or the `@polyth/web-sdk` API transport
  that fails with no HTTP response (WebKit "Load failed", a dead keep-alive
  socket after resume) is retried up to three times (250 ms / 1 s / 3 s),
  waiting while the page is hidden or offline and, before each retry, while
  the shell's WebSocket is connecting/reconnecting (at most 8 s per retry: the
  socket rides the same transport, the Polyth Link on a phone). The shell
  registers that gate with `setConnectionGate`
  (`@polyth/contracts/transport-retry`). Mutations are sent exactly once.
- Each time the shell's WebSocket opens it dispatches
  `CONNECTION_RESTORED_EVENT` (`polyth:connection-restored`, subscribe with
  `onConnectionRestored`). Views whose read failed for lack of a connection
  load again then instead of keeping the failure: the composer's workflow
  launcher (also re-asks when it is opened after a failed load; a lazy launcher
  closed mid-load no longer stays on "Loading"), the Workflows page (its banner
  offers Retry) and the model picker's harness tabs (an empty picker says
  Polyth was unreachable and offers Retry; such a read is never toasted as a
  raw "Load failed"). A toast whose whole message — or detail — is a bare
  engine phrase ("Load failed", "Failed to fetch") is presented as the lost
  connection (`errorPresentation.ts`). The same holds for an aborted or
  timed-out request (`isRequestAbort`): WebKit rejects every aborted fetch,
  deadline included, with "Fetch is aborted", which must never reach a toast.
- Opening a session awaits the native draft read (5 s deadline), but a failed
  or stalled draft read leaves the composer on its local copy instead of
  failing the open (`hydrateComposerDraft`); it is not cached, so the next
  open asks again.
- After the link breaks (background, Link stall) the screen keeps what it
  had, but stops presenting it as current until the server confirms it
  (`synced` receipts, see the WS protocol in `docs/dev/architecture.md`): a
  catch-up longer than 700 ms shows a non-interactive top pill —
  "Reconnecting…" while the socket is down, "Updating…" while it replays — and
  a quicker one shows nothing. The open session is replayed before the
  navigator list, and the shell's background reconnect reads (notifications,
  profiles, model catalog retries) wait for the open session to be current
  (at most 3 s) so they do not queue ahead of it on the Link.
- Connection-loss errors are held while the system heals itself: an error whose
  category is the lost connection, raised while catching up, stays hidden and
  is dropped once the screen is confirmed current (the failed reads have
  re-run via `CONNECTION_RESTORED_EVENT`); it surfaces only if catch-up is
  still failing after 20 s of foreground time. An unknown write outcome and
  every other error are never held (`apps/web/src/syncCatchUp.ts`,
  `components/ConnectionFeedback.tsx`).
- Session create is keyed instead: the client sends one random
  `clientOperationId` per New Chat send and the server derives the session id
  from (account, Space, key) with `@polyth/session/create-operation`,
  serializing requests per key. This covers both ordinary
  (`POST /api/sessions`) and isolated (`POST /api/isolation/sessions`, which
  also allocates the managed checkouts) create. When the response is lost,
  `apps/web/src/sessionCreateRecovery.ts` asks
  `GET /api/sessions/create-operations/:key` (≈24 s backoff) and continues with
  the created session, or resends the same key once the probe answers `absent`
  — a resend returns the first session (and its worktrees), never a duplicate.
  A managed checkout left for the key without a canonical session (crash
  between allocation and create) fails closed with `conflict` and is preserved
  for recovery, never re-allocated or rolled back by the resend.
  The server also rides out a *transient* runtime-acquire refusal on a new
  session's first acquire — a configuration-replacement fence
  (`restart-deferred`) or a harness still becoming ready — with a short bounded
  retry before it settles the create, so the first attempt is not turned into a
  rejected, `failed` session; only a terminal refusal (shutdown, identity
  recovery, an unsupported setup) fails, and its real code and message are kept
  in the operation ledger instead of the generic `runtime-unavailable`.
  A server without the probe (404) or a link that stays down still ends in
  "New chat not confirmed" (`composer.newChatOutcomeUnknown`: open the chat if
  it appears in the list, otherwise send again; the text is restored). Other
  actions with an unknown outcome use the context-free
  `settings.mutationOutcomeUnknown` copy, which names no session or draft.
  Standalone worktree creation (`POST /api/worktrees`,
  used for a new-worktree/branch New Chat) is not keyed yet and keeps that
  outcome.
- A composer model catalog whose request failed is asked again on Reconnect,
  sync reconnect, a return to the foreground or `online`; a network failure
  also retries every 10 s while visible and reads "Can't reach Polyth.
  Retrying…" instead of the raw fetch error. A live route that answers with no
  models is not cached: a transient runtime-empty answer retries at 1.2 s,
  3 s, 7 s and 15 s, then leaves only those manual/foreground/online retries
  armed; an authoritative account-hidden answer (`code: "models-hidden"`) is
  not retried or replaced with stale rows and offers Harness Settings instead
  of Reconnect (`packages/models/widgets/runtimeCatalog.ts`,
  `packages/models/src/serverEntry.ts`).
- Internal project/session links stay in the app. External HTTP(S) links open
  in `SFSafariViewController` or an Android Custom Tab.
- The `polyth:` scheme opens a project or session on the active host.

Android Back consumes exactly one layer per press:

1. the top Escape-stack popover, menu, or dialog;
2. the app overlay;
3. the navigation drawer;
4. a workspace pane;
5. a contextual rail;
6. in-app project/session history;
7. the session's project hero when a deep link has no prior history; then
8. the app backgrounds.

It never blindly calls browser history, so the user cannot back into the
packaged connection origin or out to an unrelated site.

## Launch and reveal

UX-LAUNCH: from the app icon to a usable workspace the user sees one picture,
brand night (`#07091c`) with the Polyth mark 112 pt/dp tall at the centre of
the screen, and then one reveal onto a settled screen. Nothing that is still
loading is shown in between.

- **Four renderings of one picture.** These must stay identical:
  - the iOS launch storyboard: a fixed 112 pt image, centred on the whole
    screen;
  - the Android 12+ splash: `windowSplashScreenBackground` and
    `windowSplashScreenAnimatedIcon` in its 288 dp box, plus the
    `polyth_launch` layer-list for the window background and the legacy
    splash;
  - the web launch veil, which `apps/web/src/index.html` paints before any
    stylesheet or script loads;
  - the Link bootstrap page (`crates/polyth-link-core/src/local_proxy.rs`).

  `apps/mobile/scripts/generate-assets.mjs` produces the native images.
  `apps/mobile/test/assets.test.ts` pins the shared numbers.
- **App icons re-frame the mark.** `resources/icon-only.png` keeps the brand
  margin, so the generator trims it and draws the mark larger: 78% of the iOS
  tile (on white), 84% of the legacy Android bitmap, and 56% of the 108 dp
  adaptive foreground layer — about 83% of the visible 72 dp, still inside the
  66 dp safe circle. The adaptive layers carry no inset.
- **The native splash is a curtain.** Each page lifts it once its own veil
  has decoded the mark (`releaseLaunchCurtain` from `apps/web/src/main.tsx`),
  so the hand-over cannot be seen. On iOS it is raised again
  (`SplashScreen.show`, no fade) before each page swap: Connection Hub →
  Link bootstrap → workspace, and the way back to the hub
  (`coverPageForLeave`). No intermediate document paints, and the next page
  lifts the splash again.
  - Android's re-show is an inset legacy window, so Android skips the curtain.
    There the WebView's brand background and the bootstrap page's own veil
    carry the swap.
  - `launchAutoHide` with 10 s is only the safety net for a page that never
    lifts the splash.
- **Connection Hub.** When the hub opens a trusted server by itself (warm
  start, resume bounce, notification tap) it stays behind the veil.
  - After 1.2 s the mark breathes and the veil says
    "Connecting to <server>…".
  - The hub's controls appear only when the user has something to do or read:
    no server to open, pairing, a failure, an error, or an open still running
    after 8 s. The mark then flies into the hub's brand mark while the content
    rises in.
  - Leaving the hub reverses that flight before the curtain covers the swap.

  The decision is `hubPresentation` in `apps/mobile/src/connectionUi.ts`.
- **Workspace reveal.** `apps/web/src/launchReveal.ts` lifts the veil once,
  when all of these hold:
  - the projects and the restored session or fresh chat are in place;
  - the synced settings (theme, wallpaper) are applied;
  - the web packages have booted (they get up to 1.8 s after hydration);
  - first-screen reads have landed: the branch label, the composer's
    worktrees and recent chats (`holdLaunchReveal`, up to 1.6 s after
    hydration);
  - the DOM has been still for 160 ms.

  Sign-in, setup and the unreachable-server card show as soon as they stop
  changing, after at most 0.6 s.
  - Caps: everything shows 3.2 s after hydration, and the veil never stays
    past 9 s from navigation start.
  - A boot still running at 1.6 s gets the breathing mark and "Opening your
    workspace…".
  - The reveal clears the night while the mark swells and fades. Reduced
    motion, and the in-app reduce-animations setting, get a short fade
    instead.
- After the reveal, a composer launcher that a package registers late fades
  in (`data-arrived` in `MobileComposerRail`) instead of popping into the row.
  The project registry's loading state uses the same transparent canvas as
  the fresh-chat screen, not an opaque phone stage.
- Desktop browsers (fine pointer, wider than 620 px) remove the veil before
  their first paint.
- Each app launch opens the Link loopback proxy on a new port, so the shell's
  origin storage starts empty. Theme, wallpaper and the other synced settings
  (the default number of sessions a project shows among them) arrive from the
  server, behind the veil. The navigators' open projects, shown-session
  counts, project sort and custom project order are device-local, so they are
  restored from the app-owned client-context store before the first render
  (`apps/web/src/navigatorState.ts`, see `docs/dev/ui.md`). Usage limit
  alerts remember what they announced on the server, per person, so a launch
  does not repeat them (`packages/usage/README.md`, "Usage notifications").
  Other localStorage-only state still starts empty on every launch.

Verification status: the web veil, the reveal and the hub transitions are
checked in Chromium filmstrips, and the veil matches the generated iOS launch
image within 1 CSS px. The native halves (storyboard layout, Android splash
attributes, curtain timing) are source-inspected only and need a device
check.

## Safe areas and keyboard

Both platforms render edge-to-edge. Native safe-area values map to
`--safe-top`, `--safe-right`, `--safe-bottom`, and `--safe-left`. The existing
shared shell uses those values for headers, drawers, sheets, bottom navigation,
and the composer.

Left and right insets are handled per edge, never folded into one symmetric
`max()`: a landscape notch and a foldable's side strip sit on one side only.
In the compact shell (≤960px or a coarse landscape phone) the header, the
drawer (on its inline-start screen edge), the timeline and the composer each
clear their own edge, with `:dir(rtl)` swapping the physical sides. A device
with no side inset (every iPad, portrait phones) is unchanged by construction.

### iPhone Duo (foldable)

iPhone Duo needs no device detection; the existing width seam already gives the
right shell. What the app gets depends on the SDK stamped into the binary
(Apple pages and developer simulator reports; unverified here): built with the
iOS 26 SDK it runs in a 375×667 pt phone window on both displays; built with
iOS 27.1 (Xcode 27.1, which signed builds pin, see
[releases](../operations/releases.md#ios--testflight)) it runs edge to edge —
outer display 466×678 pt → `phone`, inner display 951×669 landscape and
669×951 portrait → `compact`, the tablet drawer shell described in
[tablet UX](../dev/tablet-ux.md). Folding or unfolding is a live viewport
change through `responsiveShell.ts`. On Duo the system puts the status items
(and, folded, the front camera) in an 84 pt column at one side, reported as
that side's safe inset; the per-edge rules above keep content out of it, and
the launcher strip moves into the column instead of leaving it empty
(`sideSafeStrip.ts`, [tablet UX](../dev/tablet-ux.md#foldables-iphone-duo)).
Turned, the inner display's status band is on top, so no side column. The
iPhone orientation list includes portrait upside down so the app can join
Split View the way iPad multitasking requires. A 50/50 Split View half
(~313 pt) falls in `phone`. Device evidence: none yet — how WKWebView reports
the column's inset on real hardware is unverified.

Capacitor uses native keyboard resize. Keyboard show/hide events also publish
the reported height through `apps/web/src/mobileViewport.ts`, which remains the
single owner of `--visual-vh`, `--visual-bottom`, `--visual-offset`, and
`--keyboard-inset`. This covers Android WebViews where visual viewport geometry
reports only the already-resized content box.

## Files and attachments

The composer Add → upload action opens the native system document picker on iOS
and Android. It accepts documents and images, converts the selected native URLs
to browser `File` objects, then reuses the existing `_inbox` upload and
attachment-pill path.

- Cancellation is silent and preserves the draft.
- A denied or unreadable selection shows a bounded existing UI error.
- The picker grants only scoped access to user-selected files; Polyth requests
  no broad storage or photo-library permission.
- The existing attachment count, server path jail, upload, event-log, and send
  validation remain authoritative.

A direct camera action is deferred. Capacitor 8 separates camera and gallery
selection and requires a dedicated user choice plus camera permission
explanation; adding an ambiguous camera prompt to the existing upload action
would regress the scoped-permission model.

## Downloads, sharing, clipboard, and haptics

- Download links fetch with the authenticated same-origin session, write a
  temporary cache file, and open the platform share sheet. They do not expose a
  server filesystem path to the phone.
- Text copy uses the native clipboard when running in Capacitor and retains the
  browser clipboard/fallback path elsewhere.
- Light haptics confirm a successful connection and a successful native file
  selection. Navigation and routine taps remain silent.
- Outbound Share uses the platform share sheet for downloaded artifacts.

Receiving arbitrary files/text from another app ("Share into Polyth") is
deferred to Phase 4. A complete implementation needs Android intent ingestion
and an iOS Share Extension with an app-group handoff, target project/session
selection, size limits, and durable pending-item recovery. Wave 4 does not ship
a partial intent handler.

## Notifications

Mobile push is a native-controller and relay flow. Permission is requested only
from the explicit Mobile push notifications setting, never at startup or
pairing. Android requests `POST_NOTIFICATIONS` only on Android 13+; a fresh
install remains actionable until that request has been made. iOS registers APNs
only after authorization. The native controller keeps provider tokens and relay
manage capabilities in secure native storage, while web content receives only
semantic state and a short-lived claim.

Provider data is strictly limited to version, subscription id, notification
UUID, kind, and opaque tag. Receipt validates and displays an OS notification
but never writes navigation state. A user tap persists one bounded trusted
connection/account/notification mapping, returns to the bundled Connection Hub,
and reconnects that saved server before the authenticated server looks up the
canonical notification. It never turns provider data into a URL or assumes a
session/project. Exact foreground mapping suppresses the OS alert so canonical
WebSocket/in-app delivery wins; a different trusted server/account retains its
OS notification.

The app uses `polyth_activity` for completed/subagent activity and
`polyth_attention` for failed/question/permission events. Existing local and
browser notifications remain the fallback when native push is unavailable or
not successfully claimed. Inside the native app, Settings shows only the Mobile
push row: browser Web Push can never subscribe from the WebView, so its row is
hidden there. A build without a relay origin (`POLYTH_PUSH_RELAY_ORIGIN` +
`POLYTH_PUSH_ENVIRONMENT` on iOS, `-PpolythPushRelayOrigin` +
`google-services.json` on Android) reports `unavailable`, and the row says local
alerts still appear while the app is open. APNs/FCM provider delivery, signing, Firebase
configuration, and device lifecycle behavior remain external-verification work;
the repository tests do not make provider calls.

## Live Activity (Dynamic Island)

On iOS 16.2+ the app shows one Live Activity — in the Dynamic Island and on the
Lock Screen — for the chat that most needs a person (an approval, then a
question) or, failing that, the chat that is working. Child (subagent/workflow)
chats never compete with their parent. The pure projection lives in
`apps/web/src/liveActivity.ts`, the host wiring in
`apps/web/src/nativeLiveActivity.ts` (installed after hydration), the bridge in
`apps/mobile/src/nativeLiveActivity.ts`, and the native side in
`App/PolythLiveActivityPlugin.swift` + the `PolythLiveActivity` widget
extension (shared `PolythActivityAttributes.swift`).

- **Content.** Localized status word, chat title, the pending question /
  approval / current task text (only for the active chat, whose events the page
  actually streams), task progress, and a line counting the other waiting and
  working chats. Working shows a system-drawn elapsed timer from the
  projection's turn start, so time passing never crosses the bridge. Chat text
  is `privacySensitive`, so iOS may redact it on a locked device.
- **Look.** iOS adds no app icon to a Live Activity, so the widget draws
  Polyth's mark itself: `PolythMark`, a SwiftUI `Shape` simplified from the app
  icon (a bold hexagonal ribbon whose tail crosses the right strand), filled
  with the app icon's gradient. The mark leads the compact island, the expanded
  island and the Lock Screen; the state glyph (approval, question, failed,
  done; none while working) sits beside the status word, or on the compact
  island's right in place of the timer. The minimal presentation is the mark
  alone in the state's colour (the gradient while working). Android's
  monochrome `ic_stat_polyth` is a separate, older glyph.
- **Freshness.** Updates are local only, throttled to one per second and sent
  only when the snapshot changes. Once iOS suspends the page the activity keeps
  its last snapshot and turns stale after 15 minutes ("Open Polyth to update").
  There is deliberately no ActivityKit push token: remote updates would need
  APNs `liveactivity` pushes through the relay, which would expose plaintext
  content to it (Live Activities have no service-extension decryption step).
  When nothing is live any more the activity ends with a final Done/Failed
  snapshot that stays ten minutes; a chat that vanished ends it at once. The
  first evaluation after a page load always reaches native, so an activity left
  by a previous process or server is replaced or ended.
- **Trust.** Only the bundled shell or the page on the current Link proxy may
  drive the plugin (same gate as the push semantic reader). Native re-validates
  state, session id and bounds every string.
- **Tap.** The activity opens `polyth://live-activity/<sessionId>`. That is not
  a general deep link (`mobileDeepLinkPath` ignores it, so the hub never reloads
  into a server picker): the page opens the chat only when its own store knows
  that id; otherwise the app just comes to the foreground.
- **Build.** The extension target is added at build time by
  `apps/mobile/scripts/configure-ios-live-activity.mjs` (run from `native:ios`
  after the Notification Service patch; the two compose in either order).
  `POLYTH_IOS_LIVE_ACTIVITY=0` builds without it and the plugin then reports
  unsupported. Signed builds fetch `com.polyth.mobile.LiveActivity` signing
  files best effort; `scripts/ci/remote-build.mjs` drops the newest extension
  and retries when signing or the archive fails, so TestFlight never breaks
  over it. The person can turn Live Activities off in iOS Settings → Polyth.
- **Evidence.** Projection, payload bounds, publisher ordering and the Xcode
  project patch are unit-tested. The Swift sources were not compiled here (no
  Xcode on Linux) and nothing is device-verified yet.

## Permissions

Declared permissions are pinned by `apps/mobile/test/nativePermissions.test.ts`.
Every prompt follows an explicit user action.

| Resource | Android | iOS | Used by |
| --- | --- | --- | --- |
| Camera | `CAMERA`, hardware optional | `NSCameraUsageDescription` | Pairing QR: iOS native scanner and WebView fallback. Android's Google code scanner needs no camera permission; `CAMERA` serves only the WebView fallback |
| Microphone | `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS`, hardware optional | `NSMicrophoneUsageDescription` | Dictation and voice mode (WebView `getUserMedia`) |
| Local network | `CHANGE_WIFI_MULTICAST_STATE` | `NSLocalNetworkUsageDescription`, `NSBonjourServices` `_polyth._udp` | Nearby server discovery |
| Notifications | `POST_NOTIFICATIONS` (Android 13+) | runtime authorization, `aps-environment` | Mobile push setting |

Capacitor's Android `BridgeWebChromeClient` requests `MODIFY_AUDIO_SETTINGS`
together with `RECORD_AUDIO` for every WebView audio capture and denies the
request unless both are granted. An undeclared permission is never granted, so
removing it silently breaks the microphone on Android. Merged plugin manifests
add `VIBRATE` (haptics) and `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED` and
`SCHEDULE_EXACT_ALARM` (local notifications). There is no storage,
photo-library, location or contacts permission: files come through the scoped
system document picker.

## Platform identity

Both native projects use:

- app id `com.polyth.mobile`;
- display name `Polyth`;
- Polyth generated icons and a launch screen (the 112 pt/dp mark on brand
  night, see "Launch and reveal"); and
- platform data markers (`ios` or `android`) available to the shared shell.

The projects do not retain Capacitor's default app name, package id, icon, or
splash artwork.
