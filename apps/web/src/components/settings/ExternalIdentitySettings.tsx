import { useCallback, useEffect, useState } from "react";
import { accountState } from "../../accounts.ts";
import { authJson } from "../../authClient.ts";
import {
  beginProviderFlow,
  configureProvider,
  listLinkedIdentities,
  listLoginProviders,
  listManagedProviders,
  setProviderEnabled,
  unlinkIdentity,
  type LinkedIdentity,
  type LoginProvider,
  type ManagedProvider,
} from "../../identityProviders.ts";
import { confirmAlert } from "../../alerts.ts";
import { Button, TextInput } from "../ui/index.ts";
import { Row } from "./parts.tsx";

const providerLabel = (kind: string): string => {
  if (kind === "github") return "GitHub";
  if (kind === "gitlab") return "GitLab";
  if (kind === "bitbucket") return "Bitbucket";
  return kind;
};

const authError = (response: Response, body: Record<string, unknown>): Error => new Error(
  typeof body.message === "string"
    ? body.message
    : typeof body.error === "string" ? body.error.replace(/-/g, " ") : `HTTP ${response.status}`,
);

export default function ExternalIdentitySettings() {
  const [providers, setProviders] = useState<LoginProvider[]>([]);
  const [managed, setManaged] = useState<ManagedProvider[]>([]);
  const [links, setLinks] = useState<LinkedIdentity[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [ownerPassword, setOwnerPassword] = useState("");
  const [githubClientId, setGithubClientId] = useState("");
  const [githubSecret, setGithubSecret] = useState("");
  const [bitbucketClientId, setBitbucketClientId] = useState("");
  const [bitbucketSecret, setBitbucketSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const secure = typeof location !== "undefined" && location.protocol === "https:";

  const refresh = useCallback(async () => {
    setError("");
    try {
      const [account, nextLinks, nextProviders] = await Promise.all([
        accountState(),
        listLinkedIdentities(),
        secure ? listLoginProviders() : Promise.resolve([]),
      ]);
      setCanManage(account.canManage);
      setLinks(nextLinks);
      setProviders(nextProviders);
      if (account.canManage) {
        const nextManaged = await listManagedProviders();
        setManaged(nextManaged);
        const github = nextManaged.find((provider) => provider.id === "github");
        const bitbucket = nextManaged.find((provider) => provider.id === "bitbucket");
        if (typeof github?.publicConfig.clientId === "string") setGithubClientId(github.publicConfig.clientId);
        if (typeof bitbucket?.publicConfig.clientId === "string") setBitbucketClientId(bitbucket.publicConfig.clientId);
      } else {
        setManaged([]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [secure]);

  useEffect(() => { void refresh(); }, [refresh]);

  const reauthenticateOwner = async (): Promise<void> => {
    if (!ownerPassword) throw new Error("Enter your current password before changing identity providers.");
    const result = await authJson("/api/auth/reauthenticate", { password: ownerPassword });
    if (!result.response.ok) throw authError(result.response, result.body);
  };

  const configure = async (kind: "github" | "bitbucket"): Promise<void> => {
    if (busy || !secure) return;
    const existing = managed.find((provider) => provider.id === kind);
    const clientId = kind === "github" ? githubClientId.trim() : bitbucketClientId.trim();
    const secret = kind === "github" ? githubSecret : bitbucketSecret;
    if (!clientId || (!existing && !secret)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await reauthenticateOwner();
      await configureProvider({
        id: kind,
        kind,
        issuer: kind === "github" ? "https://github.com" : "https://bitbucket.org",
        publicConfig: kind === "github"
          ? { clientId }
          : {
              clientId,
              registeredCallbackUrl: `${location.origin}/auth/provider/callback`,
              declaredScopes: ["account"],
            },
        ...(secret ? { clientSecret: secret } : {}),
      });
      if (kind === "github") setGithubSecret(""); else setBitbucketSecret("");
      setOwnerPassword("");
      setNotice(`${providerLabel(kind)} identity configuration saved disabled. Review it, then enable explicitly.`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const toggleProvider = async (provider: ManagedProvider): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await reauthenticateOwner();
      const changed = await setProviderEnabled(provider, !provider.enabled);
      setOwnerPassword("");
      setNotice(`${providerLabel(changed.kind)} sign-in is now ${changed.enabled ? "enabled" : "disabled"}.`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const link = async (provider: LoginProvider): Promise<void> => {
    if (busy || !secure) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await beginProviderFlow(provider.id, "link", "/settings/access");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const unlink = async (linkIdentity: LinkedIdentity): Promise<void> => {
    if (!await confirmAlert(
      `Unlink ${providerLabel(linkIdentity.providerId)}? Existing browser sessions for this account will be revoked.`,
      { title: "Unlink identity", confirmLabel: "Unlink" },
    )) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await unlinkIdentity(linkIdentity);
      location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <>
      <div className="set-page-head"><h3>External sign-in</h3></div>
      {!secure && (
        <Row label="External identity" hint="OAuth/OIDC callbacks are accepted only on an HTTPS Polyth origin.">
          <span className="tag">HTTPS required</span>
        </Row>
      )}
      {secure && providers.map((provider) => {
        const linked = links.some((entry) => entry.providerId === provider.id);
        return (
          <Row key={provider.id} label={providerLabel(provider.kind)} hint={`${provider.issuer}${linked ? " · linked to this account" : ""}`}>
            <Button size="sm" disabled={busy || linked} onClick={() => void link(provider)}>
              {linked ? "Linked" : "Link account"}
            </Button>
          </Row>
        );
      })}
      {links.length === 0 ? (
        <Row label="Linked identities" hint="No external identity is linked to this account."><span className="tag">None</span></Row>
      ) : links.map((linkIdentity) => (
        <Row
          key={linkIdentity.id}
          label={`${providerLabel(linkIdentity.providerId)} identity`}
          hint={`${linkIdentity.issuer} · ${linkIdentity.subject}`}
        >
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void unlink(linkIdentity)}>Unlink</Button>
        </Row>
      ))}

      {canManage && secure && (
        <>
          <div className="set-page-head"><h3>Identity providers</h3></div>
          <Row label="Confirm owner password" hint="Provider configuration and enable/disable are elevated owner actions.">
            <TextInput
              uiSize="sm"
              type="password"
              value={ownerPassword}
              autoComplete="current-password"
              placeholder="Current password"
              aria-label="Identity provider owner password"
              onChange={(event) => setOwnerPassword(event.target.value)}
            />
          </Row>
          <Row label="GitHub OAuth app" hint="Use a dedicated identity-only OAuth app. Repository/gist/admin scopes are rejected by the server.">
            <div className="set-row-control">
              <TextInput uiSize="sm" value={githubClientId} placeholder="Client ID" aria-label="GitHub OAuth client ID" onChange={(event) => setGithubClientId(event.target.value)} />
              <TextInput uiSize="sm" type="password" value={githubSecret} autoComplete="new-password" placeholder="Client secret (leave blank to keep)" aria-label="GitHub OAuth client secret" onChange={(event) => setGithubSecret(event.target.value)} />
              <Button size="sm" busy={busy} disabled={!ownerPassword || !githubClientId.trim() || (!managed.some((provider) => provider.id === "github") && !githubSecret)} onClick={() => void configure("github")}>Save</Button>
            </div>
          </Row>
          <Row label="Bitbucket OAuth consumer" hint="Use a dedicated consumer with only the account scope and callback to this Polyth HTTPS origin.">
            <div className="set-row-control">
              <TextInput uiSize="sm" value={bitbucketClientId} placeholder="Consumer key" aria-label="Bitbucket consumer key" onChange={(event) => setBitbucketClientId(event.target.value)} />
              <TextInput uiSize="sm" type="password" value={bitbucketSecret} autoComplete="new-password" placeholder="Consumer secret (leave blank to keep)" aria-label="Bitbucket consumer secret" onChange={(event) => setBitbucketSecret(event.target.value)} />
              <Button size="sm" busy={busy} disabled={!ownerPassword || !bitbucketClientId.trim() || (!managed.some((provider) => provider.id === "bitbucket") && !bitbucketSecret)} onClick={() => void configure("bitbucket")}>Save</Button>
            </div>
          </Row>
          {managed.map((provider) => (
            <Row key={provider.id} label={`${providerLabel(provider.kind)} · ${provider.enabled ? "Enabled" : "Disabled"}`} hint={provider.issuer}>
              <Button size="sm" disabled={busy || !ownerPassword} onClick={() => void toggleProvider(provider)}>
                {provider.enabled ? "Disable" : "Enable"}
              </Button>
            </Row>
          ))}
        </>
      )}
      {notice && <p className="muted" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </>
  );
}
