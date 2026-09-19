import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { GalleryWidget } from "./GalleryWidget.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.widgets.registerPlugin({
      id: "gallery",
      name: "Gallery",
      widgets: [
        {
          id: "gallery.canvas",
          title: "Gallery",
          description: "Browse generated images, annotate them, and send them to a model.",
          kind: "widget",
          defaultSlot: "workspace.main",
          supportedSlots: [
            "workspace.main",
            "workspace.left",
            "workspace.right",
            "workspace.bottom",
            "workspace.floating",
          ],
          defaultVisible: false,
          order: 40,
          category: "Gallery",
          zone: "main",
          supportedZones: ["main", "left", "right", "bottom", "floating"],
          recommendedSize: { w: 8, h: 8 },
          defaultSize: { w: 8, h: 8 },
          minSize: { w: 4, h: 4 },
          maxSize: { w: 24, h: 60 },
          audience: "standard",
          scope: "workspace",
          resizable: true,
          // Annotations are project-scoped browser state; a second instance
          // would race the same localStorage map, so the widget is a singleton
          // that navigates folders instead of being duplicated.
          duplicatable: false,
          settingsSchema: {
            type: "object",
            properties: {
              folder: {
                type: "string",
                title: "Folder",
                description: "Project-relative folder to browse. Empty means the project root.",
                default: "",
              },
              recursive: {
                type: "boolean",
                title: "Include subfolders",
                default: true,
              },
            },
          },
          render: (context) => createElement(GalleryWidget, { ...context, host }),
        },
      ],
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
