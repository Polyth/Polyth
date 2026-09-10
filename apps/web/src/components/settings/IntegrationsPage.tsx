import { PageHead } from "./parts.tsx";
import { tr } from "../../i18n/index.ts";
import SlotHost from "../slots/SlotHost.ts";

export default function IntegrationsPage() {
  return <>
    <PageHead title={tr("settings.integrationspage.integrations")} />
    <SlotHost slot="settings.integrations" />
  </>;
}
