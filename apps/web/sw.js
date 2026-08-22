// Polyth service worker: web push display, authenticated intervention actions,
// and deep links back into the installed app. Plain JS on purpose — this file
// is copied verbatim to dist/ and runs outside the bundle. It never caches
// session data or credentials.

const ACTIONS = {
  open: "polyth:open",
  permissionOnce: "polyth:permission-once",
  permissionReject: "polyth:permission-reject",
  questionReject: "polyth:question-reject",
  questionPrefix: "polyth:question-",
};

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function quickAnswers(payload) {
  return Array.isArray(payload.quickAnswers)
    ? payload.quickAnswers.filter((item) =>
        item && typeof item.title === "string"
        && item.answers && typeof item.answers === "object" && !Array.isArray(item.answers))
    : [];
}

function notificationActions(payload) {
  if (!payload.requestId) return [];
  if (payload.kind === "permission") {
    return [
      { action: ACTIONS.permissionOnce, title: "Allow once" },
      { action: ACTIONS.permissionReject, title: "Deny" },
    ];
  }
  if (payload.kind !== "question") return [];
  const answers = quickAnswers(payload);
  if (answers.length > 0 && answers.length <= 2) {
    return answers.map((answer, index) => ({
      action: `${ACTIONS.questionPrefix}${index}`,
      title: answer.title,
    }));
  }
  return [
    { action: ACTIONS.open, title: "Answer" },
    { action: ACTIONS.questionReject, title: "Reject" },
  ];
}

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
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      actions: notificationActions(payload),
      data: {
        sessionId: payload.sessionId || "",
        kind: payload.kind || "",
        requestId: payload.requestId || "",
        quickAnswers: quickAnswers(payload),
      },
    });
  })());
});

async function openSession(sessionId) {
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const win = wins[0];
  if (win) {
    await win.focus();
    if (sessionId) win.postMessage({ type: "polyth:open-session", sessionId });
    return;
  }
  await self.clients.openWindow(sessionId ? `/?session=${encodeURIComponent(sessionId)}` : "/");
}

function responseRequest(action, data) {
  const sessionId = typeof data.sessionId === "string" ? data.sessionId : "";
  const requestId = typeof data.requestId === "string" ? data.requestId : "";
  if (!sessionId || !requestId) return null;
  const session = encodeURIComponent(sessionId);
  const request = encodeURIComponent(requestId);
  if (action === ACTIONS.permissionOnce || action === ACTIONS.permissionReject) {
    return {
      url: `/api/sessions/${session}/permission/${request}`,
      body: { reply: action === ACTIONS.permissionOnce ? "once" : "reject" },
    };
  }
  if (action === ACTIONS.questionReject) {
    return {
      url: `/api/sessions/${session}/question/${request}/reject`,
      body: null,
    };
  }
  if (action.startsWith(ACTIONS.questionPrefix)) {
    const index = Number(action.slice(ACTIONS.questionPrefix.length));
    const answer = Array.isArray(data.quickAnswers) ? data.quickAnswers[index] : undefined;
    if (!Number.isInteger(index) || index < 0 || !answer || typeof answer.answers !== "object") return null;
    return {
      url: `/api/sessions/${session}/question/${request}`,
      body: { answers: answer.answers },
    };
  }
  return null;
}

async function sendResponse(action, data) {
  const request = responseRequest(action, data);
  if (!request) return false;
  const response = await fetch(request.url, {
    method: "POST",
    credentials: "same-origin",
    ...(request.body === null ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.body),
    }),
  });
  if (!response.ok) throw new Error(`intervention response failed (${response.status})`);
  return true;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const sessionId = typeof data.sessionId === "string" ? data.sessionId : "";
  event.waitUntil((async () => {
    try {
      if (event.action && event.action !== ACTIONS.open && await sendResponse(event.action, data)) return;
    } catch {
      // Expired auth, a stale request, or a network failure must never be
      // reported as success. Open the owning session so the user can retry or
      // authenticate; the server has not rerouted the request.
    }
    await openSession(sessionId);
  })());
});
