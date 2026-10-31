// The person's own accounts on one code host (Spaces §14.4), shared by the
// GitHub and GitLab packages in Settings → Source control → Accounts. Each
// account is a row with its per-Space switch; Remove sits behind ⋯. The token
// is typed into this protected form, sent once, cleared even when refused,
// and never shown again. Providers own their routes and every word of copy.
import "./hosting-accounts.css";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { PersonHostingAccountDto } from "@polyth/contracts/source-control";
import { Badge, Button, IconButton, Menu, MoreIcon, Notice, TextInput, confirmAlert } from "../../../apps/web/src/components/ui/index.ts";
import { EmptyState, FormField, ItemList, ItemRow, Section, Toggle } from "../../../apps/web/src/components/settings/parts.tsx";

export interface HostingAccountsCopy {
  title: string;
  hint: string;
  loading: string;
  emptyTitle: string;
  emptyBody: string;
  add: string;
  connect: string;
  cancel: string;
  token: string;
  tokenHint: string;
  label: string;
  labelPlaceholder: string;
  server: string;
  serverHint: string;
  serverPlaceholder: string;
  onHere: string;
  offHere: string;
  remove: string;
  removeTitle: string;
  useHere(login: string): string;
  actions(login: string): string;
  removeConfirm(login: string): string;
}

export interface HostingAccountInput {
  token: string;
  label?: string;
  /** The server's web origin; absent for the provider's public host. */
  server?: string;
}

export interface HostingAccountsProps {
  copy: HostingAccountsCopy;
  /** The provider's mark, shown on each account tile. */
  glyph: ReactNode;
  /** The provider's public origin; other servers are named on the row. */
  defaultOrigin: string;
  load(): Promise<PersonHostingAccountDto[]>;
  /** Adds an account and answers the new list. */
  connect(input: HostingAccountInput): Promise<PersonHostingAccountDto[]>;
  setEnabled(id: string, enabled: boolean): Promise<PersonHostingAccountDto[]>;
  remove(id: string): Promise<PersonHostingAccountDto[]>;
  /** One readable sentence for a refused request. */
  errorText(cause: unknown): string;
}

const hostOf = (origin: string): string => {
  try { return new URL(origin).host; } catch { return origin; }
};

/** The row's facts after its login: another server, and whether it is on here. */
export function hostingAccountDetail(row: Pick<PersonHostingAccountDto, "origin" | "enabled">, defaultOrigin: string, copy: Pick<HostingAccountsCopy, "onHere" | "offHere">): string {
  return [row.origin !== defaultOrigin ? hostOf(row.origin) : "", row.enabled ? copy.onHere : copy.offHere].filter(Boolean).join(" · ");
}

export default function HostingAccounts(props: HostingAccountsProps) {
  const { copy, glyph, defaultOrigin } = props;
  // Providers may pass fresh closures each render; the requests read the
  // latest ones without refetching the list on every render.
  const calls = useRef(props);
  calls.current = props;
  const [rows, setRows] = useState<PersonHostingAccountDto[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [adding, setAdding] = useState(false);
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [server, setServer] = useState("");
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    void calls.current.load().then(
      (next) => { if (live.current) { setRows(next); setLoadError(""); } },
      (cause: unknown) => { if (live.current) setLoadError(calls.current.errorText(cause)); },
    );
    return () => { live.current = false; };
  }, []);

  const run = async (key: string, action: () => Promise<PersonHostingAccountDto[]>): Promise<boolean> => {
    setBusy(key);
    setError("");
    try {
      const next = await action();
      if (live.current) setRows(next);
      return true;
    } catch (cause) {
      if (live.current) setError(calls.current.errorText(cause));
      return false;
    } finally {
      if (live.current) setBusy("");
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const secret = token.trim();
    // The token lives in this form only until it is sent.
    setToken("");
    if (!secret) return;
    const ok = await run("add", () => calls.current.connect({
      token: secret,
      ...(label.trim() ? { label: label.trim() } : {}),
      ...(server.trim() ? { server: server.trim() } : {}),
    }));
    if (ok && live.current) { setLabel(""); setServer(""); setAdding(false); }
  };
  const confirmRemove = async (row: PersonHostingAccountDto) => {
    const confirmed = await confirmAlert(copy.removeConfirm(row.login), { title: copy.removeTitle, confirmLabel: copy.remove, destructive: true });
    if (confirmed) await run(`remove:${row.id}`, () => calls.current.remove(row.id));
  };
  const open = () => { setError(""); setAdding(true); };
  const cancel = () => { setToken(""); setAdding(false); setError(""); };

  return (
    <Section
      title={copy.title}
      hint={copy.hint}
      {...(rows?.length && !adding ? { action: <Button size="sm" variant="quiet" onClick={open}>{copy.add}</Button> } : {})}
    >
      {!rows && !loadError && <EmptyState compact busy title={copy.loading} />}
      {loadError && <Notice tone="error" role="alert">{loadError}</Notice>}
      {rows && rows.length > 0 && (
        <ItemList label={copy.title}>
          {rows.map((row) => (
            <ItemRow
              key={row.id}
              icon={glyph}
              title={`@${row.login}`}
              {...(row.label && row.label !== row.login ? { meta: <Badge>{row.label}</Badge> } : {})}
              description={hostingAccountDetail(row, defaultOrigin, copy)}
              inactive={!row.enabled}
              trailing={(
                <>
                  <Menu
                    label={copy.actions(row.login)}
                    align="end"
                    entries={[{ id: "remove", label: copy.remove, danger: true, disabled: busy !== "", onSelect: () => void confirmRemove(row) }]}
                  >
                    {(trigger) => <IconButton {...trigger} icon={MoreIcon} size="sm" label={copy.actions(row.login)} />}
                  </Menu>
                  <Toggle on={row.enabled} disabled={busy !== ""} label={copy.useHere(row.login)} onChange={(on) => void run(`enable:${row.id}`, () => calls.current.setEnabled(row.id, on))} />
                </>
              )}
            />
          ))}
        </ItemList>
      )}
      {rows?.length === 0 && !adding && (
        <EmptyState compact icon="key" title={copy.emptyTitle} body={copy.emptyBody} action={{ label: copy.connect, onClick: open }} />
      )}
      {adding && rows && (
        <form className="hosting-accounts-form" onSubmit={(event) => void submit(event)} autoComplete="off">
          <FormField label={copy.token} hint={copy.tokenHint}>
            {(field) => <TextInput {...field} type="password" value={token} autoComplete="off" spellCheck={false} autoCapitalize="off" autoFocus disabled={busy !== ""} onChange={(event) => setToken(event.target.value)} />}
          </FormField>
          <div className="hosting-accounts-form-pair">
            <FormField label={copy.label} optional>
              {(field) => <TextInput {...field} value={label} placeholder={copy.labelPlaceholder} disabled={busy !== ""} onChange={(event) => setLabel(event.target.value)} />}
            </FormField>
            <FormField label={copy.server} optional hint={copy.serverHint}>
              {(field) => <TextInput {...field} value={server} inputMode="url" spellCheck={false} autoCapitalize="off" placeholder={copy.serverPlaceholder} disabled={busy !== ""} onChange={(event) => setServer(event.target.value)} />}
            </FormField>
          </div>
          <div className="hosting-accounts-form-actions">
            <Button type="button" size="sm" variant="ghost" disabled={busy !== ""} onClick={cancel}>{copy.cancel}</Button>
            <Button type="submit" size="sm" variant="primary" busy={busy === "add"} disabled={busy !== "" || !token.trim()}>{copy.connect}</Button>
          </div>
        </form>
      )}
      {error && <Notice tone="error" role="alert" className="hosting-accounts-error">{error}</Notice>}
    </Section>
  );
}
