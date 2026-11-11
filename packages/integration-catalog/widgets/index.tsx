import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { catalogStrings } from "../src/strings.ts";
import IntegrationsPage from "./IntegrationsPage.tsx";

/** The page that shows the catalog in place of Chat. */
export const CATALOG_PAGE_ID = "integration-catalog";

export default defineWebPackage((host) => () => {
  const strings = () => catalogStrings(host.ui.locale.get());
  const disposers = [
    // Feature-detected: an older host has no package pages, and the page then
    // simply does not exist instead of breaking the package.
    ...(host.pages
      ? [host.pages.register({
        id: CATALOG_PAGE_ID,
        title: strings().title,
        component: ({ projectId, resource }) => createElement(IntegrationsPage, {
          projectId,
          // `openPage("integration-catalog", "<entry id>")` opens one service.
          resource,
          locale: host.ui.locale.get(),
          // The page itself must not import the host: it is handed the one
          // route it needs to send a person to where a manual server lives.
          onOpenMcpSettings: () => host.navigation.openSettingsPage("mcp"),
        }),
      })]
      : []),
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
      open: () => {
        host.navigation.openPage?.(CATALOG_PAGE_ID);
      },
      // Honest answer, not a guess: a host that can say whether the page is
      // registered does; an older host only tells us it has pages at all.
      available: () => typeof host.navigation.openPage === "function"
        && (host.pages?.has?.(CATALOG_PAGE_ID) ?? host.pages !== undefined),
    }),
    // The palette entry says what the person wants to do, not what the page is
    // called: a directory is found by the verb, not the noun.
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
          run: () => {
            host.navigation.openPage?.(CATALOG_PAGE_ID);
          },
        }],
      },
    }),
  ];
  return () => {
    for (const dispose of disposers.toReversed()) dispose();
  };
});
