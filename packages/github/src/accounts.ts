// GitHub accounts for Git transport: a person's own GitHub tokens (Profile →
// Accounts, turned on per Space) and the host's GitHub CLI logins. `gh` logins
// are an installation account: only the instance owner on a local-trusted
// install sees or uses them. A token is handed only to the one Git process
// that needs it.
import { execFile } from "node:child_process";
import { resolveExecutable } from "@polyth/kernel/executable";
import type { SpaceContext } from "@polyth/contracts";
import type { SourceControlCredentialProvider, SourceControlHostingAccount } from "@polyth/contracts/source-control";
import type { PersonHostingAccounts } from "@polyth/git/person-accounts";

export type GhAccountExec = (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

const defaultExec: GhAccountExec = (args) => new Promise((resolve) => {
  execFile(resolveExecutable("gh"), args, {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
  }, (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) }));
});

export interface GhLogin { host: string; login: string; active: boolean }

const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i;
const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;

/** Parse `gh auth status` for both the single-account (`Logged in to H as L`)
 * and the multi-account (`Logged in to H account L` + `Active account: …`)
 * formats. Failed logins are skipped. gh prints status on stdout or stderr
 * depending on its version, so both streams are parsed together. */
export function parseGhAuthStatus(output: string): GhLogin[] {
  const logins: GhLogin[] = [];
  let current: GhLogin | null = null;
  for (const line of output.split(/\r?\n/)) {
    const login = /Logged in to (\S+) (?:account|as) (\S+)/.exec(line);
    if (login) {
      current = null;
      const host = login[1]!.toLowerCase();
      const name = login[2]!;
      if (!HOST.test(host) || !LOGIN.test(name)) continue;
      current = { host, login: name, active: true };
      logins.push(current);
      continue;
    }
    if (/Failed to log in/i.test(line)) { current = null; continue; }
    const active = /Active account:\s*(true|false)/i.exec(line);
    if (active && current) current.active = active[1]!.toLowerCase() === "true";
  }
  const seen = new Set<string>();
  return logins.filter((row) => {
    const key = `${row.host}/${row.login.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const accountId = (row: GhLogin): string => `${row.host}/${row.login}`;

export async function listGhLogins(exec: GhAccountExec = defaultExec): Promise<GhLogin[]> {
  const result = await exec(["auth", "status"]);
  return parseGhAuthStatus(`${result.stdout}\n${result.stderr}`);
}

const fail = (code: string, message: string, status: number): never => {
  throw Object.assign(new Error(message), { code, status });
};

/** Source-control credential provider over a person's own GitHub accounts and
 *  the host's `gh` logins. */
export function createGithubCredentialProvider(deps: {
  exec?: GhAccountExec;
  /** gh logins are host-wide credentials: expose them only to the instance
   *  owner of a local-trusted install (`contextMayUseInstallation`). */
  allowed: (space: SpaceContext) => boolean;
  /** Person-owned GitHub accounts; absent on hosts without people storage. */
  people?: PersonHostingAccounts;
}): SourceControlCredentialProvider {
  const exec = deps.exec ?? defaultExec;
  const logins = async (space: SpaceContext): Promise<GhLogin[]> => deps.allowed(space) ? listGhLogins(exec) : [];
  return {
    id: "github",
    async accounts(space) {
      const personal = (deps.people?.enabledIn(space.userId, space.spaceId) ?? []).map((row): SourceControlHostingAccount => ({
        provider: "github",
        accountId: row.id,
        providerLabel: "GitHub",
        login: row.login,
        origin: row.origin,
        label: row.label,
        transport: "token",
        owner: "personal",
      }));
      return [...personal, ...(await logins(space)).map((row): SourceControlHostingAccount => ({
        provider: "github",
        accountId: accountId(row),
        providerLabel: "GitHub",
        login: row.login,
        origin: `https://${row.host}`,
        transport: "token",
        active: row.active,
        owner: "installation",
      }))];
    },
    async credential(space, id) {
      if (id.startsWith("p-")) {
        // Only the context's own person, and only where they turned it on.
        if (!deps.people) return fail("not-found", "GitHub account not found.", 404);
        const row = deps.people.enabledIn(space.userId, space.spaceId).find((candidate) => candidate.id === id)
          ?? fail("not-found", "GitHub account not found.", 404);
        return { username: row.login, password: deps.people.token(space.userId, space.spaceId, id) };
      }
      const row = (await logins(space)).find((candidate) => accountId(candidate) === id)
        ?? fail("not-found", "GitHub account is not signed in to GitHub CLI.", 404);
      // gh ≥ 2.40 can hand out the token of any signed-in account.
      const exact = await exec(["auth", "token", "--hostname", row.host, "--user", row.login]);
      const token = exact.ok ? exact.stdout.trim() : "";
      if (token && !/\s/.test(token)) return { username: row.login, password: token };
      if (!row.active) {
        fail("account-inactive", `@${row.login} is not the active GitHub CLI account for ${row.host}. Run \`gh auth switch --hostname ${row.host} --user ${row.login}\` or update GitHub CLI, then try again.`, 409);
      }
      const activeToken = await exec(["auth", "token", "--hostname", row.host]);
      const fallback = activeToken.ok ? activeToken.stdout.trim() : "";
      if (fallback && !/\s/.test(fallback)) return { username: row.login, password: fallback };
      // Older gh cannot print tokens; its Git credential helper (configured by
      // `gh auth setup-git`) authenticates the active account instead.
      return null;
    },
  };
}
