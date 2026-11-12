import "./styles.css";
import { createElement } from "react";
import { defineWebPackage, type SurfaceComponentProps } from "@polyth/web-sdk";
import { withSurfaceContent } from "@polyth/web-sdk/surface-content";
import { catalogStrings } from "../src/strings.ts";
import IntegrationsView from "./IntegrationsView.tsx";

/** The catalog's workspace surface. Other packages name it by this string only
 *  (`openWorkspacePane("integration-catalog", "<entry id>")`). */
export const CATALOG_SURFACE_ID = "integration-catalog";

export default defineWebPackage((host) => () => {
  const strings = () => catalogStrings(host.ui.locale.get());
  const open = () => { host.navigation.openWorkspacePane(CATALOG_SURFACE_ID); };
  const disposers = [
    // A tool, so a package window: the host ModuleView owns the title, Back and
    // Close, safe areas, the phone layer, resize and fullscreen. The content
    // owns its own split, so it runs edge to edge.
    host.surfaces.register({
      id: CATALOG_SURFACE_ID,
      title: strings().title,
      description: strings().subtitle,
      capabilityId: "integrations",
      order: 43,
      // `resource` is an entry id: `openWorkspacePane(id, entryId)` opens one service.
      component: (props: SurfaceComponentProps) => createElement(IntegrationsView, {
        ui: host.ui,
        projectId: props.projectId ?? null,
        resource: props.resource ?? null,
        resourceSeq: props.resourceSeq ?? 0,
        locale: host.ui.locale.get(),
        // The content must not import the host: it is handed the one route it
        // needs, to where a manually added server lives.
        onOpenMcpSettings: () => host.navigation.openSettingsPage("mcp"),
      }),
      presentation: withSurfaceContent({
        kind: "workspace",
        defaultRatio: 0.5,
        minWidth: 340,
        preferredMaxWidth: 1100,
        keepAlive: true,
        escape: "close",
      }, "workspace"),
    }),
    host.capabilities.register({
      id: "integrations",
      label: strings().title,
      plainDescription: strings().subtitle,
      keywords: [
        "integrations", "integration", "mcp", "catalog", "connector", "servers",
        "linear", "notion", "github", "sentry", "figma", "supabase", "jira", "confluence",
        "datadog", "vercel", "cloudflare", "stripe", "zapier", "postgres",
        "інтеграції", "каталог",
      ],
      standardTier: "more",
      standardRank: 43,
      // A home on the rail, not only the command palette: a directory you have
      // to remember a shortcut for is a directory nobody opens.
      defaultRails: { general: "right", engineering: "right" },
      open,
      available: () => true,
    }),
    // The palette entry says what the person wants to do, not what the window
    // is called: a directory is found by the verb, not the noun.
    host.slots.register({
      slot: "commandPalette.commands",
      id: "integrations.palette-commands",
      render: () => null,
      meta: {
        commands: [{
          id: "integrations.connect",
          label: strings().connectCommand,
          group: strings().title,
          icon: "server",
          keywords: [
            "connect", "integration", "integrations", "mcp", "server", "tool",
            "linear", "notion", "github", "figma", "sentry", "supabase", "stripe",
            "jira", "datadog", "vercel", "cloudflare", "zapier",
            "підключити", "інтеграції", "конектор",
          ],
          run: open,
        }],
      },
    }),
  ];
  return () => {
    for (const dispose of disposers.toReversed()) dispose();
  };
});
