import { lazy } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { registerEditorSurface } from "../../../apps/web/src/resources/views.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { bindEditorIntelligenceSlots } from "./intelligence.ts";
import "./styles.css";

const EditorRuntime = lazy(() => import("./runtime.tsx"));

export default defineWebPackage((host) => () => {
  // The editor owns CodeMirror; packages feed it language smarts through the
  // `editor.intelligence` slot. The host exposes `list` only, so a package that
  // registers/removes a provider announces it with the change event
  // (EDITOR_INTELLIGENCE_CHANGED_EVENT). A host that grows a slot subscription
  // is picked up automatically through the optional `subscribe`.
  const unbindIntelligence = bindEditorIntelligenceSlots(host.slots);
  const off = [
    unbindIntelligence,
    registerEditorSurface(EditorRuntime),
    host.slots.register({
      slot: "commandPalette.commands",
      id: "editor.palette",
      render: () => null,
      meta: {
        commands: [
          { id: "editor.definition", label: tr("editor.command.goToDefinition"), group: "Editor", run: () => window.dispatchEvent(new CustomEvent("polyth:editor-command", { detail: { action: "definition" } })) },
          { id: "editor.peek", label: tr("editor.command.peekDefinition"), group: "Editor", run: () => window.dispatchEvent(new CustomEvent("polyth:editor-command", { detail: { action: "peek" } })) },
          { id: "editor.references", label: tr("editor.command.findReferences"), group: "Editor", run: () => window.dispatchEvent(new CustomEvent("polyth:editor-command", { detail: { action: "references" } })) },
          { id: "editor.rename", label: tr("editor.command.renameSymbol"), group: "Editor", run: () => window.dispatchEvent(new CustomEvent("polyth:editor-command", { detail: { action: "rename" } })) },
        ],
      },
    }),
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
