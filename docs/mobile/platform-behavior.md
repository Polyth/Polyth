# Polyth mobile platform behavior

## Navigation and lifecycle

- Cold launch restores the active validated Polyth host, then lets the
  canonical app restore project and session state.
- Foreground resume immediately nudges the existing reconnect-safe sync client.
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

## Safe areas and keyboard

Both platforms render edge-to-edge. Native safe-area values map to
`--safe-top`, `--safe-right`, `--safe-bottom`, and `--safe-left`. The existing
shared shell uses those values for headers, drawers, sheets, bottom navigation,
and the composer.

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
not successfully claimed. APNs/FCM provider delivery, signing, Firebase
configuration, and device lifecycle behavior remain external-verification work;
the repository tests do not make provider calls.

## Platform identity

Both native projects use:

- app id `com.polyth.mobile`;
- display name `Polyth`;
- Polyth orange/dark generated icons and light/dark splash artwork; and
- platform data markers (`ios` or `android`) available to the shared shell.

The projects do not retain Capacitor's default app name, package id, icon, or
splash artwork.
