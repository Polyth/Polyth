import "./styles.css";
import { createElement, useEffect, useState } from "react";
import { createApiTransport, defineWebPackage, type WebPackageHost } from "@polyth/web-sdk";
import { installGitlabAccounts } from "./Accounts.tsx";
import { installGitlabClone } from "./CloneIdentity.tsx";
import {
  CodeHostingProviderContext,
  ChangeRequestView,
  IssueDetailView,
  ChangeRequestCreatePanel,
  CodeHostingView,
  type CodeHostingProvider,
} from "@polyth/code-hosting/widgets";
import type { HostingResult } from "@polyth/code-hosting";

import { gitlabHostingText as t } from "../src/i18n/hosting.ts";

const gitlabIcon = () => createElement("svg", { className: "ui-icon", viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": true }, createElement("path", { d: "m12 21 3.4-10.5H8.6L12 21Zm0 0L3.2 10.5h5.4L12 21Zm0 0 8.8-10.5h-5.4L12 21ZM8.6 10.5l1.7-5.2c.2-.7 1.2-.7 1.4 0l.3 1 .3-1c.2-.7 1.2-.7 1.4 0l1.7 5.2H8.6Z" }));

const provider = (host: WebPackageHost): CodeHostingProvider => ({
  id: "gitlab", apiBase: "/api/gitlab",
  presentation: { serviceName: "GitLab", command: "glab", issueLabel: "Issue", issuePlural: t("githubview.issuesHeading"), changeLabel: "Merge request", changePlural: "Merge requests", changeNumberPrefix: "!", icon: gitlabIcon },
  t,
});

function GitlabView({ host }: { host: WebPackageHost }) {
  return <CodeHostingProviderContext host={host} provider={provider(host)}><CodeHostingView renderDetail={({ kind, number, close }) => kind === "changes" ? <ChangeRequestView number={number} onClose={close} /> : <IssueDetailView number={number} onClose={close} />}/></CodeHostingProviderContext>;
}

function GitlabCreateContribution({ host, props }: { host: WebPackageHost; props: Record<string, unknown> }) {
  const projectId = typeof props.projectId === "string" ? props.projectId : "";
  const [applies, setApplies] = useState(false);
  useEffect(() => {
    let active = true;
    setApplies(false);
    if (!projectId) return;
    void createApiTransport().get<HostingResult<{ binding: unknown | null }>>(`/api/gitlab/context?projectId=${encodeURIComponent(projectId)}`).then((result) => {
      if (active) setApplies(result.ok && result.data.binding !== null);
    }).catch(() => { if (active) setApplies(false); });
    return () => { active = false; };
  }, [projectId]);
  if (!applies) return null;
  const selected = props.selectedProvider;
  if (selected && selected !== "gitlab") return null;
  if (selected !== "gitlab") return <host.ui.components.Button size="sm" onClick={() => { if (typeof props.onSelectProvider === "function") (props.onSelectProvider as (id: string) => void)("gitlab"); }}>Create merge request with GitLab</host.ui.components.Button>;
  return <CodeHostingProviderContext host={host} provider={provider(host)}><ChangeRequestCreatePanel projectId={projectId} sessionId={typeof props.sessionId === "string" ? props.sessionId : null} onClose={typeof props.onClose === "function" ? (props.onClose as () => void) : () => {}} /></CodeHostingProviderContext>;
}

export default defineWebPackage((host) => () => {
  const off = [
    host.surfaces.register({ id: "gitlab", title: "GitLab", description: "Browse issues and merge requests for this project.", capabilityId: "gitlab", order: 27, component: () => createElement(GitlabView, { host }), presentation: { kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760, keepAlive: false, escape: "close" } }),
    host.capabilities.register({ id: "gitlab", label: "GitLab", plainDescription: "Browse issues and merge requests for this project.", keywords: ["gitlab", "issues", "merge requests"], standardTier: "more", standardRank: 17, open: () => host.navigation.openWorkspacePane("gitlab"), available: () => true }),
    host.slots.register({ slot: "git.change-request.create", id: "gitlab.create", render: (props) => <GitlabCreateContribution host={host} props={props} /> }),
    ...installGitlabAccounts(host),
    ...installGitlabClone(host),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
