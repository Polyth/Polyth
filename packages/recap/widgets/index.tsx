import "./styles.css";
import { createElement } from "react";
import { defineWebPackage, type ComposerDraftContext } from "@polyth/web-sdk";
import RecapSettings from "./RecapSettings.tsx";
import CalloutStrip from "./CalloutStrip.tsx";
import RecapStrip from "./RecapStrip.tsx";
import PromptAssist from "./PromptAssist.tsx";
import NextPromptSource from "./NextPromptSource.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({
      id: "recap",
      packageId: "recap",
      label: host.ui.locale.translate("settings.packagespage.sessionAssist"),
      group: "Workspace",
      icon: "recap",
      order: 45,
      component: () => createElement(RecapSettings, { host }),
    }),
    // Automatic next prompts ride on the host's suggestion chip from a
    // headless source, so they do not depend on the rail button below.
    host.slots.register({
      slot: "composer.suggestion",
      id: "recap.next-prompt",
      render: (context) => context.composerDraft
        ? createElement(NextPromptSource, { host, draft: context.composerDraft as ComposerDraftContext })
        : null,
    }),
    host.slots.register({
      slot: "session.timeline.after",
      id: "recap.callouts",
      order: 4,
      render: (context) => typeof context.sessionId === "string"
        ? createElement(CalloutStrip, { host, sessionId: context.sessionId })
        : null,
    }),
    host.slots.register({
      slot: "session.timeline.after",
      id: "recap.session-tail",
      order: 5,
      render: (context) => typeof context.sessionId === "string"
        ? createElement(RecapStrip, { host, sessionId: context.sessionId })
        : null,
    }),
    host.widgets.registerPlugin({
      id: "recap",
      name: "Session Assist",
      widgets: [{
        // Preserve existing placement and visibility preferences.
        id: "composer.next-action",
        title: host.ui.locale.translate("composer.generateNextAction"),
        description: host.ui.locale.translate("composer.improvePrompt"),
        kind: "mini-widget",
        defaultSlot: "composer.trailing",
        // Acts on the agent's turn: hidden where the composer writes only to people.
        agentOnly: true,
        supportedSlots: ["composer.leading", "composer.trailing"],
        defaultVisible: true,
        defaultSize: { w: 1, h: 1 },
        resizable: false,
        audience: "simple",
        order: 50,
        render: (context) => context.composerDraft
          ? createElement(PromptAssist, { host, draft: context.composerDraft as ComposerDraftContext })
          : null,
      }],
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
