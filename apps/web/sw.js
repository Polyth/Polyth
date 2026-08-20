// Polyth service worker (F18): web push display + deep-link back into the app.
// Plain JS on purpose — this file is copied verbatim to dist/ and runs outside
// the bundle. It holds no state and never caches; its only jobs are showing
// push notifications when no visible window exists and routing clicks.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    /* non-JSON payload: show the generic notification below */
  }
  event.waitUntil((async () => {
    // Visibility handling (OC#944): a visible window already runs the in-page
    // notifier — showing the push copy would double-notify.
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (wins.some((c) => c.visibilityState === "visible")) return;
    await self.registration.showNotification(payload.title || "Polyth", {
      body: payload.body || "",
      tag: payload.tag || "polyth",
      data: { sessionId: payload.sessionId || "" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = (event.notification.data && event.notification.data.sessionId) || "";
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins[0];
    if (win) {
      // Existing tab: focus it and let the app switch sessions in place.
      await win.focus();
      if (sessionId) win.postMessage({ type: "polyth:open-session", sessionId });
      return;
    }
    await self.clients.openWindow(sessionId ? `/?session=${encodeURIComponent(sessionId)}` : "/");
  })());
});
