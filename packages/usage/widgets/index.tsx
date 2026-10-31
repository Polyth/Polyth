import "./usageAnalytics.css";
import "./usageWidgets.css";
import { defineWebPackage } from "@polyth/web-sdk";
import { UsageDashboard } from "./usage/UsageDashboard.tsx";
import { UsageLimitsSettings } from "./usage/UsageLimitsSettings.tsx";
import {
  effectiveUsageView,
  getUsageDashboardPrefs,
  replaceUsageDashboardPrefs,
  subscribeUsageDashboardPrefs,
} from "./usage/dashboardLayout.ts";
import {
  getUsageLimitsPrefs,
  replaceUsageLimitsPrefs,
  subscribeUsageLimitsPrefs,
} from "./usage/limitsPrefs.ts";
import { createUsageWidgetPlugin } from "./usagePlugin.tsx";
import { ContextCacheLine } from "./contextCache.tsx";
import { createUsageStatusbarPlugin } from "./statusbarSegments.tsx";
import {
  cachedUsageLimits,
  loadUsageLimits,
  prefetchUsageLimits,
  refreshUsageLimitSource,
} from "./usage/limitsClient.ts";
import {
  getUsageAlertPrefs,
  replaceUsageAlertPrefs,
  subscribeUsageAlertPrefs,
} from "./usage/alertsPrefs.ts";
import { startUsageAlerts } from "./usage/alertsController.ts";
import { loadAlertLedgers, saveAlertLedgers } from "./usage/alertLedgerClient.ts";
import { requestUsageView } from "./usage/viewRequest.ts";
import { queryFor, viewerTimezone } from "./usage/UsageDashboard.tsx";
import { ensureUsageIdentity, prefetchUsageStats } from "./usage/usageStatsClient.ts";
import { usageTour } from "./onboardingTour.ts";

/** Give the shell's own startup requests a head start before warming Usage. */
const PREFETCH_DELAY_MS = 1_500;

/**
 * Warm what the Usage pane shows first: the current identity, the report for
 * the scope the dashboard opens in, and the limits snapshot. Opening the pane
 * then paints from the in-memory cache instead of waiting on the server, even
 * on the first visit of a fresh tab. Hidden documents never pay for this.
 */
function scheduleUsagePrefetch(
  snapshot: () => { activeSessionId: string | null; activeProjectId: string | null },
): () => void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return () => undefined;
  const timer = setTimeout(() => {
    const { activeSessionId, activeProjectId } = snapshot();
    const prefs = getUsageDashboardPrefs();
    const view = effectiveUsageView(prefs.view, activeSessionId);
    const query = queryFor(view, activeSessionId, activeProjectId, prefs.range, viewerTimezone());
    const scoped = view === "global" || (view === "session" ? !!activeSessionId : view === "project" && !!activeProjectId);
    void ensureUsageIdentity(true)
      .then(() => (scoped ? prefetchUsageStats(query) : undefined))
      .catch(() => undefined);
    void prefetchUsageLimits();
  }, PREFETCH_DELAY_MS);
  return () => clearTimeout(timer);
}

export default defineWebPackage((host) => () => {
  const translate = (key: string, values?: Record<string, string | number>) => host.ui.locale.translate(key, values);
  const off = [
    host.onboarding
      ? host.onboarding.registerTour(usageTour(translate))
      : () => {},
    scheduleUsagePrefetch(() => host.store.getSnapshot()),
    host.preferences.register("package.usage.limits", {
      read: getUsageLimitsPrefs,
      write: replaceUsageLimitsPrefs,
      subscribe: subscribeUsageLimitsPrefs,
    }),
    host.preferences.register("package.usage.alerts", {
      read: getUsageAlertPrefs,
      write: replaceUsageAlertPrefs,
      subscribe: subscribeUsageAlertPrefs,
    }),
    // Older hosts have no notification stack; the settings page then hides previews.
    host.notifications
      ? startUsageAlerts({
        notifications: host.notifications,
        sessions: host.sessions,
        visibleSessionId: () => {
          const snapshot = host.store.getSnapshot();
          return snapshot.activePage ? null : snapshot.activeSessionId;
        },
        openLimits: () => {
          requestUsageView("limits");
          host.navigation.openWorkspacePane("usage");
        },
        openSettings: () => host.navigation.openSettingsPage("usage", { itemId: "usage.limits.sources" }),
        openSession: (sessionId) => void host.conversation.openSession(sessionId).catch(() => undefined),
        loadLimits: () => loadUsageLimits(),
        refreshLimitSource: (providerId) => refreshUsageLimitSource(providerId),
        cachedLimits: cachedUsageLimits,
        ledgerStore: { load: loadAlertLedgers, save: saveAlertLedgers },
      })
      : () => {},
    host.preferences.register("package.usage.dashboard", {
      read: getUsageDashboardPrefs,
      write: replaceUsageDashboardPrefs,
      subscribe: subscribeUsageDashboardPrefs,
    }),
    host.settings.registerPage({
      id: "usage",
      packageId: "usage",
      label: translate("settings.pages.usage"),
      group: "Workspace",
      icon: "usage",
      order: 45,
      component: UsageLimitsSettings,
    }),
    host.settings.registerItems([
      {
        id: "usage.limits.display",
        pageId: "usage",
        label: translate("usage.limitValues"),
        description: translate("usage.limitValuesDescription"),
        keywords: ["usage", "limits", "remaining", "reset"],
        focusTarget: "usage.limits.display",
      },
      {
        id: "usage.limits.pace",
        pageId: "usage",
        label: translate("usage.limitPace"),
        description: translate("usage.limitPaceDescription"),
        keywords: ["usage", "limits", "pace", "projection", "exhaust"],
        focusTarget: "usage.limits.pace",
      },
      {
        id: "usage.limits.barColour",
        pageId: "usage",
        label: translate("usage.limitBarColour"),
        description: translate("usage.limitBarColourDescription"),
        keywords: ["usage", "limits", "colour", "color", "bar", "pace", "percent", "static"],
        focusTarget: "usage.limits.barColour",
      },
      {
        id: "usage.limits.warnings",
        pageId: "usage",
        label: translate("usage.limitWarnings"),
        description: translate("usage.limitWarningsDescription"),
        keywords: ["usage", "limits", "warning", "threshold"],
        focusTarget: "usage.limits.warnings",
      },
      {
        id: "usage.alerts",
        pageId: "usage",
        label: translate("usage.alerts"),
        description: translate("usage.alertsDescription"),
        keywords: ["usage", "notifications", "alerts", "pause", "toast"],
        focusTarget: "usage.alerts",
      },
      {
        id: "usage.alerts.limits",
        pageId: "usage",
        label: translate("usage.limitAlerts"),
        description: translate("usage.limitAlertsDescription"),
        keywords: ["usage", "limits", "notifications", "alerts", "pace", "low", "exhausted", "reset"],
        focusTarget: "usage.alerts.limits",
      },
      {
        id: "usage.alerts.turns",
        pageId: "usage",
        label: translate("usage.turnAlerts"),
        description: translate("usage.turnAlertsDescription"),
        keywords: ["usage", "turn", "summary", "tokens", "cost", "cache", "notifications"],
        focusTarget: "usage.alerts.turns",
      },
      {
        id: "usage.limits.sources",
        pageId: "usage",
        label: translate("usage.limitSources"),
        description: translate("usage.limitSourcesDescription"),
        keywords: ["usage", "limits", "provider", "harness", "balance"],
        focusTarget: "usage.limits.sources",
      },
    ]),
    host.surfaces.register({
      id: "usage",
      title: translate("railsurfaces.usage"),
      description: translate("usage.surfaceDescription"),
      capabilityId: "usage",
      order: 50,
      component: UsageDashboard,
      presentation: {
        kind: "workspace",
        defaultRatio: 0.62,
        minWidth: 320,
        preferredMaxWidth: 1120,
        keepAlive: true,
        escape: "close",
      },
    }),
    host.widgets.registerPlugin(createUsageWidgetPlugin(translate)),
    // Context and spend, prompt cache and the tightest limit as status-bar
    // segments; a click opens the matching Usage view.
    host.widgets.registerPlugin(createUsageStatusbarPlugin(translate, (view) => {
      requestUsageView(view);
      host.navigation.openWorkspacePane("usage");
    })),
    host.slots.register({
      slot: "composer.context.details",
      id: "usage.context-cache",
      order: 10,
      render: (context) => <ContextCacheLine sessionId={typeof context.sessionId === "string" ? context.sessionId : null} />,
    }),
    host.capabilities.register({
      id: "usage",
      label: translate("capabilities.usageCost"),
      plainDescription: translate("capabilities.seeWhatTheWorkIsUsingAnd"),
      keywords: ["usage", "stats", "tokens", "cache", "cost", "performance", "limits", "quota", "balance", "pace"],
      standardTier: "more",
      standardRank: 15,
      defaultRails: { general: "right", engineering: "right" },
      open: () => host.navigation.openWorkspacePane("usage"),
      available: () => true,
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
