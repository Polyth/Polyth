// Settings > Apps: what other programs may do with this account. An app is a
// bearer token for the Client API (docs/dev/client-api.md), asked for with a code
// or created here. Same list, confirmation and form as Command line, in the
// words of an app, plus the owner's one extra switch: letting it approve agents.
import { tr } from "../../i18n/index.ts";
import { Notice } from "../ui/index.ts";
import { CreateToken, DeviceConfirm, TokenList, useCliAccess } from "./CommandLinePage.tsx";
import { EmptyState, PageHead, Section } from "./parts.tsx";
import { useOwnerReauth } from "./ownerReauth.tsx";

export default function AppsPage() {
  const { state, loadError, refresh } = useCliAccess();
  const { withReauth, prompt } = useOwnerReauth();
  const blurb = <PageHead blurb={tr("settings.apps.blurb")} />;

  if (loadError && !state) {
    return (
      <div className="cli-page">
        {blurb}
        <EmptyState title={tr("settings.apps.loadFailed")} body={loadError} />
      </div>
    );
  }
  if (!state) {
    return (
      <div className="cli-page">
        {blurb}
        <EmptyState title={tr("common.loading")} busy />
      </div>
    );
  }
  return (
    <div className="cli-page">
      {blurb}
      {state.readOnly
        ? <Notice tone="info">{tr("settings.apps.manageInBrowser")}</Notice>
        : (
          <DeviceConfirm
            withReauth={withReauth}
            onDone={refresh}
            copy={{
              title: tr("settings.apps.confirmTitle"),
              hint: tr("settings.apps.confirmHint"),
              codeLabel: tr("settings.apps.codeLabel"),
              codeUnknown: tr("settings.apps.codeUnknown"),
              approved: tr("settings.apps.approved"),
            }}
          />
        )}
      <TokenList
        tokens={state.tokens.filter((token) => token.kind === "app")}
        readOnly={state.readOnly}
        onChanged={refresh}
        copy={{ title: tr("settings.apps.listTitle"), empty: tr("settings.apps.empty"), emptyBody: tr("settings.apps.emptyBody") }}
      />
      {!state.readOnly && <CreateToken app state={state} withReauth={withReauth} onCreated={refresh} />}
      <Section title={tr("settings.apps.buildTitle")}>
        <ul className="cli-help">
          <li>{tr("settings.apps.buildGuide")} <code>docs/dev/client-api.md</code></li>
          <li>{tr("settings.apps.buildOpenApi")} <code>docs/api/client-v1.openapi.json</code></li>
          <li>{tr("settings.apps.buildPackage")} <code>@polyth/client</code></li>
        </ul>
      </Section>
      {prompt}
    </div>
  );
}
