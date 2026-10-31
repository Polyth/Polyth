// Dialogs for Settings → SSH remotes (Spaces §14.6): choosing who may use a
// shared connection (instance owner) and uploading the private key of a
// personal one. The key is typed or chosen in this protected form, sent once,
// cleared at once and never read back or logged.
import { useEffect, useMemo, useRef, useState } from "react";
import { createApiTransport } from "@polyth/web-sdk";
import { Button, Dialog, Notice, Textarea } from "../../../../apps/web/src/components/ui/index.ts";
import { CheckGroup, FormField } from "../../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../../apps/web/src/i18n/index.ts";
import {
  SSH_KEY_MAX_BYTES,
  sshAccessBody,
  sshAccessDraftFrom,
  sshKeyProblem,
  withUnknown,
  type Named,
  type SshAccessDraft,
  type SshConnectionView,
} from "./sshAccess.ts";

const api = createApiTransport();
const text = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const path = (id: string, leaf: "access" | "key") => `/api/ssh/connections/${encodeURIComponent(id)}/${leaf}`;

/** People and Spaces an access editor can name. Best effort: a failed list
 *  keeps saved ids editable under a neutral label. */
export function useAccessChoices(enabled: boolean): { people: Named[]; spaces: Named[] } {
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

/** Who besides the instance owner may use one shared connection: these
 *  people (in any Space) and everyone in these Spaces (there only). */
export function SshAccessDialog({ conn, people, spaces, onClose, onSaved }: {
  conn: SshConnectionView;
  people: Named[];
  spaces: Named[];
  onClose: () => void;
  onSaved: (next: SshConnectionView) => void;
}) {
  const [draft, setDraft] = useState<SshAccessDraft>(() => sshAccessDraftFrom(conn));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const personOptions = useMemo(() => withUnknown(people, draft.userIds, tr("ssh.sshaccess.unknownPerson")), [people, draft.userIds]);
  const spaceOptions = useMemo(() => withUnknown(spaces, draft.spaceIds, tr("ssh.sshaccess.unknownSpace")), [spaces, draft.spaceIds]);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      onSaved(await api.put<SshConnectionView>(path(conn.id, "access"), sshAccessBody(draft)));
    } catch (cause) {
      setError(text(cause));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={tr("ssh.sshaccess.dialogTitle", { name: conn.name })}
      size="sm"
      className="pkg-ssh-dialog"
      onClose={() => { if (!busy) onClose(); }}
      footer={(
        <>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>{tr("common.cancel")}</Button>
          <Button size="sm" variant="primary" busy={busy} onClick={() => void save()}>{tr("common.save")}</Button>
        </>
      )}
    >
      <div className="pkg-ssh ssh-access">
        <p className="ssh-footnote">{tr("ssh.sshaccess.summary")}</p>
        <fieldset className="ssh-access-field" disabled={busy}>
          <legend>{tr("ssh.sshaccess.people")}</legend>
          <p className="ssh-footnote">{tr("ssh.sshaccess.peopleHint")}</p>
          {personOptions.length > 0
            ? <CheckGroup label={tr("ssh.sshaccess.allowedPeople")} columns={2} value={draft.userIds} options={personOptions.map((person) => ({ id: person.id, label: person.name }))} onChange={(userIds) => setDraft({ ...draft, userIds })} />
            : <p className="ssh-footnote">{tr("ssh.sshaccess.accountsFailed")}</p>}
        </fieldset>
        <fieldset className="ssh-access-field" disabled={busy}>
          <legend>{tr("ssh.sshaccess.spaces")}</legend>
          <p className="ssh-footnote">{tr("ssh.sshaccess.spacesHint")}</p>
          {spaceOptions.length > 0
            ? <CheckGroup label={tr("ssh.sshaccess.allowedSpaces")} columns={2} value={draft.spaceIds} options={spaceOptions.map((space) => ({ id: space.id, label: space.name }))} onChange={(spaceIds) => setDraft({ ...draft, spaceIds })} />
            : <p className="ssh-footnote">{tr("ssh.sshaccess.spacesFailed")}</p>}
        </fieldset>
        {error && <Notice tone="error" role="alert">{error}</Notice>}
      </div>
    </Dialog>
  );
}

/** Upload (or replace) the private key of one personal connection. */
export function SshKeyDialog({ conn, onClose, onUploaded }: {
  conn: SshConnectionView;
  onClose: () => void;
  onUploaded: (next: SshConnectionView) => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const clear = () => {
    setKey("");
    if (file.current) file.current.value = "";
  };
  // Nothing of the key outlives the dialog.
  useEffect(() => clear, []);
  const choose = async (picked: File | undefined) => {
    setError("");
    if (!picked) return;
    if (picked.size > SSH_KEY_MAX_BYTES) {
      clear();
      setError(tr("ssh.key.tooLarge"));
      return;
    }
    setKey(await picked.text());
    if (file.current) file.current.value = "";
  };
  const send = async () => {
    const problem = sshKeyProblem(key);
    if (problem) { setError(problem); return; }
    const privateKey = key;
    clear();
    setBusy(true);
    setError("");
    try {
      onUploaded(await api.put<SshConnectionView>(path(conn.id, "key"), { privateKey }));
    } catch (cause) {
      setError(text(cause));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={tr(conn.keyUploaded ? "ssh.key.replaceTitle" : "ssh.key.title", { name: conn.name })}
      size="sm"
      className="pkg-ssh-dialog"
      onClose={() => { if (!busy) { clear(); onClose(); } }}
      footer={(
        <>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { clear(); onClose(); }}>{tr("common.cancel")}</Button>
          <Button size="sm" variant="primary" busy={busy} disabled={!key.trim()} onClick={() => void send()}>{tr("ssh.sshsettings.uploadKey")}</Button>
        </>
      )}
    >
      <form className="pkg-ssh ssh-key-form" autoComplete="off" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <p className="ssh-footnote">{tr("ssh.key.body")}</p>
        <FormField label={tr("ssh.key.label")} hint={tr("ssh.key.hint")}>
          {(field) => (
            <Textarea
              {...field}
              className="ssh-key-input"
              rows={5}
              value={key}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              data-1p-ignore=""
              data-lpignore="true"
              onChange={(event) => { setError(""); setKey(event.target.value); }}
            />
          )}
        </FormField>
        <div className="ssh-key-file">
          <input ref={file} type="file" className="ssh-key-file-input" tabIndex={-1} aria-hidden="true" onChange={(event) => void choose(event.target.files?.[0])} />
          <Button type="button" size="sm" variant="quiet" disabled={busy} onClick={() => file.current?.click()}>{tr("ssh.key.chooseFile")}</Button>
          {key && <span className="ssh-footnote" role="status">{tr("ssh.key.ready")}</span>}
        </div>
        {error && <Notice tone="error" role="alert">{error}</Notice>}
        {error && <p className="ssh-footnote">{tr("ssh.key.retry")}</p>}
      </form>
    </Dialog>
  );
}
