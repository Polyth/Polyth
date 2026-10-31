import { useEffect, useId, useState } from "react";
import type { SecureSafePartition } from "@polyth/contracts";
import { replySecret } from "../../../apps/web/src/init.ts";
import type { PendingSecret } from "../../../apps/web/src/reduce.ts";
import { formatNumber, tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Select, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { isImeComposing } from "@polyth/web-sdk";
import { vaultApi, type VaultAccess } from "./vaultApi.ts";

function SecretRequest({ secret, access }: { secret: PendingSecret; access: VaultAccess | null }) {
  const requestId = useId();
  const [value, setValue] = useState("");
  // Only an admin with a personal partition chooses; everyone else's save
  // lands in their own partition (the server decides either way).
  const choosing = Boolean(access?.personal && access.canManageSpace);
  const [partition, setPartition] = useState<SecureSafePartition>("personal");
  const [submitted, setSubmitted] = useState(false);
  const [failure, setFailure] = useState<"save" | "dismiss" | null>(null);

  const save = () => {
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
    <fieldset className="credential-vault-request" aria-labelledby={requestId}>
      <legend id={requestId} className="credential-vault-request-legend">
        {tr("securesafecard.requestFor", { label: secret.label })}
      </legend>
      <div className="credential-vault-details">
        <div><span>{tr("securesafecard.label")}</span><strong>{secret.label}</strong></div>
        <div><span>{tr("securesafecard.handle")}</span><code>{secret.handle}</code></div>
        {secret.purpose && <div><span>{tr("securesafecard.purpose")}</span><p>{secret.purpose}</p></div>}
        {secret.existing && <div className="credential-vault-existing">{tr("securesafecard.willUpdateExistingHandle")}</div>}
      </div>
      <label className="credential-vault-value">
        <span>{tr("securesafecard.credentialValue")}</span>
        <TextInput
          type="password"
          autoComplete="off"
          value={value}
          disabled={submitted}
          placeholder={tr("securesafecard.enterValueItWillNotBeShown")}
          aria-label={tr("securesafecard.credentialValueForValue", { label: secret.label })}
          onChange={(event) => {
            setValue(event.target.value);
            setFailure(null);
          }}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return;
            if (event.key === "Enter") {
              event.preventDefault();
              save();
            }
          }}
        />
      </label>
      {choosing && (
        <div className="credential-vault-value">
          <span aria-hidden="true">{tr("securesafecard.saveTo")}</span>
          <Select
            label={tr("securesafecard.saveTo")}
            value={partition}
            disabled={submitted}
            options={[
              { value: "personal", label: tr("securesafecard.saveToMe") },
              { value: "space", label: tr("securesafecard.saveToSpace") },
            ]}
            onChange={(next) => setPartition(next === "space" ? "space" : "personal")}
          />
        </div>
      )}
      <div className="credential-vault-actions">
        <Button variant="primary" disabled={!value || submitted} onClick={save}>
          {submitted ? tr("securesafecard.submitted") : tr("securesafecard.saveToSecureSafe")}
        </Button>
        <Button disabled={submitted} onClick={dismiss}>{tr("securesafecard.dismiss")}</Button>
      </div>
      {failure && (
        <div className="credential-vault-status" role="status" aria-live="polite">
          {tr(failure === "save" ? "securesafecard.saveFailed" : "securesafecard.dismissFailed")}
        </div>
      )}
    </fieldset>
  );
}

export default function CredentialVaultCard({ secrets }: { secrets: PendingSecret[] }) {
  const titleId = useId();
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
    <section className="pkg-credential-vault credential-vault-card" aria-labelledby={titleId}>
      <div className="credential-vault-heading">
        <h2 id={titleId} className="credential-vault-title">{tr("securesafecard.secureSafeSaveCredential")}</h2>
        <span className="credential-vault-count">
          {tr("securesafecard.pendingRequestsCount", { count: formatNumber(secrets.length) })}
        </span>
      </div>
      <p className="credential-vault-security">{tr("securesafecard.writeOnlySecurityNote")}</p>
      {secrets.map((secret) => <SecretRequest key={secret.requestId} secret={secret} access={access} />)}
    </section>
  );
}
