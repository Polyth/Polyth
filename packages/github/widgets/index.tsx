import "@polyth/code-hosting/widgets/styles.css";
import { createElement, useEffect, useState } from "react";
import { createApiTransport, defineWebPackage, type WebPackageHost } from "@polyth/web-sdk";
import { ChangeRequestCreatePanel, CodeHostingProviderContext } from "@polyth/code-hosting/widgets";
import type { HostingResult } from "@polyth/code-hosting";
import GithubView from "./GithubView.tsx";
import { githubProvider } from "./GithubView.tsx";
import { installGithubIntegration } from "./GithubIntegration.tsx";
import { GITHUB_WIDGET_PLUGIN } from "./githubPlugin.tsx";

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
  if (selected !== "github") return <host.ui.components.Button size="sm" onClick={() => { if (typeof props.onSelectProvider === "function") (props.onSelectProvider as (id: string) => void)("github"); }}>Create pull request with GitHub</host.ui.components.Button>;
  return <CodeHostingProviderContext host={host} provider={githubProvider(host)}><ChangeRequestCreatePanel projectId={projectId} sessionId={typeof props.sessionId === "string" ? props.sessionId : null} onClose={typeof props.onClose === "function" ? props.onClose as () => void : () => {}} /></CodeHostingProviderContext>;
}

export default defineWebPackage((host) => () => {
  const off = [
    host.surfaces.register({ id: "github", title: "GitHub", description: "Browse issues and pull requests for this project.", capabilityId: "github", order: 26, component: () => createElement(GithubView, { host }), presentation: { kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760, keepAlive: false, escape: "close" } }),
    host.capabilities.register({ id: "github", label: "GitHub", plainDescription: "Browse issues and pull requests for this project.", keywords: ["github", "issues", "pull requests", "pr"], standardTier: "more", standardRank: 16, open: () => host.navigation.openWorkspacePane("github"), available: () => true }),
    host.widgets.registerPlugin(GITHUB_WIDGET_PLUGIN),
    host.slots.register({ slot: "git.change-request.create", id: "github.create", render: (props) => <GithubCreateContribution host={host} props={props} /> }),
    ...installGithubIntegration(host),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
