import "./styles.css";
import { defineWebPackage } from "@polyth/web-sdk";
import { HomeAssistantSettings, HOME_ASSISTANT_WIDGET_PLUGIN } from "./homeAssistantPlugin.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({ id: "home-assistant", packageId: "home-assistant", label: "Home Assistant", group: "Customize", icon: "🏠", order: 60, component: HomeAssistantSettings }),
    host.widgets.registerPlugin(HOME_ASSISTANT_WIDGET_PLUGIN),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
