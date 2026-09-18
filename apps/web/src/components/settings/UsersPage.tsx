import { useCallback, useEffect, useMemo, useState } from "react";
import { isSpaceRole, type SpaceRole } from "@polyth/contracts";
import {
  accountState,
  createAccount,
  disableAccount,
  type AccountChoice,
} from "../../accounts.ts";
import { authJson } from "../../authClient.ts";
import {
  grantSpaceMember,
  loadCurrentSpaceAccess,
  revokeSpaceMember,
  type CurrentSpaceAccess,
} from "../../spaceAccess.ts";
import { confirmAlert } from "../../alerts.ts";
import { EmptyState } from "./parts.tsx";
import {
  Badge,
  Button,
  Dialog,
  Notice,
  Select,
  TextInput,
} from "../ui/index.ts";
import { AddIcon } from "../ui/icons.ts";

type AccessChoice = SpaceRole | "none";
type Feedback = { tone: "success" | "error" | "info"; text: string };

const ROLE_OPTIONS = [
  { value: "viewer", label: "Viewer", detail: "Read-only access to this Space." },
  { value: "member", label: "Member", detail: "Can work in projects and sessions." },
  { value: "admin", label: "Admin", detail: "Can manage members, packages, and Space settings." },
  { value: "owner", label: "Owner", detail: "Full control, including ownership changes." },
] as const;

const roleLabel = (role: SpaceRole): string =>
  ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;

const roleOptionsFor = (actorRole: SpaceRole | undefined) =>
  actorRole === "owner" ? ROLE_OPTIONS : ROLE_OPTIONS.filter((option) => option.value !== "owner");

const initials = (name: string): string =>
  name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";

const authError = (response: Response, body: Record<string, unknown>): Error => new Error(
  typeof body.message === "string"
    ? body.message
    : typeof body.error === "string" ? body.error.replace(/-/g, " ") : `HTTP ${response.status}`,
);

export default function UsersPage() {
  const [accounts, setAccounts] = useState<AccountChoice[]>([]);
  const [currentAccountId, setCurrentAccountId] = useState("");
  const [canManageAccounts, setCanManageAccounts] = useState(false);
  const [spaceAccess, setSpaceAccess] = useState<CurrentSpaceAccess | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newLogin, setNewLogin] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<AccessChoice>("none");
  const [ownerPassword, setOwnerPassword] = useState("");

  const [disableTarget, setDisableTarget] = useState<AccountChoice | null>(null);
  const [disablePassword, setDisablePassword] = useState("");

  const normalizedNewLogin = newLogin.trim().toLowerCase();
  const newLoginValid = /^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalizedNewLogin);
  const newPasswordValid = [...newPassword].length >= 12;

  const refresh = useCallback(async () => {
    try {
      const [state, access] = await Promise.all([
        accountState(),
        loadCurrentSpaceAccess().catch(() => null),
      ]);
      setAccounts(state.accounts);
      setCurrentAccountId(state.currentAccountId);
      setCanManageAccounts(state.canManage);
      setSpaceAccess(access);
    } catch (cause) {
      setFeedback({ tone: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const visibleAccounts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return accounts;
    return accounts.filter((account) =>
      account.name.toLowerCase().includes(needle)
      || account.login?.toLowerCase().includes(needle)
      || account.id.toLowerCase().includes(needle)
      || account.status?.toLowerCase().includes(needle),
    );
  }, [accounts, query]);

  const reauthenticate = async (password: string): Promise<void> => {
    const result = await authJson("/api/auth/reauthenticate", { password });
    if (!result.response.ok) throw authError(result.response, result.body);
  };

  const resetAddForm = () => {
    setNewName("");
    setNewLogin("");
    setNewPassword("");
    setNewRole("none");
    setOwnerPassword("");
  };

  const createUser = async () => {
    if (busy || !newName.trim() || !newLoginValid || !newPasswordValid || !ownerPassword) return;
    setBusy(true);
    setFeedback(null);
    try {
      await reauthenticate(ownerPassword);
      const account = await createAccount(normalizedNewLogin, newName.trim(), newPassword);
      let grantFailure: string | null = null;
      const requestedRole = newRole;
      if (requestedRole !== "none" && spaceAccess?.canManageMembers) {
        try {
          await grantSpaceMember(spaceAccess.id, account.id, requestedRole);
        } catch (cause) {
          grantFailure = cause instanceof Error ? cause.message : String(cause);
        }
      }
      resetAddForm();
      setAdding(false);
      await refresh();
      setFeedback(grantFailure
        ? {
            tone: "error",
            text: `${account.name} was created, but access to ${spaceAccess?.name ?? "the current Space"} could not be added: ${grantFailure}`,
          }
        : {
            tone: "success",
            text: requestedRole !== "none" && spaceAccess
              ? `${account.name} was created with ${roleLabel(requestedRole)} access to ${spaceAccess.name}.`
              : `${account.name} was created. No Space access was granted.`,
          });
    } catch (cause) {
      setFeedback({ tone: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  const updateSpaceAccess = async (
    account: AccountChoice,
    currentRole: SpaceRole | undefined,
    next: AccessChoice,
  ) => {
    if (!spaceAccess?.canManageMembers || account.current || account.status === "disabled") return;
    if (next === currentRole || (next === "none" && currentRole === undefined)) return;

    if (next === "none") {
      if (!currentRole) return;
      const ok = await confirmAlert(
        `Remove ${account.name} from ${spaceAccess.name}? They will immediately lose access to its projects and sessions.`,
        { title: "Remove Space access", confirmLabel: "Remove access" },
      );
      if (!ok) return;
    } else if (next === "owner" || currentRole === "owner") {
      const ok = await confirmAlert(
        `Change ${account.name} from ${currentRole ? roleLabel(currentRole) : "No access"} to ${roleLabel(next)} in ${spaceAccess.name}?`,
        { title: "Change Space ownership", confirmLabel: "Change access" },
      );
      if (!ok) return;
    }

    setBusy(true);
    setFeedback(null);
    try {
      if (next === "none") {
        await revokeSpaceMember(spaceAccess.id, account.id);
        setFeedback({ tone: "success", text: `${account.name} no longer has access to ${spaceAccess.name}.` });
      } else {
        await grantSpaceMember(spaceAccess.id, account.id, next);
        setFeedback({ tone: "success", text: `${account.name} now has ${roleLabel(next)} access to ${spaceAccess.name}.` });
      }
      await refresh();
    } catch (cause) {
      setFeedback({ tone: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  const disableUser = async () => {
    if (!disableTarget || !disablePassword || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      await reauthenticate(disablePassword);
      await disableAccount(disableTarget);
      setFeedback({
        tone: "success",
        text: `${disableTarget.name} was disabled and their active sessions were revoked.`,
      });
      setDisableTarget(null);
      setDisablePassword("");
      await refresh();
    } catch (cause) {
      setFeedback({ tone: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <EmptyState title="Loading users…" busy />;

  return (
    <div className="users-page">
      <section className="users-page-toolbar" data-settings-item="users.manage">
        <div className="users-page-summary">
          <strong>{accounts.length} {accounts.length === 1 ? "user" : "users"}</strong>
          <span>
            {spaceAccess
              ? `Manage who can sign in and what they can do in ${spaceAccess.name}.`
              : "Manage who can sign in to this Polyth server."}
          </span>
        </div>
        {canManageAccounts && (
          <Button variant="primary" iconStart={AddIcon} onClick={() => setAdding(true)}>
            Add user
          </Button>
        )}
      </section>

      {feedback && (
        <Notice tone={feedback.tone} role={feedback.tone === "error" ? "alert" : "status"}>
          {feedback.text}
        </Notice>
      )}

      {!canManageAccounts && (
        <Notice tone="info">
          Only the server owner can create or disable users. Your own account is shown below.
        </Notice>
      )}

      <div className="users-page-filter">
        <TextInput
          type="search"
          value={query}
          placeholder="Search users"
          aria-label="Search users"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {visibleAccounts.length === 0 ? (
        <EmptyState
          title={query.trim() ? "No users match your search" : "No users"}
          body={query.trim() ? "Try a different name or account ID." : "Add the first user to this server."}
        />
      ) : (
        <div className="users-list">
          {visibleAccounts.map((account) => {
            const membership = spaceAccess?.members.find((member) => member.userId === account.id);
            const isDisabled = account.status === "disabled";
            const canEditMembership = !!spaceAccess?.canManageMembers
              && !account.current
              && !isDisabled
              && (spaceAccess.role === "owner" || membership?.role !== "owner");
            const accessOptions = [
              { value: "none", label: "No access", detail: "Cannot open this Space." },
              ...roleOptionsFor(spaceAccess?.role),
            ];
            const accessValue: AccessChoice = membership?.role ?? "none";

            return (
              <article className="user-card" key={account.id}>
                <div className="user-card-main">
                  <div className="user-avatar" aria-hidden="true">{initials(account.name)}</div>
                  <div className="user-card-identity">
                    <div className="user-card-name">
                      <strong>{account.name}</strong>
                      {account.current && <Badge tone="accent">You</Badge>}
                      {account.managed && <Badge>Managed</Badge>}
                      {isDisabled && <Badge tone="danger">Disabled</Badge>}
                    </div>
                    <span className="user-card-id" title={account.id}>
                      {account.login ? `@${account.login}` : account.id}
                    </span>
                  </div>
                </div>

                <div className="user-card-access">
                  <div className="user-card-access-copy">
                    <span className="user-card-access-label">
                      {spaceAccess ? `${spaceAccess.name} access` : "Space access"}
                    </span>
                    <span className="user-card-access-hint">
                      {!spaceAccess
                        ? "Current Space is unavailable."
                        : accessValue === "none"
                          ? "This user cannot open the current Space."
                          : ROLE_OPTIONS.find((option) => option.value === accessValue)?.detail}
                    </span>
                  </div>
                  {spaceAccess && canEditMembership ? (
                    <Select
                      label={`Access level for ${account.name}`}
                      ariaLabel={`Access level for ${account.name}`}
                      value={accessValue}
                      options={accessOptions}
                      disabled={busy}
                      onChange={(value) => {
                        if (value === "none" || isSpaceRole(value)) {
                          void updateSpaceAccess(account, membership?.role, value);
                        }
                      }}
                    />
                  ) : (
                    <Badge tone={accessValue === "none" ? "neutral" : "info"}>
                      {accessValue === "none" ? "No access" : roleLabel(accessValue)}
                    </Badge>
                  )}
                </div>

                {canManageAccounts && !account.current && !account.managed && !isDisabled && (
                  <div className="user-card-actions">
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy}
                      onClick={() => {
                        setDisablePassword("");
                        setDisableTarget(account);
                      }}
                    >
                      Disable user
                    </Button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {adding && (
        <Dialog
          title="Add user"
          size="sm"
          className="users-dialog"
          initialFocus=".users-dialog-name"
          onClose={() => { if (!busy) { setAdding(false); resetAddForm(); } }}
          footer={(
            <>
              <Button variant="ghost" disabled={busy} onClick={() => { setAdding(false); resetAddForm(); }}>
                Cancel
              </Button>
              <Button
                variant="primary"
                busy={busy}
                disabled={!newName.trim() || !newLoginValid || !newPasswordValid || !ownerPassword}
                onClick={() => void createUser()}
              >
                Create user
              </Button>
            </>
          )}
        >
          <div className="users-dialog-form">
            <div className="users-dialog-intro">
              Create a sign-in for this Polyth server. Space access is explicit and can be changed later.
            </div>
            <label className="users-field">
              <span>Name</span>
              <TextInput
                className="users-dialog-name"
                value={newName}
                placeholder="Maria Kovalenko"
                autoComplete="off"
                onChange={(event) => setNewName(event.target.value)}
              />
            </label>
            <label className="users-field">
              <span>Login</span>
              <TextInput
                value={newLogin}
                placeholder="maria"
                autoComplete="off"
                spellCheck={false}
                invalid={newLogin.length > 0 && !newLoginValid}
                onChange={(event) => setNewLogin(event.target.value)}
              />
              <small>
                {newLogin.length > 0 && !newLoginValid
                  ? "Use 1–64 lowercase letters, numbers, dots, underscores, or hyphens."
                  : "This is what the user enters when signing in."}
              </small>
            </label>
            <label className="users-field">
              <span>Initial passphrase</span>
              <TextInput
                type="password"
                value={newPassword}
                placeholder="At least 12 characters"
                autoComplete="new-password"
                invalid={newPassword.length > 0 && !newPasswordValid}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <small>
                {newPassword.length > 0 && !newPasswordValid
                  ? "Use at least 12 characters."
                  : "The user can change it after signing in."}
              </small>
            </label>
            <div className="users-field">
              <span>{spaceAccess ? `Access to ${spaceAccess.name}` : "Space access"}</span>
              <Select
                label="Initial Space access"
                ariaLabel="Initial Space access"
                value={newRole}
                options={spaceAccess?.canManageMembers
                  ? [{ value: "none", label: "No access", detail: "Create the user without Space access." }, ...roleOptionsFor(spaceAccess.role)]
                  : [{ value: "none", label: "No access", detail: "You cannot manage members in the current Space." }]}
                disabled={busy}
                onChange={(value) => {
                  if (value === "none" || isSpaceRole(value)) setNewRole(value);
                }}
              />
            </div>
            <label className="users-field users-field-confirm">
              <span>Confirm with your password</span>
              <TextInput
                type="password"
                value={ownerPassword}
                placeholder="Your current password"
                autoComplete="current-password"
                onChange={(event) => setOwnerPassword(event.target.value)}
              />
              <small>Required for creating a server user.</small>
            </label>
          </div>
        </Dialog>
      )}

      {disableTarget && (
        <Dialog
          title={`Disable ${disableTarget.name}?`}
          size="sm"
          className="users-dialog"
          initialFocus=".users-disable-password"
          onClose={() => { if (!busy) { setDisableTarget(null); setDisablePassword(""); } }}
          footer={(
            <>
              <Button variant="ghost" disabled={busy} onClick={() => { setDisableTarget(null); setDisablePassword(""); }}>
                Cancel
              </Button>
              <Button variant="danger" busy={busy} disabled={!disablePassword} onClick={() => void disableUser()}>
                Disable user
              </Button>
            </>
          )}
        >
          <div className="users-dialog-form">
            <Notice tone="warning">
              The user will be signed out everywhere. Their identity and existing data are kept so the account can be recovered administratively.
            </Notice>
            <label className="users-field">
              <span>Confirm with your password</span>
              <TextInput
                className="users-disable-password"
                type="password"
                value={disablePassword}
                placeholder="Your current password"
                autoComplete="current-password"
                onChange={(event) => setDisablePassword(event.target.value)}
              />
            </label>
          </div>
        </Dialog>
      )}
    </div>
  );
}
