import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { GalleryWidget } from "./GalleryWidget.tsx";
import { createGalleryTranslate } from "./galleryI18n.ts";

export default defineWebPackage((host) => () => {
  const t = createGalleryTranslate(host.ui.locale.get());
  const off = [
    host.widgets.registerPlugin({
      id: "gallery",
      name: t("gallery.title"),
      widgets: [
        {
          id: "gallery.canvas",
          title: t("gallery.title"),
          description: t("gallery.subtitle"),
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
          category: t("gallery.title"),
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
                title: t("gallery.folder"),
                description: t("gallery.folderDescription"),
                default: "",
              },
              recursive: {
                type: "boolean",
                title: t("gallery.recursive"),
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
