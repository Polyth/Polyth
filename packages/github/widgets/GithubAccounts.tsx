// Settings → Source control → Accounts → "GitHub" (Spaces §14.4): the
// signed-in person's own GitHub tokens, each turned on per Space. The shared
// HostingAccounts section owns the list and the protected connect form.
import { useMemo, useState } from "react";
import type { PersonHostingAccountDto } from "@polyth/contracts/source-control";
import { createApiTransport } from "@polyth/web-sdk";
import HostingAccounts, { hostingAccountDetail, type HostingAccountsCopy } from "@polyth/code-hosting/accounts";
import { Icon } from "../../../apps/web/src/icons.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";

const api = createApiTransport();
export const GITHUB_ACCOUNTS_PATH = "/api/github/accounts";
const DEFAULT_ORIGIN = "https://github.com";

type ListResponse = { ok: boolean; data: PersonHostingAccountDto[]; installation?: boolean };

const text = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const rowsOf = (response: ListResponse): PersonHostingAccountDto[] => Array.isArray(response.data) ? response.data : [];

function githubCopy(installation: boolean): HostingAccountsCopy {
  return {
    title: tr("githubaccounts.title"),
    hint: tr("githubaccounts.hint"),
    loading: tr("githubaccounts.loading"),
    emptyTitle: tr("githubaccounts.emptyTitle"),
    emptyBody: installation ? tr("githubaccounts.emptyInstallation") : tr("githubaccounts.emptyMember"),
    add: tr("githubaccounts.add"),
    connect: tr("githubaccounts.connect"),
    cancel: tr("githubaccounts.cancel"),
    token: tr("githubaccounts.token"),
    tokenHint: tr("githubaccounts.tokenHint"),
    label: tr("githubaccounts.label"),
    labelPlaceholder: tr("githubaccounts.labelPlaceholder"),
    server: tr("githubaccounts.server"),
    serverHint: tr("githubaccounts.serverHint"),
    serverPlaceholder: "https://github.example.com",
    onHere: tr("githubaccounts.onHere"),
    offHere: tr("githubaccounts.offHere"),
    remove: tr("githubaccounts.remove"),
    removeTitle: tr("githubaccounts.removeTitle"),
    useHere: (login) => tr("githubaccounts.useHere", { login }),
    actions: (login) => tr("githubaccounts.actions", { login }),
    removeConfirm: (login) => tr("githubaccounts.removeConfirm", { login }),
  };
}

/** Another server and whether the account is on in this Space. */
export function accountDetail(row: Pick<PersonHostingAccountDto, "origin" | "enabled">, defaultOrigin = DEFAULT_ORIGIN): string {
  return hostingAccountDetail(row, defaultOrigin, { onHere: tr("githubaccounts.onHere"), offHere: tr("githubaccounts.offHere") });
}

export default function GithubAccounts() {
  // The instance owner's gh sign-in works for them until they add an account.
  const [installation, setInstallation] = useState(false);
  const copy = useMemo(() => githubCopy(installation), [installation]);
  return (
    <HostingAccounts
      copy={copy}
      glyph={<span className="hosting-account-mark">{Icon.github()}</span>}
      defaultOrigin={DEFAULT_ORIGIN}
      errorText={text}
      load={async () => {
        const response = await api.get<ListResponse>(GITHUB_ACCOUNTS_PATH);
        setInstallation(response.installation === true);
        return rowsOf(response);
      }}
      connect={async ({ token, label, server }) => {
        await api.post(GITHUB_ACCOUNTS_PATH, { token, ...(server ? { origin: server } : {}), ...(label ? { label } : {}) });
        return rowsOf(await api.get<ListResponse>(GITHUB_ACCOUNTS_PATH));
      }}
      setEnabled={async (id, enabled) => rowsOf(await api.put<ListResponse>(`${GITHUB_ACCOUNTS_PATH}/${encodeURIComponent(id)}/enabled`, { enabled }))}
      remove={async (id) => rowsOf(await api.delete<ListResponse>(`${GITHUB_ACCOUNTS_PATH}/${encodeURIComponent(id)}`))}
    />
  );
}
