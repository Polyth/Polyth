import { useCallback, useEffect, useState } from "react";
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
import { Badge, Button, Dialog, Icon, Notice, TextInput } from "../ui/index.ts";
import { GithubIcon, GitlabIcon, RepositoriesIcon, type LucideIcon } from "../ui/icons.ts";
import { FormField, ItemList, ItemRow, Section, Toggle } from "./parts.tsx";
import { isReauthCancelled, type WithReauth } from "./ownerReauth.tsx";
import { accountErrorText } from "./usersModel.ts";
import { tr, type TranslationKey } from "../../i18n/index.ts";

type ProviderKind = "github" | "bitbucket";

const PROVIDER_TEXT: Record<string, { label: string; icon: LucideIcon }> = {
  github: { label: "GitHub", icon: GithubIcon },
  gitlab: { label: "GitLab", icon: GitlabIcon },
  bitbucket: { label: "Bitbucket", icon: RepositoriesIcon },
};
const providerLabel = (kind: string): string => PROVIDER_TEXT[kind]?.label ?? kind;
const providerIcon = (kind: string) => <Icon icon={PROVIDER_TEXT[kind]?.icon ?? RepositoriesIcon} size="sm" />;

/** Returns to the person's own account view after the provider round trip. */
const LINK_RETURN = "/?settings=users/account";

const isSecure = (): boolean => typeof location !== "undefined" && location.protocol === "https:";

/** Settings → Users → your account: GitHub/Bitbucket identities that can sign
 *  in to this account. Hidden when there is nothing to link or unlink. */
export function LinkedSignIns() {
  const [providers, setProviders] = useState<LoginProvider[]>([]);
  const [links, setLinks] = useState<LinkedIdentity[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const secure = isSecure();

  useEffect(() => {
    let live = true;
    void Promise.all([
      listLinkedIdentities(),
      secure ? listLoginProviders() : Promise.resolve([]),
    ]).then(([nextLinks, nextProviders]) => {
      if (!live) return;
      setLinks(nextLinks);
      setProviders(nextProviders);
    }, (cause) => { if (live) setError(accountErrorText(cause)); });
    return () => { live = false; };
  }, [secure]);

  const link = async (provider: LoginProvider): Promise<void> => {
    if (busy || !secure) return;
    setBusy(true); setError("");
    try {
      await beginProviderFlow(provider.id, "link", LINK_RETURN);
    } catch (cause) {
      setError(accountErrorText(cause));
      setBusy(false);
    }
  };

  const unlink = async (identity: LinkedIdentity): Promise<void> => {
    if (!await confirmAlert(
      tr("settings.identity.unlinkBody", { provider: providerLabel(identity.providerId) }),
      { title: tr("settings.identity.unlinkTitle", { provider: providerLabel(identity.providerId) }), confirmLabel: tr("settings.identity.unlink") },
    )) return;
    setBusy(true); setError("");
    try {
      await unlinkIdentity(identity);
      location.reload();
    } catch (cause) {
      setError(accountErrorText(cause));
      setBusy(false);
    }
  };

  const unlinkedProviders = providers.filter((provider) => !links.some((entry) => entry.providerId === provider.id));
  if (links.length === 0 && unlinkedProviders.length === 0 && !error) return null;

  return (
    <Section title={tr("settings.identity.linkedAccounts")} hint={tr("settings.identity.linkedAccountsHint")} itemId="users.account.linked">
      <ItemList label={tr("settings.identity.linkedAccounts")} className="account-detail-list">
        {links.map((identity) => (
          <ItemRow
            key={identity.id}
            icon={providerIcon(identity.providerId)}
            title={providerLabel(identity.providerId)}
            meta={<Badge tone="success">{tr("settings.identity.linked")}</Badge>}
            description={identity.subject}
            trailing={<Button size="sm" variant="ghost" disabled={busy} onClick={() => void unlink(identity)}>{tr("settings.identity.unlink")}</Button>}
          />
        ))}
        {unlinkedProviders.map((provider) => (
          <ItemRow
            key={provider.id}
            icon={providerIcon(provider.kind)}
            title={providerLabel(provider.kind)}
            description={tr("settings.identity.notLinked")}
            trailing={<Button size="sm" variant="quiet" disabled={busy || !secure} onClick={() => void link(provider)}>{tr("settings.identity.link")}</Button>}
          />
        ))}
      </ItemList>
      {error && <Notice tone="error" role="alert">{error}</Notice>}
    </Section>
  );
}

const SETUP_TEXT: Record<ProviderKind, { idLabel: TranslationKey; secretLabel: TranslationKey; hint: TranslationKey }> = {
  github: {
    idLabel: "settings.identity.clientId",
    secretLabel: "settings.identity.clientSecret",
    hint: "settings.identity.githubSetupHint",
  },
  bitbucket: {
    idLabel: "settings.identity.consumerKey",
    secretLabel: "settings.identity.consumerSecret",
    hint: "settings.identity.bitbucketSetupHint",
  },
};

/** Settings → Users (server owner): which outside accounts people may sign in
 *  with. Server-wide, so it lives beside the account list. */
export function SignInProviders({ withReauth }: { withReauth: WithReauth }) {
  const [managed, setManaged] = useState<ManagedProvider[]>([]);
  const [editing, setEditing] = useState<ProviderKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const secure = isSecure();

  const refresh = useCallback(async () => {
    try {
      setManaged(await listManagedProviders());
    } catch (cause) {
      setError(accountErrorText(cause));
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const toggle = async (provider: ManagedProvider, enabled: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const changed = await withReauth(() => setProviderEnabled(provider, enabled));
      setNotice(tr(changed.enabled ? "settings.identity.providerOn" : "settings.identity.providerOff", { provider: providerLabel(changed.kind) }));
      await refresh();
    } catch (cause) {
      if (!isReauthCancelled(cause)) setError(accountErrorText(cause));
    } finally { setBusy(false); }
  };

  return (
    <Section
      title={tr("settings.identity.providers")}
      hint={secure
        ? tr("settings.identity.providersHint")
        : tr("settings.identity.providersHintInsecure")}
      itemId="users.providers"
    >
      <ItemList label={tr("settings.identity.providers")}>
        {(["github", "bitbucket"] as const).map((kind) => {
          const provider = managed.find((entry) => entry.id === kind);
          return (
            <ItemRow
              key={kind}
              icon={providerIcon(kind)}
              title={providerLabel(kind)}
              meta={provider
                ? <Badge tone={provider.enabled ? "success" : "neutral"}>{provider.enabled ? tr("settings.identity.on") : tr("settings.identity.off")}</Badge>
                : <Badge>{tr("settings.identity.notSetUp")}</Badge>}
              inactive={!secure}
              trailing={(
                <>
                  <Button size="sm" variant="quiet" disabled={busy || !secure} onClick={() => setEditing(kind)}>
                    {provider ? tr("settings.identity.editEllipsis") : tr("settings.identity.setUpEllipsis")}
                  </Button>
                  {provider && (
                    <Toggle
                      on={provider.enabled}
                      disabled={busy || !secure}
                      label={tr("settings.identity.providerSignIn", { provider: providerLabel(kind) })}
                      onChange={(on) => void toggle(provider, on)}
                    />
                  )}
                </>
              )}
            />
          );
        })}
      </ItemList>
      {notice && <Notice tone="success" role="status">{notice}</Notice>}
      {error && <Notice tone="error" role="alert">{error}</Notice>}
      {editing && (
        <ProviderSetupDialog
          kind={editing}
          existing={managed.find((entry) => entry.id === editing) ?? null}
          withReauth={withReauth}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            setNotice(tr("settings.identity.savedOff", { provider: providerLabel(editing) }));
            await refresh();
          }}
        />
      )}
    </Section>
  );
}

function ProviderSetupDialog({ kind, existing, withReauth, onClose, onSaved }: {
  kind: ProviderKind;
  existing: ManagedProvider | null;
  withReauth: WithReauth;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const text = SETUP_TEXT[kind];
  const [clientId, setClientId] = useState(typeof existing?.publicConfig.clientId === "string" ? existing.publicConfig.clientId : "");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !!clientId.trim() && (!!existing || !!secret);

  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await withReauth(() => configureProvider({
        id: kind,
        kind,
        issuer: kind === "github" ? "https://github.com" : "https://bitbucket.org",
        publicConfig: kind === "github"
          ? { clientId: clientId.trim() }
          : {
              clientId: clientId.trim(),
              registeredCallbackUrl: `${location.origin}/auth/provider/callback`,
              declaredScopes: ["account"],
            },
        ...(secret ? { clientSecret: secret } : {}),
      }));
      await onSaved();
    } catch (cause) {
      if (!isReauthCancelled(cause)) setError(accountErrorText(cause));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={tr(existing ? "settings.identity.editTitle" : "settings.identity.setUpTitle", { provider: providerLabel(kind) })}
      size="sm"
      className="users-dialog"
      onClose={() => { if (!busy) onClose(); }}
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{tr("common.cancel")}</Button>
          <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void save()}>{tr("common.save")}</Button>
        </>
      )}
    >
      <form className="users-dialog-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <p className="users-dialog-intro">{tr(text.hint)}</p>
        <FormField label={tr(text.idLabel)}>
          {(field) => (
            <TextInput {...field} value={clientId} autoComplete="off" spellCheck={false} disabled={busy} onChange={(event) => setClientId(event.target.value)} />
          )}
        </FormField>
        <FormField label={tr(text.secretLabel)} {...(existing ? { hint: tr("settings.identity.keepSecretHint") } : {})}>
          {(field) => (
            <TextInput {...field} type="password" value={secret} autoComplete="new-password" disabled={busy} onChange={(event) => setSecret(event.target.value)} />
          )}
        </FormField>
        {error && <Notice tone="error" role="alert">{error}</Notice>}
      </form>
    </Dialog>
  );
}
