import { useState } from "react";
import { replySecret } from "../../../apps/web/src/init.ts";
import type { PendingSecret } from "../../../apps/web/src/reduce.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

function SecretRequest({ secret }: { secret: PendingSecret }) {
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const save = () => {
    if (!value || submitted) return;
    const writeOnlyValue = value;
    setValue("");
    setSubmitted(true);
    void replySecret(secret.requestId, "save", writeOnlyValue).catch(() => setSubmitted(false));
  };

  const dismiss = () => {
    if (submitted) return;
    setValue("");
    setSubmitted(true);
    void replySecret(secret.requestId, "dismiss").catch(() => setSubmitted(false));
  };

  return (
    <div className="secure-safe-request">
      <div className="secure-safe-details">
        <div><span>{tr("securesafecard.label")}</span><strong>{secret.label}</strong></div>
        <div><span>{tr("securesafecard.handle")}</span><code>{secret.handle}</code></div>
        {secret.purpose && <div><span>{tr("securesafecard.purpose")}</span><p>{secret.purpose}</p></div>}
        {secret.existing && <div className="secure-safe-existing">{tr("securesafecard.willUpdateExistingHandle")}</div>}
      </div>
      <label className="secure-safe-value">
        <span>{tr("securesafecard.credentialValue")}</span>
        <input
          type="password"
          autoComplete="off"
          value={value}
          disabled={submitted}
          placeholder={tr("securesafecard.enterValueItWillNotBeShown")}
          aria-label={tr("securesafecard.credentialValueForValue", { label: secret.label })}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              save();
            }
          }}
        />
      </label>
      <div className="secure-safe-actions">
        <button className="primary" disabled={!value || submitted} onClick={save}>
          {submitted ? tr("securesafecard.submitted") : tr("securesafecard.saveToSecureSafe")}
        </button>
        <button disabled={submitted} onClick={dismiss}>{tr("securesafecard.dismiss")}</button>
      </div>
    </div>
  );
}

export default function SecureSafeCard({ secrets }: { secrets: PendingSecret[] }) {
  if (secrets.length === 0) return null;
  return (
    <div
      className="secure-safe-card"
      role="alert"
      aria-live="assertive"
      aria-relevant="additions text"
    >
      <div className="secure-safe-title">{tr("securesafecard.secureSafeSaveCredential")}</div>
      {secrets.map((secret) => <SecretRequest key={secret.requestId} secret={secret} />)}
    </div>
  );
}
