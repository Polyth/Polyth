import "./styles.css";
import { createElement } from "react";
import type { ModelDescriptor } from "@polyth/contracts";
import { defineWebPackage } from "@polyth/web-sdk";
import { createPeakPricingCopy } from "./copy.ts";
import PeakPricingIndicator from "./PeakPricingIndicator.tsx";
import PeakPricingSettings from "./PeakPricingSettings.tsx";
import PeakPricingStatusbar from "./PeakPricingStatusbar.tsx";
import { getPeakPricingPrefs, replacePeakPricingPrefs, subscribePeakPricingPrefs } from "./prefs.ts";

/**
 * Peak pricing: one quiet chip beside the model chip that says whether the
 * selected route is billed at the provider's peak or off-peak rate right now,
 * with a countdown to the next change. Settings → Peak pricing chooses how
 * much of it shows.
 *
 * The chip reads only its slot context (the effective next-turn route), so it
 * works for every harness and provider the schedule knows; a route without a
 * time-of-day price renders nothing at all. The same chip is also a status-bar
 * segment that can sit at either end of the bar, read from the active
 * session's (or new chat's) route.
 */
export default defineWebPackage((host) => () => {
  const copy = createPeakPricingCopy(host.ui.locale.get()).settings;
  const off = [
    host.preferences.register("package.peak-pricing", {
      read: getPeakPricingPrefs,
      write: replacePeakPricingPrefs,
      subscribe: subscribePeakPricingPrefs,
    }),
    host.settings.registerPage({
      id: "peak-pricing",
      packageId: "peak-pricing",
      label: copy.page,
      group: "Engineering",
      // The settings glyph map has no plain clock; CalendarClock is its clock.
      icon: "schedule",
      order: 36,
      component: PeakPricingSettings,
      settingsItems: [
        {
          id: "peak-pricing.chip",
          pageId: "peak-pricing",
          label: copy.show,
          description: copy.searchChip,
          keywords: ["peak", "off-peak", "pricing", "price", "deepseek", "chip", "composer", "пік", "ціна"],
          focusTarget: "peak-pricing.chip",
        },
        {
          id: "peak-pricing.display",
          pageId: "peak-pricing",
          label: copy.display,
          description: copy.searchDisplay,
          keywords: ["peak", "pricing", "compact", "dot", "countdown", "timer", "counter", "highlight", "крапка", "таймер"],
          focusTarget: "peak-pricing.display",
        },
        {
          id: "peak-pricing.tooltip",
          pageId: "peak-pricing",
          label: copy.tooltip,
          description: copy.searchTooltip,
          keywords: ["peak", "pricing", "tooltip", "hover", "summary", "підказка"],
          focusTarget: "peak-pricing.tooltip",
        },
      ],
    }),
    host.widgets.registerPlugin({
      id: "peak-pricing-statusbar",
      name: copy.page,
      widgets: [{
        id: "peak-pricing.statusbar",
        title: copy.statusbarWidget,
        description: copy.statusbarWidgetHint,
        kind: "mini-widget",
        defaultSlot: "app.statusbar.trailing",
        supportedSlots: ["app.statusbar.leading", "app.statusbar.trailing"],
        // Shown wherever the bar is on: it renders nothing for a route
        // without a time-of-day price, so it costs other routes no space.
        defaultVisible: true,
        recommended: true,
        defaultSize: { w: 1, h: 1 },
        resizable: false,
        audience: "simple",
        order: 52,
        render: (context) => createElement(PeakPricingStatusbar, {
          host,
          projectId: typeof context.projectId === "string" ? context.projectId : null,
          sessionId: typeof context.sessionId === "string" ? context.sessionId : null,
        }),
      }],
    }),
    host.slots.register({
      slot: "composer.config",
      id: "peak-pricing.indicator",
      order: 20,
      render: (context) => {
        const model = context.model as ModelDescriptor | undefined;
        if (!model || typeof model.providerID !== "string") return null;
        const harnessId = typeof context.resolvedHarnessId === "string"
          ? context.resolvedHarnessId
          : model.harnessId;
        return createElement(PeakPricingIndicator, { model, ...(harnessId ? { harnessId } : {}) });
      },
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
