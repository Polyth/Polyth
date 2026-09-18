import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import RecapSettings from "./RecapSettings.tsx";
import RecapStrip from "./RecapStrip.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({
      id: "recap",
      packageId: "recap",
      label: "Recap",
      group: "Workspace",
      icon: "assist",
      order: 45,
      component: () => createElement(RecapSettings, { host }),
    }),
    host.slots.register({
      slot: "session.timeline.after",
      id: "recap.session-tail",
      order: 5,
      render: (context) => typeof context.sessionId === "string"
        ? createElement(RecapStrip, { host, sessionId: context.sessionId })
        : null,
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
