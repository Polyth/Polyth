import "./styles.css";
import { defineWebPackage } from "@polyth/web-sdk";
import { HomeAssistantSettings, HOME_ASSISTANT_WIDGET_PLUGIN } from "./homeAssistantPlugin.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({ id: "home-assistant", packageId: "home-assistant", label: "Home Assistant", group: "Customize", icon: "home", order: 60, component: HomeAssistantSettings }),
    host.widgets.registerPlugin(HOME_ASSISTANT_WIDGET_PLUGIN),
    host.projectContext.register({
      id: "home-assistant.seed",
      order: 60,
      getSnapshot: () => ({
        title: "Home Assistant",
        recommendedWidgetIds: ["home-assistant.connection"],
      }),
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
