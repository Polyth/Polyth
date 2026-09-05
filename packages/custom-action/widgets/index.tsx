import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { CustomActionSettings, CustomActionWidget } from "./CustomActionWidget.tsx";

export default defineWebPackage((host) => () => {
  const unregister = host.widgets.registerPlugin({
    id: "custom-action",
    name: "Custom Action",
    widgets: [{
      id: "custom-action.command",
      title: "Custom action",
      description: "Choose an icon and run any project command with one press.",
      kind: "mini-widget",
      defaultSlot: "session.header.actions",
      supportedSlots: [
        "session.header.actions",
        "composer.leading",
        "composer.trailing",
        "workspace.header",
        "workspace.main",
      ],
      category: "Custom Action",
      capabilities: ["terminal"],
      defaultVisible: false,
      audience: "standard",
      scope: "workspace",
      duplicatable: true,
      resizable: false,
      defaultSize: { w: 2, h: 2 },
      minSize: { w: 1, h: 1 },
      render: (context) => createElement(CustomActionWidget, {
        ...context,
        openTerminal: () => host.navigation.openWorkspacePane("terminal"),
      }),
      settingsRender: (context) => createElement(CustomActionSettings, context),
    }],
  });
  return unregister;
});
