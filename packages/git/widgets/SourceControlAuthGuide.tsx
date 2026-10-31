import type { ReactNode } from "react";
import type { SourceControlRemote } from "@polyth/contracts/source-control";
import { Button, Notice } from "../../../apps/web/src/components/ui/index.ts";
import { openWorkspacePane, setOverlay } from "../../../apps/web/src/store.ts";
import { ReadonlyRow, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { richText as rich } from "./richText.tsx";

interface SourceControlAuthGuideProps {
  /** Undefined while the remote is still being read; null when there is none. */
  remote: SourceControlRemote | null | undefined;
  /** Rows between the remote and the guide (the project's Space account). */
  children?: ReactNode;
  /** Shows the person's hosting accounts (Settings → Source control → Accounts). */
  onShowAccounts?: () => void;
}

const openPane = (id: string) => { setOverlay(null); openWorkspacePane(id); };

/**
 * Git access for the active repository. Authentication is explained, never
 * edited here: Polyth owns the repository and the selected remote, while the
 * local Git/SSH tools and the hosting-account integrations own credentials.
 * Keeping that boundary visible stops an identity from looking like a vault.
 */
export default function SourceControlAuthGuide({ remote, children, onShowAccounts }: SourceControlAuthGuideProps) {
  const isSsh = remote?.protocol === "ssh";
  const isHttps = remote?.protocol === "https" || remote?.protocol === "http";
  const host = remote?.hostname ?? "<host>";
  const verifyCommand = `ssh -T git@${host}`;
  const sshKeysUrl = remote?.hostname === "github.com"
    ? "https://github.com/settings/ssh/new"
    : remote?.hostname === "gitlab.com"
      ? "https://gitlab.com/-/user_settings/ssh_keys"
      : null;
  const accounts = onShowAccounts && <Button size="sm" variant="ghost" onClick={onShowAccounts}>{tr("gitsettings.guideAccounts")}</Button>;

  return (
    <Section title={tr("gitsettings.access")} hint={tr("gitsettings.accessHint")} itemId="git.authentication">
      <ReadonlyRow
        label={tr("gitsettings.remote")}
        hint={remote ? tr("gitsettings.remoteHint", { protocol: remote.protocol.toUpperCase() }) : remote === null ? tr("gitsettings.remoteNoneHint") : undefined}
        value={remote === undefined ? tr("gitsettings.remoteChecking") : remote ? `${remote.hostname}/${remote.fullPath}` : tr("gitsettings.remoteNone")}
        mono={Boolean(remote)}
      />
      {children}
      <details id="git-auth-setup" className="source-control-auth-guide" tabIndex={-1}>
        <summary className="source-control-auth-summary">
          <span id="git-auth-setup-title">{tr("gitsettings.accessHowTo")}</span>
        </summary>
        <Notice tone="info" heading={tr("gitsettings.guideVaultTitle")}>
          <p>{tr("gitsettings.guideVaultBody")}</p>
        </Notice>

        <div className="source-control-auth-grid" role="group" aria-label={tr("gitsettings.guideOptions")}>
          <article className={`source-control-auth-card${isSsh ? " source-control-auth-card--recommended" : ""}`}>
            <div className="source-control-auth-card-head">
              <strong>{tr("gitsettings.guideSshTitle")}</strong>
              <span>{rich("gitsettings.guideSshFor", { example: <code>git@host:org/repo.git</code> })}</span>
              {isSsh && <span className="source-control-auth-recommended">{tr("gitsettings.guideMatches")}</span>}
            </div>
            <p>{tr("gitsettings.guideSshBody")}</p>
            <ol>
              <li>{rich("gitsettings.guideSshStep1", { command: <code>ssh-keygen -t ed25519 -C &quot;you@example.com&quot;</code> })}</li>
              <li>{rich("gitsettings.guideSshStep2", { file: <code>~/.ssh/id_ed25519.pub</code> })}</li>
              <li>{rich("gitsettings.guideSshStep3", { command: <code>ssh-add ~/.ssh/id_ed25519</code> })}</li>
              <li>{rich("gitsettings.guideSshStep4", { command: <code>{verifyCommand}</code> })}</li>
            </ol>
            <div className="source-control-auth-actions">
              <Button size="sm" onClick={() => openPane("terminal")}>{tr("gitsettings.guideOpenTerminal")}</Button>
              {sshKeysUrl && (
                <Button size="sm" variant="ghost" onClick={() => window.open(sshKeysUrl, "_blank", "noopener,noreferrer")}>
                  {remote?.hostname === "github.com" ? tr("gitsettings.guideOpenGithubKeys") : tr("gitsettings.guideOpenGitlabKeys")}
                </Button>
              )}
            </div>
          </article>

          <article className={`source-control-auth-card${isHttps ? " source-control-auth-card--recommended" : ""}`}>
            <div className="source-control-auth-card-head">
              <strong>{tr("gitsettings.guideHttpsTitle")}</strong>
              <span>{rich("gitsettings.guideHttpsFor", { example: <code>https://host/org/repo.git</code> })}</span>
              {isHttps && <span className="source-control-auth-recommended">{tr("gitsettings.guideMatches")}</span>}
            </div>
            <p>{tr("gitsettings.guideHttpsBody")}</p>
            <ol>
              <li>{rich("gitsettings.guideHttpsStep1", { gh: <code>gh auth login</code>, glab: <code>glab auth login</code> })}</li>
              <li>{tr("gitsettings.guideHttpsStep2")}</li>
              <li>{rich("gitsettings.guideHttpsStep3", { example: <code>https://github.com/org/repo.git</code> })}</li>
            </ol>
            <div className="source-control-auth-actions">
              <Button size="sm" onClick={() => openPane("terminal")}>{tr("gitsettings.guideOpenTerminal")}</Button>
              {accounts}
            </div>
          </article>
        </div>

        <div className="source-control-auth-foot">
          <span>{remote ? tr("gitsettings.guideFootRemote") : tr("gitsettings.guideFootNoRemote")}</span>
          <Button size="sm" variant="ghost" onClick={() => openPane("git")}>{tr("gitsettings.openSourceControl")}</Button>
        </div>
      </details>
    </Section>
  );
}
