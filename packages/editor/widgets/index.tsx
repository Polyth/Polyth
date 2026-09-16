import { lazy } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { registerEditorSurface } from "../../../apps/web/src/resources/views.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import "./styles.css";

const EditorRuntime = lazy(() => import("./runtime.tsx"));

export default defineWebPackage((host) => () => {
  const off = [
    registerEditorSurface(EditorRuntime),
    host.workbench.profiles.register({
      id: "authoring",
      label: tr("editor.profile.authoring"),
      description: tr("editor.profile.authoringDescription"),
      order: 10,
      projectAffinity: { directions: ["research"], recommended: true },
      defaultLayout: {
        surfaces: [
          { surface: "session", region: "primary", active: true },
          { surface: "files", region: "end" },
        ],
      },
      presentation: { text: "prose" },
    }),
    host.workbench.profiles.register({
      id: "development",
      label: tr("editor.profile.development"),
      description: tr("editor.profile.developmentDescription"),
      order: 20,
      projectAffinity: { directions: ["engineering"], recommended: true },
      defaultLayout: {
        surfaces: [
          { surface: "files", region: "primary", active: true },
          { surface: "session", region: "end" },
          { surface: "git", region: "start" },
          { surface: "terminal", region: "bottom" },
        ],
      },
      presentation: { text: "code" },
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
