import { useEffect, useId, useState, type FormEvent } from "react";
import type { SecureSafePartition } from "@polyth/contracts";
import { replySecret } from "../../../apps/web/src/init.ts";
import type { PendingSecret } from "../../../apps/web/src/reduce.ts";
import { formatNumber, tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Icon, KeyIcon, LockIcon, Select, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { isImeComposing } from "@polyth/web-sdk";
import { vaultApi, type VaultAccess } from "./vaultApi.ts";

// A chat request for a credential is a sibling of the agent's question card:
// the same frame every Look paints (`.question-card`), the same head (badge +
// eyebrow) and foot (Reject at the start, the one primary at the end). Inside
// it stays quiet: the key's name, the agent's purpose, one field and one
// sentence (docs/dev/ui.md, "Agent request cards").
function SecretRequest({ secret, access, count }: { secret: PendingSecret; access: VaultAccess | null; count: number }) {
  const titleId = useId();
  const noteId = useId();
  const [value, setValue] = useState("");
  // Only an admin with a personal partition chooses; everyone else's save
  // lands in their own partition (the server decides either way).
  const choosing = Boolean(access?.personal && access.canManageSpace);
  const [partition, setPartition] = useState<SecureSafePartition>("personal");
  const [submitted, setSubmitted] = useState(false);
  const [failure, setFailure] = useState<"save" | "dismiss" | null>(null);

  const save = (event?: FormEvent) => {
    event?.preventDefault();
    if (!value || submitted || !secret.sessionId) return;
    const writeOnlyValue = value;
    setValue("");
    setSubmitted(true);
    setFailure(null);
    const sent = choosing
      ? vaultApi.saveRequested(secret.sessionId, secret.requestId, writeOnlyValue, partition)
      : replySecret(secret.sessionId, secret.requestId, "save", writeOnlyValue);
    void sent.catch(() => {
      setSubmitted(false);
      setFailure("save");
    });
  };

  const dismiss = () => {
    if (submitted || !secret.sessionId) return;
    setValue("");
    setSubmitted(true);
    setFailure(null);
    void replySecret(secret.sessionId, secret.requestId, "dismiss").catch(() => {
      setSubmitted(false);
      setFailure("dismiss");
    });
  };

  return (
    <form
      className="question-card credential-vault-request"
      aria-labelledby={titleId}
      aria-describedby={noteId}
      onSubmit={save}
    >
      <header className="question-head">
        <span className="question-badge" aria-hidden="true"><Icon icon={KeyIcon} size="sm" /></span>
        <span className="question-head-copy">
          <span className="question-eyebrow">{tr(count > 1 ? "securesafecard.eyebrowMany" : "securesafecard.eyebrow")}</span>
          {count > 1 && <span className="question-progress">{formatNumber(count)}</span>}
        </span>
      </header>
      <div className="credential-vault-body">
        <div className="credential-vault-name">
          <h3 id={titleId} className="question-prompt credential-vault-title" title={secret.handle}>{secret.label}</h3>
          {secret.existing && <span className="credential-vault-replaces">{tr("securesafecard.replacesSaved")}</span>}
        </div>
        {secret.purpose && <p className="credential-vault-purpose-line">{secret.purpose}</p>}
        <div
          className="credential-vault-well ui-field-well"
          data-filled={value ? "true" : undefined}
          data-invalid={failure === "save" ? "true" : undefined}
        >
          <Icon icon={LockIcon} size="sm" className="credential-vault-lock" />
          <TextInput
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            disabled={submitted}
            placeholder={tr("securesafecard.placeholder")}
            aria-label={tr("securesafecard.credentialValueForValue", { label: secret.label })}
            invalid={failure === "save"}
            onChange={(event) => {
              setValue(event.target.value);
              setFailure(null);
            }}
            onKeyDown={(event) => {
              // Confirming an IME candidate must not submit the form.
              if (event.key === "Enter" && isImeComposing(event)) event.preventDefault();
            }}
          />
        </div>
        <p id={noteId} className="credential-vault-note" role={failure ? "status" : undefined} aria-live={failure ? "polite" : undefined}>
          {failure ? tr(failure === "save" ? "securesafecard.saveFailed" : "securesafecard.dismissFailed") : (
            <>
              {tr("securesafecard.agentWontSee")}
              <span className="credential-vault-sep" aria-hidden="true">·</span>
              {choosing ? (
                <Select
                  className="credential-vault-scope"
                  label={tr("securesafecard.saveTo")}
                  value={partition}
                  disabled={submitted}
                  searchable={false}
                  options={[
                    { value: "personal", label: tr("securesafecard.saveToMe") },
                    { value: "space", label: tr("securesafecard.saveToSpace") },
                  ]}
                  onChange={(next) => setPartition(next === "space" ? "space" : "personal")}
                />
              ) : tr("securesafecard.saveToMe")}
            </>
          )}
        </p>
      </div>
      <footer className="question-actions">
        <Button size="sm" variant="ghost" className="question-reject" disabled={submitted} onClick={dismiss}>
          {tr("securesafecard.dismiss")}
        </Button>
        <span className="question-actions-end">
          <Button type="submit" size="sm" variant="primary" disabled={!value || submitted}>
            {submitted ? tr("securesafecard.submitted") : tr("securesafecard.save")}
          </Button>
        </span>
      </footer>
    </form>
  );
}

export default function CredentialVaultCard({ secrets }: { secrets: PendingSecret[] }) {
  const [access, setAccess] = useState<VaultAccess | null>(null);
  const open = secrets.length > 0;
  useEffect(() => {
    if (!open) return;
    let live = true;
    void vaultApi.access().then((next) => { if (live) setAccess(next); }, () => { /* no choice offered */ });
    return () => { live = false; };
  }, [open]);
  if (!open) return null;
  return (
    <div className="pkg-credential-vault credential-vault-requests">
      {secrets.map((secret) => (
        <SecretRequest key={secret.requestId} secret={secret} access={access} count={secrets.length} />
      ))}
    </div>
  );
}
