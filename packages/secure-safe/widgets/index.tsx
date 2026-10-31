import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import CredentialVaultCard from "./CredentialVaultCard.tsx";
import CredentialVaultPage from "./CredentialVaultPage.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";

export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({
      id: "secure-safe",
      packageId: "secure-safe",
      label: tr("settings.securesafepage.secureSafe"),
      group: "Engineering",
      icon: "lock",
      order: 50,
      component: CredentialVaultPage,
    }),
    host.slots.register({
      slot: "session.timeline.after",
      id: "secure-safe.requests",
      order: 10,
      render: (context) => createElement(CredentialVaultCard, {
        secrets: Array.isArray(context.secrets) ? context.secrets : [],
      }),
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
