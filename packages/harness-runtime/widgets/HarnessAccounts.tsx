import { useCallback, useEffect, useMemo, useState } from "react";
import type { HarnessAccountsRef } from "@polyth/contracts";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { invalidateRuntimeCatalogs, readHarnessSnapshots } from "@polyth/models/runtime-catalog";
import { AddIcon, Button, confirmAlert, DeleteIcon, Dialog, EditIcon, IconButton, KeyIcon, Menu, MoreIcon, Notice, SharedIcon, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { CheckGroup, EmptyState, Section, Seg } from "../../../apps/web/src/components/settings/parts.tsx";
import { useHarnessSignIn, useSetupProjectId } from "./HarnessSignIn.tsx";
import {
  accessBody,
  accessDraftFrom,
  accessProblem,
  accessSummary,
  groupAccounts,
  rowUsable,
  type AccessDraft,
  type AccountList,
  type AccountRow,
  type AccountsTranslate,
  type Named,
} from "./accountsModel.ts";

const api = createApiTransport();

const stateLabel = (row: AccountRow, t: AccountsTranslate) => row.status.loggedIn === true ? t("state.signedIn") : row.status.loggedIn === false ? t("state.signedOut") : t("state.unverified");

/** People and Spaces an access editor can name. Best-effort: a failed list
 *  keeps saved ids editable under a neutral label. */
function useAccessChoices(enabled: boolean): { people: Named[]; spaces: Named[] } {
  const [people, setPeople] = useState<Named[]>([]);
  const [spaces, setSpaces] = useState<Named[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void api.get<{ accounts?: Array<{ id: string; name?: string; displayName?: string; status?: string }> }>("/api/auth/accounts").then((body) => {
      if (!live) return;
      setPeople((body.accounts ?? [])
        .filter((account) => account.status !== "disabled" && account.status !== "offboarding")
        .map((account) => ({ id: account.id, name: account.name ?? account.displayName ?? account.id })));
    }, () => {});
    void api.get<{ spaces?: Array<{ id: string; name: string }> }>("/api/spaces").then((body) => {
      if (live) setSpaces((body.spaces ?? []).map((space) => ({ id: space.id, name: space.name })));
    }, () => {});
    return () => { live = false; };
  }, [enabled]);
  return { people, spaces };
}

/** Extra native logins of one harness family. Each one becomes its own
 *  harness, so it shows up in the harness list and the picker; sign-in runs
 *  the native CLI in a terminal, like the harness setup action. */
export default function HarnessAccounts({ host, accounts, projectId }: { host: WebPackageHost; accounts: HarnessAccountsRef; projectId?: string | null }) {
  const t: AccountsTranslate = useCallback((key, values) => host.ui.locale.translate(`harnessruntime.accounts.${key}`, values), [host]);
  const [list, setList] = useState<AccountList>();
  const [busy, setBusy] = useState("");
  const [failure, setFailure] = useState("");
  const [newName, setNewName] = useState("");
  const [newPrivate, setNewPrivate] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string }>();
  const [editingAccess, setEditingAccess] = useState<AccountRow>();
  const base = accounts.endpoint;
  const choices = useAccessChoices(Boolean(list?.accounts.some((row) => row.accessEditable)));

  const load = useCallback(async () => {
    try {
      setList(await api.get<AccountList>(base));
    } catch (cause) {
      setFailure(host.errors.friendly(t("action.load"), cause));
    }
  }, [host, base, t]);
  useEffect(() => {
    void load();
    // Returning from a sign-in terminal is the moment the status changes.
    const focus = () => { void load(); };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [load]);

  const run = async (key: string, label: string, action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key);
    setFailure("");
    try {
      await action();
      await load();
      // Harness rows and picker tabs come from the catalog; re-probe so a new,
      // renamed or removed account is reflected everywhere.
      await readHarnessSnapshots({ projectId, force: true }).catch(() => {});
      invalidateRuntimeCatalogs();
      return true;
    } catch (cause) {
      setFailure(host.errors.friendly(label, cause));
      return false;
    } finally {
      setBusy("");
    }
  };

  const openProjectId = useSetupProjectId(host);
  const guide = useHarnessSignIn({ host, projectId: projectId ?? openProjectId });
  const signIn = (row: AccountRow) => {
    if (!row.signInCommand || !list) return;
    const label = row.name ? `${list.label} · ${row.name}` : list.label;
    guide.start({ harnessId: row.harnessId, harnessName: label, command: row.signInCommand, kind: row.status.loggedIn === true ? "sign-in-again" : "sign-in" });
  };

  if (!list) return <div className="pkg-harnesses-accounts" aria-busy="true">{failure ? <Notice tone="error" role="alert">{failure}</Notice> : <EmptyState compact busy title={t("checking")} />}</div>;

  const remove = async (row: AccountRow, label: string) => {
    if (!await confirmAlert(t("removeBody"), { title: t("removeTitle", { name: label }), confirmLabel: t("remove") })) return;
    void run(`remove:${row.id}`, t("action.remove"), () => api.delete(`${base}/${row.id}`));
  };
  const groups = groupAccounts(list.accounts);
  const renderRow = (row: AccountRow) => {
    const label = row.name || t("defaultName");
    const usable = rowUsable(row);
    const plan = row.status.plan ? t("plan", { plan: `${row.status.plan.charAt(0).toUpperCase()}${row.status.plan.slice(1)}` }) : "";
    const detail = [row.status.email, plan].filter(Boolean).join(" · ");
    // An account the caller can't use keeps a neutral dot: its sign-in isn't theirs to fix.
    const state = !usable ? "off" : row.status.loggedIn === true ? "ready" : row.status.loggedIn === false ? "auth-required" : "unknown";
    const canEdit = row.removable && list.manageable;
    return <li key={row.id} className="pkg-harnesses-accounts-row" data-usable={usable ? undefined : "false"} data-state={row.status.loggedIn === true ? "signed-in" : row.status.loggedIn === false ? "signed-out" : "unknown"}>
      {renaming?.id === row.id
        ? <form className="pkg-harnesses-accounts-rename" onSubmit={(event) => { event.preventDefault(); void run(`rename:${row.id}`, t("action.rename"), () => api.patch(`${base}/${row.id}`, { name: renaming.name })).then((ok) => { if (ok) setRenaming(undefined); }); }}>
            <TextInput uiSize="sm" aria-label={t("renameAria", { name: label })} value={renaming.name} maxLength={60} autoFocus onChange={(event) => setRenaming({ id: row.id, name: event.target.value })} />
            <Button size="sm" variant="ghost" onClick={() => setRenaming(undefined)}>{t("cancel")}</Button>
            <Button size="sm" type="submit" busy={busy === `rename:${row.id}`} disabled={!renaming.name.trim()}>{t("save")}</Button>
          </form>
        : <span className="pkg-harnesses-accounts-name">
            <span className="pkg-harnesses-accounts-title"><strong>{label}</strong></span>
            <small><span className="pkg-harnesses-status" data-state={state}>{usable ? stateLabel(row, t) : t("state.unavailable")}</span>{detail && <span>{detail}</span>}</small>
            {row.accessEditable && <small className="pkg-harnesses-accounts-access">{t("accessLine", { summary: accessSummary(row, choices.people, choices.spaces, t) })}</small>}
          </span>}
      {renaming?.id !== row.id && <span className="pkg-harnesses-accounts-actions">
        {row.signInCommand && usable && <Button size="sm" variant={row.status.loggedIn === true ? "ghost" : "primary"} iconStart={KeyIcon} disabled={Boolean(busy) || !list.manageable} onClick={() => signIn(row)}>{row.status.loggedIn === true ? t("signInAgain") : t("signIn")}</Button>}
        {row.accessEditable && <Button size="sm" variant="ghost" iconStart={SharedIcon} disabled={Boolean(busy)} aria-label={t("accessAria", { name: label })} onClick={() => { setFailure(""); setEditingAccess(row); }}>{t("access")}</Button>}
        {canEdit && <Menu label={t("menuLabel", { name: label })} align="end" entries={[
          { id: "rename", label: t("rename"), icon: EditIcon, disabled: Boolean(busy), onSelect: () => setRenaming({ id: row.id, name: row.name }) },
          { id: "remove", label: t("remove"), icon: DeleteIcon, danger: true, disabled: Boolean(busy), onSelect: () => void remove(row, label) },
        ]}>
          {(trigger) => <IconButton {...trigger} icon={MoreIcon} size="sm" busy={busy === `remove:${row.id}`} label={t("moreActions", { name: label })} />}
        </Menu>}
      </span>}
    </li>;
  };
  const group = (key: string, title: string, rows: AccountRow[], hint: string, empty?: string) => (rows.length > 0 || empty) && <section className="pkg-harnesses-accounts-group" aria-labelledby={`pkg-harnesses-accounts-${key}`}>
    <header className="pkg-harnesses-accounts-group-head">
      <h4 id={`pkg-harnesses-accounts-${key}`}>{title}</h4>
      <p className="pkg-harnesses-accounts-help">{hint}</p>
    </header>
    {rows.length > 0
      ? <ul className="pkg-harnesses-accounts-list">{rows.map(renderRow)}</ul>
      : <p className="pkg-harnesses-accounts-empty">{empty}</p>}
  </section>;
  const addsPrivate = !list.canAddShared || newPrivate;

  return <div className="pkg-harnesses-accounts">
    <Section title={t("title")} hint={t("hint", { label: list.label })}>
      {failure && !editingAccess && <Notice tone="error" role="alert">{failure}</Notice>}
      {list.unsupported && <Notice>{list.unsupported}</Notice>}
      {group("mine", t("group.mine"), groups.mine, t("group.mineHint"), list.manageable ? t("group.mineEmpty") : undefined)}
      {group("shared", t("group.shared"), groups.shared, list.canEditAccess ? t("group.sharedHintEdit") : t("group.sharedHint"))}
      {group("others", t("group.others"), groups.others, t("group.othersHint"))}
      {list.manageable
        ? <form className="pkg-harnesses-accounts-add" onSubmit={(event) => {
            event.preventDefault();
            void run("add", t("action.add"), () => api.post(base, { name: newName, ...(list.canAddShared && newPrivate ? { private: true } : {}) })).then((ok) => { if (ok) setNewName(""); });
          }}>
            <div className="pkg-harnesses-accounts-add-fields">
              <TextInput uiSize="sm" aria-label={t("nameAria")} placeholder={t("namePlaceholder")} value={newName} maxLength={60} onChange={(event) => setNewName(event.target.value)} />
              {list.canAddShared && <Seg label={t("whoGroup")} value={newPrivate ? "private" : "shared"} disabled={Boolean(busy)} options={[["shared", t("scope.shared")], ["private", t("scope.private")]]} onChange={(value) => setNewPrivate(value === "private")} />}
              <Button size="sm" type="submit" iconStart={AddIcon} busy={busy === "add"} disabled={Boolean(busy) || !newName.trim()}>{t("add")}</Button>
            </div>
            <p className="pkg-harnesses-accounts-help">{addsPrivate ? t("addPrivateHint") : t("addSharedHint")}</p>
          </form>
        : !list.unsupported && <p className="pkg-harnesses-accounts-help">{t("cannotAdd")}</p>}
    </Section>
    {editingAccess && <AccessDialog
      row={editingAccess}
      title={editingAccess.name || t("defaultTitle", { label: list.label })}
      people={choices.people}
      spaces={choices.spaces}
      onClose={() => setEditingAccess(undefined)}
      onSave={async (draft) => {
        const ok = await run(`access:${editingAccess.id}`, t("action.access"), () => api.put(`${base}/${editingAccess.id}/access`, accessBody(draft)));
        if (ok) setEditingAccess(undefined);
      }}
      busy={busy === `access:${editingAccess.id}`}
      t={t}
      failure={failure}
    />}
    {guide.dialog}
  </div>;
}

/** Choose who may use one shared account: everyone (default) or some people,
 *  in every Space or some. Ids the lists no longer show stay selected. */
function AccessDialog({ row, title, people, spaces, busy, failure, t, onClose, onSave }: {
  row: AccountRow;
  title: string;
  people: Named[];
  spaces: Named[];
  busy: boolean;
  failure: string;
  t: AccountsTranslate;
  onClose: () => void;
  onSave: (draft: AccessDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<AccessDraft>(() => accessDraftFrom(row));
  const problem = accessProblem(draft, t);
  const withUnknown = (known: Named[], saved: string[], label: string): Named[] =>
    [...known, ...saved.filter((id) => !known.some((entry) => entry.id === id)).map((id) => ({ id, name: label }))];
  const personOptions = useMemo(() => withUnknown(people, draft.userIds, t("dialog.personGone")), [people, draft.userIds, t]);
  const spaceOptions = useMemo(() => withUnknown(spaces, draft.spaceIds, t("dialog.spaceGone")), [spaces, draft.spaceIds, t]);
  return <Dialog
    title={t("dialog.title", { name: title })}
    size="sm"
    className="pkg-harnesses-access-dialog"
    onClose={() => { if (!busy) onClose(); }}
    footer={<>
      <Button variant="ghost" disabled={busy} onClick={onClose}>{t("cancel")}</Button>
      <Button variant="primary" busy={busy} disabled={Boolean(problem)} onClick={() => void onSave(draft)}>{t("save")}</Button>
    </>}
  >
    <div className="pkg-harnesses-access">
      <fieldset className="pkg-harnesses-access-field" disabled={busy}>
        <legend>{t("dialog.people")}</legend>
        <Seg label={t("dialog.peopleGroup")} value={draft.people} options={[["everyone", t("access.everyone")], ["selected", t("dialog.onlySelected")]]} onChange={(value) => setDraft({ ...draft, people: value })} />
        {draft.people === "selected" && (personOptions.length > 0
          ? <CheckGroup label={t("dialog.allowedPeople")} columns={2} value={draft.userIds} options={personOptions.map((person) => ({ id: person.id, label: person.name }))} onChange={(userIds) => setDraft({ ...draft, userIds })} />
          : <p className="pkg-harnesses-accounts-help">{t("dialog.peopleLoadFailed")}</p>)}
      </fieldset>
      <fieldset className="pkg-harnesses-access-field" disabled={busy}>
        <legend>{t("dialog.spaces")}</legend>
        <Seg label={t("dialog.spacesGroup")} value={draft.spaces} options={[["everyone", t("dialog.everySpace")], ["selected", t("dialog.onlySelected")]]} onChange={(value) => setDraft({ ...draft, spaces: value })} />
        {draft.spaces === "selected" && (spaceOptions.length > 0
          ? <CheckGroup label={t("dialog.allowedSpaces")} columns={2} value={draft.spaceIds} options={spaceOptions.map((space) => ({ id: space.id, label: space.name }))} onChange={(spaceIds) => setDraft({ ...draft, spaceIds })} />
          : <p className="pkg-harnesses-accounts-help">{t("dialog.spacesLoadFailed")}</p>)}
      </fieldset>
      <p className="pkg-harnesses-accounts-help">{t("dialog.appliesToYou")}</p>
      {problem && <Notice tone="warning">{problem}</Notice>}
      {failure && <Notice tone="error" role="alert">{failure}</Notice>}
    </div>
  </Dialog>;
}
