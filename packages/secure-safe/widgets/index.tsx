import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import SecureSafeCard from "./SecureSafeCard.tsx";
import SecureSafePage from "./SecureSafePage.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({
      id: "secure-safe",
      packageId: "secure-safe",
      label: "Secure Safe",
      group: "Engineering",
      icon: "🔐",
      order: 50,
      component: SecureSafePage,
    }),
    host.slots.register({
      slot: "session.timeline.after",
      id: "secure-safe.requests",
      order: 10,
      render: (context) => createElement(SecureSafeCard, {
        secrets: Array.isArray(context.secrets) ? context.secrets : [],
      }),
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
