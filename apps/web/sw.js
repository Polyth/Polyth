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
    // Visibility handling: a visible window already runs the in-page
    // notifier — showing the push copy would double-notify.
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Explicit Settings → Send test must be observable even while Polyth is
    // open; ordinary pushes still defer to the foreground in-page notifier.
    if (payload.test !== true && wins.some((c) => c.visibilityState === "visible")) return;
    const people = await peopleStack(payload);
    await self.registration.showNotification(people ? people.title : payload.title || "Polyth", {
      body: people ? people.body : payload.body || "",
      tag: payload.tag || "polyth",
      // A chat keeps one notification; each new message in it alerts again.
      ...(people ? { renotify: true } : {}),
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      actions: notificationActions(payload),
      data: {
        sessionId: payload.sessionId || "",
        kind: payload.kind || "",
        requestId: payload.requestId || "",
        quickAnswers: quickAnswers(payload),
        ...(people ? { lines: people.lines, count: people.count } : {}),
      },
    });
  })());
});

/** People's messages share one notification per chat (the server tags them
 *  `polyth-people-<session>`). A burst stacks its newest lines under the chat
 *  title instead of piling up one alert per message. */
async function peopleStack(payload) {
  if ((payload.kind !== "message" && payload.kind !== "mention") || !payload.tag || typeof payload.line !== "string") return null;
  let earlier = [];
  let count = 1;
  try {
    const [shown] = await self.registration.getNotifications({ tag: payload.tag });
    if (shown && shown.data && Array.isArray(shown.data.lines)) {
      earlier = shown.data.lines.filter((line) => typeof line === "string");
      count = (Number.isInteger(shown.data.count) ? shown.data.count : earlier.length) + 1;
    }
  } catch {
    /* no notification list here: show this message on its own */
  }
  const lines = [...earlier, payload.line].slice(-5);
  if (count === 1) return { title: payload.title || "Polyth", body: payload.body || "", lines, count };
  const chat = typeof payload.chat === "string" && payload.chat ? payload.chat : payload.title || "Polyth";
  return { title: `${chat} · ${count} new messages`, body: lines.join("\n"), lines, count };
}

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
