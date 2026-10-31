// Settings → Source control (Spaces §14.4). Accounts tab: the signed-in
// person's own GitLab tokens, each turned on per Space (the shared
// HostingAccounts section owns the list and the protected connect form).
// Space tab, for Space admins: the Space's shared (service) GitLab accounts.
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PersonHostingAccountDto } from "@polyth/contracts/source-control";
import type { HostingResult } from "@polyth/code-hosting/types";
import HostingAccounts, { hostingAccountDetail, type HostingAccountsCopy } from "@polyth/code-hosting/accounts";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { Badge, Button, IconButton, Menu, MoreIcon, Notice, TextInput, confirmAlert } from "../../../apps/web/src/components/ui/index.ts";
import { EmptyState, FormField, ItemList, ItemRow, Section, Seg } from "../../../apps/web/src/components/settings/parts.tsx";
import { Icon } from "../../../apps/web/src/icons.tsx";
import type { GitlabAccount, GitlabAuthKind } from "../src/auth.ts";
import { gitlabText, type GitlabMessageKey } from "../src/i18n/index.ts";

const api = createApiTransport();
export const GITLAB_PERSON_ACCOUNTS_PATH = "/api/gitlab/me/accounts";
export const GITLAB_SPACE_ACCOUNTS_PATH = "/api/gitlab/accounts";
const DEFAULT_INSTANCE = "https://gitlab.com";

type ListResponse = { ok: boolean; data: PersonHostingAccountDto[] };

/** GitLab routes answer `{ok:false, code, reason}`; keep the reason. */
export function gitlabErrorText(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  try {
    const parsed = JSON.parse(cause.message) as { reason?: unknown };
    if (typeof parsed.reason === "string") return parsed.reason;
  } catch { /* Already a plain sentence. */ }
  return cause.message;
}

const hostOf = (origin: string): string => {
  try { return new URL(origin).host; } catch { return origin; }
};
const rowsOf = (response: ListResponse): PersonHostingAccountDto[] => Array.isArray(response.data) ? response.data : [];
const read = async <T,>(promise: Promise<HostingResult<T>>): Promise<T> => {
  const result = await promise;
  if (!result.ok) throw new Error(result.reason);
  return result.data;
};

function useText(host: WebPackageHost) {
  return (key: GitlabMessageKey, vars?: Record<string, string | number>) => gitlabText(host.ui.locale.get(), key, vars);
}

/** Another server and whether the account is on in this Space. */
export function gitlabAccountDetail(row: Pick<PersonHostingAccountDto, "origin" | "enabled">, locale = "en"): string {
  return hostingAccountDetail(row, DEFAULT_INSTANCE, { onHere: gitlabText(locale, "personOnHere"), offHere: gitlabText(locale, "personOffHere") });
}

export function GitlabPersonAccounts({ host }: { host: WebPackageHost }) {
  const t = useText(host);
  const copy: HostingAccountsCopy = {
    title: t("personTitle"),
    hint: t("personHint"),
    loading: t("personLoading"),
    emptyTitle: t("personEmptyTitle"),
    emptyBody: t("personEmptyBody"),
    add: t("personAdd"),
    connect: t("personConnect"),
    cancel: t("personCancel"),
    token: t("personToken"),
    tokenHint: t("personTokenHint"),
    label: t("personLabel"),
    labelPlaceholder: t("personLabelPlaceholder"),
    server: t("personServer"),
    serverHint: t("personServerHint"),
    serverPlaceholder: "https://gitlab.example.com",
    onHere: t("personOnHere"),
    offHere: t("personOffHere"),
    remove: t("personRemove"),
    removeTitle: t("personRemoveTitle"),
    useHere: (login) => t("personUseHere", { login }),
    actions: (login) => t("personActions", { login }),
    removeConfirm: (login) => t("personRemoveConfirm", { login }),
  };
  return (
    <HostingAccounts
      copy={copy}
      glyph={<span className="hosting-account-mark">{Icon.gitlab()}</span>}
      defaultOrigin={DEFAULT_INSTANCE}
      errorText={gitlabErrorText}
      load={async () => rowsOf(await api.get<ListResponse>(GITLAB_PERSON_ACCOUNTS_PATH))}
      connect={async ({ token, label, server }) => rowsOf(await api.post<ListResponse>(GITLAB_PERSON_ACCOUNTS_PATH, {
        token,
        instance: server || DEFAULT_INSTANCE,
        ...(label ? { label } : {}),
      }))}
      setEnabled={async (id, enabled) => rowsOf(await api.put<ListResponse>(`${GITLAB_PERSON_ACCOUNTS_PATH}/${encodeURIComponent(id)}/enabled`, { enabled }))}
      remove={async (id) => rowsOf(await api.delete<ListResponse>(`${GITLAB_PERSON_ACCOUNTS_PATH}/${encodeURIComponent(id)}`))}
    />
  );
}

/** The Space's shared GitLab accounts, for Space admins: the only GitLab
 *  accounts that can be bound to a project. */
export function GitlabSpaceAccounts({ host }: { host: WebPackageHost }) {
  const t = useText(host);
  const [rows, setRows] = useState<GitlabAccount[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [validity, setValidity] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [adding, setAdding] = useState(false);
  const [instance, setInstance] = useState(DEFAULT_INSTANCE);
  const [username, setUsername] = useState("");
  const [authKind, setAuthKind] = useState<GitlabAuthKind>("glab");
  const [token, setToken] = useState("");
  const live = useRef(true);

  const refresh = async () => {
    const next = await read(api.get<HostingResult<GitlabAccount[]>>(GITLAB_SPACE_ACCOUNTS_PATH));
    if (live.current) { setRows(next); setLoadError(""); }
  };
  useEffect(() => {
    live.current = true;
    void refresh().catch((cause: unknown) => { if (live.current) setLoadError(gitlabErrorText(cause)); });
    return () => { live.current = false; };
  }, []);

  const run = async (key: string, action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key);
    setError("");
    try {
      await action();
      if (live.current) await refresh();
      return true;
    } catch (cause) {
      if (live.current) setError(gitlabErrorText(cause));
      return false;
    } finally {
      if (live.current) setBusy("");
    }
  };
  const check = async (account: GitlabAccount) => {
    setBusy(`check:${account.id}`);
    try {
      await read(api.post<HostingResult<unknown>>(`${GITLAB_SPACE_ACCOUNTS_PATH}/${encodeURIComponent(account.id)}/verify`, {}));
      if (live.current) setValidity((current) => ({ ...current, [account.id]: { ok: true, text: t("connectedStatus") } }));
    } catch (cause) {
      if (live.current) setValidity((current) => ({ ...current, [account.id]: { ok: false, text: gitlabErrorText(cause) } }));
    } finally {
      if (live.current) setBusy("");
    }
  };
  const remove = async (account: GitlabAccount) => {
    const confirmed = await confirmAlert(t("spaceRemoveConfirm", { login: account.username }), {
      title: t("spaceRemoveTitle"),
      confirmLabel: t("remove"),
      destructive: true,
    });
    if (confirmed) await run(`remove:${account.id}`, () => api.delete(`${GITLAB_SPACE_ACCOUNTS_PATH}/${encodeURIComponent(account.id)}`));
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const secret = authKind === "pat" ? token.trim() : "";
    setToken("");
    const ok = await run("add", () => read(api.post<HostingResult<GitlabAccount>>(GITLAB_SPACE_ACCOUNTS_PATH, {
      instance: instance.trim(),
      username: username.trim(),
      authKind,
      ...(authKind === "pat" ? { token: secret } : {}),
    })));
    if (ok && live.current) { setUsername(""); setAdding(false); }
  };
  const open = () => { setError(""); setAdding(true); };
  const signInHost = hostOf(instance.trim() || DEFAULT_INSTANCE);

  return (
    <Section
      title={t("spaceTitle")}
      hint={t("spaceHint")}
      {...(rows?.length && !adding ? { action: <Button size="sm" variant="quiet" onClick={open}>{t("addAccount")}</Button> } : {})}
    >
      {!rows && !loadError && <EmptyState compact busy title={t("spaceLoading")} />}
      {loadError && <Notice tone="error" role="alert">{loadError}</Notice>}
      {rows && rows.length > 0 && (
        <ItemList label={t("spaceTitle")}>
          {rows.map((account) => {
            const status = validity[account.id];
            return (
              <ItemRow
                key={account.id}
                icon={<span className="hosting-account-mark">{Icon.gitlab()}</span>}
                title={`@${account.username}`}
                {...(account.label && account.label !== account.username ? { meta: <Badge>{account.label}</Badge> } : {})}
                description={[hostOf(account.instanceId), account.authKind === "pat" ? t("spaceAuthToken") : t("spaceAuthGlab")].join(" · ")}
                {...(status && !status.ok ? { error: status.text } : {})}
                trailing={(
                  <>
                    {status?.ok && <Badge tone="success">{status.text}</Badge>}
                    <Button size="sm" variant="quiet" busy={busy === `check:${account.id}`} disabled={busy !== ""} onClick={() => void check(account)}>{t("check")}</Button>
                    <Menu
                      label={t("spaceActions", { login: account.username })}
                      align="end"
                      entries={[{ id: "remove", label: t("remove"), danger: true, disabled: busy !== "", onSelect: () => void remove(account) }]}
                    >
                      {(trigger) => <IconButton {...trigger} icon={MoreIcon} size="sm" label={t("spaceActions", { login: account.username })} />}
                    </Menu>
                  </>
                )}
              />
            );
          })}
        </ItemList>
      )}
      {rows?.length === 0 && !adding && (
        <EmptyState compact icon="key" title={t("spaceEmptyTitle")} body={t("spaceEmptyBody")} action={{ label: t("addAccount"), onClick: open }} />
      )}
      {adding && rows && (
        <form className="hosting-accounts-form" onSubmit={(event) => void submit(event)} autoComplete="off">
          <div className="hosting-accounts-form-pair">
            <FormField label={t("instance")}>
              {(field) => <TextInput {...field} value={instance} required inputMode="url" spellCheck={false} autoCapitalize="off" placeholder="https://gitlab.example.com" disabled={busy !== ""} onChange={(event) => setInstance(event.target.value)} />}
            </FormField>
            <FormField label={t("username")}>
              {(field) => <TextInput {...field} value={username} required autoComplete="username" spellCheck={false} autoCapitalize="off" disabled={busy !== ""} onChange={(event) => setUsername(event.target.value)} />}
            </FormField>
          </div>
          <FormField label={t("authentication")} hint={authKind === "glab" ? t("signIn", { host: signInHost }) : undefined}>
            <Seg<GitlabAuthKind>
              label={t("authentication")}
              value={authKind}
              disabled={busy !== ""}
              options={[["glab", t("glabLogin")], ["pat", t("personalToken")]]}
              onChange={(next) => { setAuthKind(next); setToken(""); }}
            />
          </FormField>
          {authKind === "pat" && (
            <FormField label={t("accessToken")}>
              {(field) => <TextInput {...field} type="password" value={token} required autoComplete="off" spellCheck={false} autoCapitalize="off" disabled={busy !== ""} onChange={(event) => setToken(event.target.value)} />}
            </FormField>
          )}
          <div className="hosting-accounts-form-actions">
            <Button type="button" size="sm" variant="ghost" disabled={busy !== ""} onClick={() => { setToken(""); setAdding(false); setError(""); }}>{t("spaceCancel")}</Button>
            <Button type="submit" size="sm" variant="primary" busy={busy === "add"} disabled={busy !== "" || !instance.trim() || !username.trim() || (authKind === "pat" && !token.trim())}>{t("addAccount")}</Button>
          </div>
        </form>
      )}
      {error && <Notice tone="error" role="alert" className="hosting-accounts-error">{error}</Notice>}
    </Section>
  );
}

/** The `settings.integrations` contribution: the person's own accounts. */
export function GitlabAccountSettings({ host }: { host: WebPackageHost }) {
  return <GitlabPersonAccounts host={host} />;
}
