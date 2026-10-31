import "@polyth/code-hosting/widgets/styles.css";
import "./styles.css";
import { createElement, useEffect, useState } from "react";
import { createApiTransport, defineWebPackage, type WebPackageHost } from "@polyth/web-sdk";
import type { SessionEvent } from "@polyth/contracts";
import {
  ChangeRequestCreatePanel,
  ChangeRequestWatchEvent,
  ChangeRequestWatchLine,
  CodeHostingProviderContext,
  type ChangeRequestWatchPresentation,
} from "@polyth/code-hosting/widgets";
import type { HostingResult } from "@polyth/code-hosting";
import GithubView from "./GithubView.tsx";
import { githubProvider } from "./GithubView.tsx";
import { installGithubIntegration } from "./GithubIntegration.tsx";
import { GITHUB_WIDGET_PLUGIN } from "./githubPlugin.tsx";
import { GithubLinkDialog } from "./GithubLinkDialog.tsx";
import { attachGithubLink, parseGithubUrl, tryAttachGithubUrl } from "./attachments.ts";
import { githubTour } from "./onboardingTour.ts";
import GithubConflictTimelineEvent from "./GithubConflictTimelineEvent.tsx";

function GithubCreateContribution({ host, props }: { host: WebPackageHost; props: Record<string, unknown> }) {
  const projectId = typeof props.projectId === "string" ? props.projectId : "";
  const [applies, setApplies] = useState(false);
  useEffect(() => {
    let active = true;
    setApplies(false);
    if (!projectId) return;
    void createApiTransport().get<HostingResult<{ remotes: Array<{ hostname: string }> }>>(`/api/github/context?projectId=${encodeURIComponent(projectId)}`).then((result) => {
      if (active) setApplies(result.ok && result.data.remotes.some((remote) => remote.hostname === "github.com"));
    }).catch(() => { if (active) setApplies(false); });
    return () => { active = false; };
  }, [projectId]);
  if (!applies) return null;
  const selected = props.selectedProvider;
  if (selected && selected !== "github") return null;
  if (selected !== "github") return <host.ui.components.Button size="sm" onClick={() => { if (typeof props.onSelectProvider === "function") (props.onSelectProvider as (id: string) => void)("github"); }}>{host.ui.locale.translate("githubview.createPullRequestWithGithub")}</host.ui.components.Button>;
  return <CodeHostingProviderContext host={host} provider={githubProvider(host)}><ChangeRequestCreatePanel projectId={projectId} sessionId={typeof props.sessionId === "string" ? props.sessionId : null} onClose={typeof props.onClose === "function" ? props.onClose as () => void : () => {}} /></CodeHostingProviderContext>;
}

/** The watch's words and routes for GitHub; `prwatch.*` strings are this package's. */
const watchPresentation = (host: WebPackageHost): ChangeRequestWatchPresentation => ({
  provider: "github",
  apiBase: "/api/github",
  abbreviation: "PR",
  numberPrefix: "#",
  surfaceId: "github",
  icon: () => host.ui.icons.pullRequest?.() ?? host.ui.icons.github?.() ?? null,
  t: host.ui.locale.translate,
});

export default defineWebPackage((host) => () => {
  const off = [
    host.onboarding
      ? host.onboarding.registerTour(githubTour(host.ui.locale.translate))
      : () => {},
    host.surfaces.register({ id: "github", title: "GitHub", description: host.ui.locale.translate("githubview.issuesAndPullRequestsFor"), capabilityId: "github", order: 26, component: () => createElement(GithubView, { host }), presentation: { kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760, keepAlive: false, escape: "close" } }),
    host.capabilities.register({ id: "github", label: "GitHub", plainDescription: host.ui.locale.translate("githubview.issuesAndPullRequestsFor"), keywords: ["github", "issues", "pull requests", "pr"], standardTier: "more", standardRank: 16, defaultRails: { engineering: "right", operations: "right" }, open: () => host.navigation.openWorkspacePane("github"), available: () => true }),
    host.widgets.registerPlugin(GITHUB_WIDGET_PLUGIN),
    host.slots.register({
      slot: "session.timeline.event",
      id: "github.conflict-card",
      order: 30,
      meta: { eventTypes: ["github/conflict-resolution-started"] },
      render: (props) => <GithubConflictTimelineEvent host={host} event={props.event as SessionEvent} />,
    }),
    host.slots.register({
      slot: "session.timeline.event",
      id: "github.pr-watch-fact",
      order: 30,
      meta: { eventTypes: ["github/pr-watch"] },
      render: (props) => <ChangeRequestWatchEvent
        event={props.event as SessionEvent}
        presentation={watchPresentation(host)}
        host={host}
        projectId={typeof props.projectId === "string" ? props.projectId : null}
      />,
    }),
    // While the chat watches a pull request: one line above the composer,
    // just before the cards that answer the composer itself.
    host.slots.register({
      slot: "session.composer.before",
      id: "github.pr-watch",
      order: 900,
      meta: { title: host.ui.locale.translate("prwatch.slotTitle") },
      render: (props) => <ChangeRequestWatchLine
        key={typeof props.sessionId === "string" ? props.sessionId : "none"}
        host={host}
        presentation={watchPresentation(host)}
        projectId={typeof props.projectId === "string" ? props.projectId : null}
        sessionId={typeof props.sessionId === "string" ? props.sessionId : null}
      />,
    }),
    host.slots.register({ slot: "git.change-request.create", id: "github.create", render: (props) => <GithubCreateContribution host={host} props={props} /> }),
    ...installGithubIntegration(host),
    ...(host.composer
      ? [
          // Composer Add-menu item: link a GitHub issue or pull request.
          host.composer.registerAddMenuItem({
            id: "github.link",
            label: () => host.ui.locale.translate("githubattach.menuLabel"),
            shortLabel: "GitHub",
            description: () => host.ui.locale.translate("githubattach.menuDescription"),
            icon: () => host.ui.icons.github?.() ?? null,
            order: 10,
            isAvailable: (context) => context.projectId !== null,
            activate: (context) => {
              context.openDialog((close) => createElement(GithubLinkDialog, {
                attachGithub: (url: string) => context.projectId
                  ? attachGithubLink(context.projectId, context.sessionId, url)
                  : Promise.resolve({
                      ok: false as const,
                      code: "no-repo" as const,
                      reason: host.ui.locale.translate("githubattach.openProjectFirst"),
                    }),
                onClose: close,
              }));
            },
          }),
          // Paste a lone matching GitHub PR/issue URL into a composer pill.
          host.composer.registerPasteHandler({
            id: "github.url",
            match: (text) => parseGithubUrl(text) !== null,
            handle: async (context, text) => {
              if (!context.projectId) return false;
              return tryAttachGithubUrl(context.projectId, context.sessionId, text);
            },
          }),
        ]
      : []),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
