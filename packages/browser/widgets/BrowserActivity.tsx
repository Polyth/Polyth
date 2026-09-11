import { createElement, useEffect, useRef, useState } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import { api, type BrowserSessionDto } from "@polyth/session/web-api";
import { isBrowserToolRequest } from "./browserReveal.ts";

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ""; }
}

export default function BrowserActivity({ host }: { host: WebPackageHost }) {
  const [browser, setBrowser] = useState<BrowserSessionDto | null>(null);
  const [pending, setPending] = useState(false);
  const [working, setWorking] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const workingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef(false);
  const Button = host.ui.components.Button;
  const Globe = host.ui.icons.globe;

  useEffect(() => {
    let cancelled = false;
    let request: Promise<void> | null = null;
    let refreshQueued = false;
    let scopeKey = "";
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDeadline = 0;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = (retry = false) => {
      const { activeProjectId, activeSessionId } = host.store.getSnapshot();
      const nextScope = activeProjectId && activeSessionId ? `${activeProjectId}:${activeSessionId}` : "";
      if (nextScope !== scopeKey) {
        scopeKey = nextScope;
        setBrowser(null);
        pendingRef.current = false;
        setPending(false);
        setWorking(false);
        setAction(null);
        if (workingTimer.current) {
          clearTimeout(workingTimer.current);
          workingTimer.current = null;
        }
      }
      if (!activeProjectId || !activeSessionId) return;
      if (request) {
        refreshQueued = true;
        if (retry && retryDeadline > Date.now() && !retryTimer) retryTimer = setTimeout(() => { retryTimer = null; refresh(true); }, 450);
        return;
      }
      const generation = scopeKey;
      request = api.browserList(activeProjectId).then((sessions) => {
        if (cancelled || generation !== scopeKey) return;
        const next = sessions.find((session) => session.sessionId === activeSessionId && session.status !== "closed") ?? null;
        setBrowser(next);
        if (retry && !next && retryDeadline > Date.now()) retryTimer = setTimeout(() => { retryTimer = null; refresh(true); }, 450);
        if (next) {
          if (pollTimer) clearTimeout(pollTimer);
          pollTimer = setTimeout(() => { pollTimer = null; refresh(); }, 5000);
        }
      }).catch(() => {
        // The activity affordance is best effort; the Browser surface owns
        // actionable errors when the user opens it.
      }).finally(() => {
        request = null;
        if (refreshQueued && !cancelled) {
          refreshQueued = false;
          refresh();
        }
      });
    };
    refresh();
    const offStore = host.store.subscribe(() => {
      const snap = host.store.getSnapshot();
      const nextScope = snap.activeProjectId && snap.activeSessionId ? `${snap.activeProjectId}:${snap.activeSessionId}` : "";
      if (nextScope !== scopeKey) refresh();
    });
    const offEvents = host.sessions.subscribeEvents((event) => {
      if (event.sessionId !== host.store.getSnapshot().activeSessionId) return;
      const browserRequest = event.type === "package-tool/requested" && isBrowserToolRequest(event);
      const permissionFinished = pendingRef.current && (event.type === "permission/resolved" || event.type === "permission/expired");
      if (!event.type.startsWith("browser/") && !browserRequest && !permissionFinished) return;
      const eventData = event.data as { actor?: unknown; actionSummary?: unknown };
      if ((event.type === "browser/action-requested" && eventData.actor === "agent") || browserRequest) {
        setWorking(true);
        if (browserRequest) {
          pendingRef.current = true;
          setPending(true);
        }
        if (event.type === "browser/action-requested" && typeof eventData.actionSummary === "string") setAction(eventData.actionSummary);
        if (workingTimer.current) clearTimeout(workingTimer.current);
        workingTimer.current = setTimeout(() => setWorking(false), 4000);
      }
      if (event.type === "browser/action-requested") {
        pendingRef.current = false;
        setPending(false);
      }
      if (event.type === "browser/action-completed" || event.type === "browser/action-failed" || permissionFinished) {
        setWorking(false);
        setAction(null);
      }
      if (event.type === "permission/resolved" || event.type === "permission/expired") {
        setWorking(false);
        setAction(null);
        pendingRef.current = false;
        setPending(false);
      }
      if (workingTimer.current && (
        event.type === "browser/action-completed"
        || event.type === "browser/action-failed"
        || event.type === "permission/resolved"
        || event.type === "permission/expired"
      )) {
        clearTimeout(workingTimer.current);
        workingTimer.current = null;
      }
      if (browserRequest) retryDeadline = Date.now() + 8000;
      refresh(browserRequest);
    });
    return () => {
      cancelled = true;
      offStore();
      offEvents();
      if (retryTimer) clearTimeout(retryTimer);
      if (pollTimer) clearTimeout(pollTimer);
      if (workingTimer.current) clearTimeout(workingTimer.current);
    };
  }, [host]);

  if (!browser && !pending) return null;
  const domain = hostOf(browser?.url ?? "");
  const state = pending && !browser
    ? host.ui.locale.translate("previewview.connectingToBrowser")
    : browser?.agentPaused
    ? host.ui.locale.translate("previewview.agentPaused")
    : working || browser?.controller === "agent"
      ? action
        ? `${host.ui.locale.translate("previewview.agentControlling")} · ${action}`
        : host.ui.locale.translate("previewview.agentControlling")
      : browser?.controller === "user"
        ? host.ui.locale.translate("previewview.youHaveControl")
        : host.ui.locale.translate("previewview.browserIdle");
  const identity = domain || host.ui.locale.translate("previewview.browserIdle");
  return createElement(Button, {
    size: "sm",
    variant: "ghost",
    className: "browser-activity-affordance",
    title: `${host.ui.locale.translate("previewview.viewBrowser")} · ${identity} · ${state}`,
    onClick: () => host.navigation.openWorkspacePane("browser"),
    "aria-label": `${host.ui.locale.translate("previewview.browser")} · ${identity} · ${state}`,
  },
  Globe ? createElement(Globe) : null,
  createElement("span", { className: "browser-activity-label" }, host.ui.locale.translate("previewview.browser")),
  " · ",
  createElement("span", { className: "browser-activity-domain" }, identity),
  " · ",
  createElement("span", { className: "browser-activity-state" }, state),
  );
}
