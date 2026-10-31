// The project's source-control account: the code-hosting account Polyth uses
// to authenticate fetch, pull and push for the repository's host. Chosen when
// cloning; changeable here.
import { useEffect, useMemo, useState } from "react";
import {
  sourceControlAccountMatchesRemote,
  sourceControlRemoteOrigin,
  type SourceControlAccountBinding,
  type SourceControlHostingAccount,
} from "@polyth/contracts/source-control";
import { createApiTransport } from "@polyth/web-sdk";
import { Row } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Select } from "../../../apps/web/src/components/ui/index.ts";
import { repositorySourceControlRemotes, type RepositorySourceControlRemote } from "./sourceControlRemote.ts";

const api = createApiTransport();
const SYSTEM = "system";
const keyOf = (row: Pick<SourceControlHostingAccount, "provider" | "accountId">): string => `${row.provider}:${row.accountId}`;
const hostOf = (origin: string): string => {
  try { return new URL(origin).host; } catch { return origin; }
};

export default function SourceControlAccountSetting({ projectId }: { projectId: string }) {
  const [remote, setRemote] = useState<RepositorySourceControlRemote | null | undefined>(undefined);
  const [accounts, setAccounts] = useState<SourceControlHostingAccount[]>([]);
  const [binding, setBinding] = useState<SourceControlAccountBinding | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setRemote(undefined); setBinding(null); setError("");
    void Promise.all([
      repositorySourceControlRemotes(projectId).catch(() => []),
      api.get<{ accounts?: SourceControlHostingAccount[] }>("/api/git/accounts").catch(() => ({ accounts: [] })),
      api.get<{ binding: SourceControlAccountBinding | null }>(`/api/git/account?projectId=${encodeURIComponent(projectId)}`).catch(() => ({ binding: null })),
    ]).then(([remotes, list, bound]) => {
      if (!active) return;
      setRemote(remotes.find((row) => row.remoteName === "origin") ?? remotes[0] ?? null);
      setAccounts(Array.isArray(list.accounts) ? list.accounts : []);
      setBinding(bound.binding ?? null);
    });
    return () => { active = false; };
  }, [projectId]);

  // Personal accounts apply to their owner wherever they turned them on; only
  // Space (service) and host accounts are bound to a project (Spaces §14.4).
  const matching = useMemo(
    () => remote ? accounts.filter((row) => row.owner !== "personal" && sourceControlAccountMatchesRemote(row, remote.remote)) : [],
    [accounts, remote],
  );
  if (!remote || (matching.length === 0 && !binding)) return null;
  const host = hostOf(sourceControlRemoteOrigin(remote.remote));
  const value = binding ? keyOf(binding) : SYSTEM;
  // A bound account whose provider no longer lists it stays visible as such.
  const stale = binding && !matching.some((row) => keyOf(row) === value);

  const choose = async (next: string) => {
    if (next === value || saving) return;
    setSaving(true); setError("");
    try {
      if (next === SYSTEM) {
        await api.delete(`/api/git/account?projectId=${encodeURIComponent(projectId)}`);
        setBinding(null);
      } else {
        const row = matching.find((candidate) => keyOf(candidate) === next);
        if (!row) return;
        const result = await api.put<{ binding: SourceControlAccountBinding }>("/api/git/account", {
          projectId, provider: row.provider, accountId: row.accountId, remote: remote.remoteName,
        });
        setBinding(result.binding);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Row label={tr("gitprojectsource.projectAccount")} hint={tr("gitprojectsource.projectAccountHint", { host })} itemId="git.sourceControlAccount">
      <div className="git-project-account">
        <Select
          label={tr("gitprojectsource.projectAccount")}
          ariaLabel={tr("gitprojectsource.chooseAccount")}
          value={value}
          disabled={saving}
          onChange={(next) => void choose(next)}
          className="git-project-account-picker"
          options={[
            ...matching.map((row) => ({
              value: keyOf(row),
              label: `@${row.login}`,
              detail: [row.providerLabel, hostOf(row.origin), row.label && row.label !== row.login ? row.label : ""].filter(Boolean).join(" · "),
            })),
            ...(stale ? [{ value, label: `@${binding.login}`, detail: tr("gitprojectsource.accountUnavailable") }] : []),
            { value: SYSTEM, label: tr("gitprojectsource.systemGit"), detail: tr("gitprojectsource.systemGitDetail") },
          ]}
        />
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
    </Row>
  );
}
