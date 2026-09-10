import type { WebPackageHost } from "@polyth/web-sdk";
import {
  CodeHostingProviderContext,
  CodeHostingView,
  type CodeHostingProvider,
} from "@polyth/code-hosting/widgets";
import { IssueDetailView } from "@polyth/code-hosting/widgets";
import PullRequestView from "./PullRequestView.tsx";

/** GitHub's thin presentation wrapper. The shared surface owns all common
 * listing, filtering, context handoff, and provider-relative API transport. */
export const githubProvider = (host: WebPackageHost): CodeHostingProvider => ({
  id: "github",
  apiBase: "/api/github",
  presentation: {
    serviceName: "GitHub",
    command: "gh",
    issueLabel: host.ui.locale.translate("githubview.issue"),
    changeLabel: host.ui.locale.translate("githubview.pr"),
    changePlural: host.ui.locale.translate("githubview.pullRequestsHeading"),
    changeNumberPrefix: "#",
    icon: () => host.ui.icons.github?.(),
  },
  t: host.ui.locale.translate,
});

export default function GithubView({ host }: { host: WebPackageHost }) {
  return (
    <CodeHostingProviderContext host={host} provider={githubProvider(host)}>
      <CodeHostingView
        renderDetail={({ kind, number, close }) => kind === "changes"
          ? <PullRequestView number={number} onClose={close} />
          : <IssueDetailView number={number} onClose={close} />}
      />
    </CodeHostingProviderContext>
  );
}
