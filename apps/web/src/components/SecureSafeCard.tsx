import { useState } from "react";
import { replySecret } from "../init.ts";
import type { PendingSecret } from "../reduce.ts";

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
        <div><span>Label</span><strong>{secret.label}</strong></div>
        <div><span>Handle</span><code>{secret.handle}</code></div>
        {secret.purpose && <div><span>Purpose</span><p>{secret.purpose}</p></div>}
        {secret.existing && <div className="secure-safe-existing">Will update existing handle</div>}
      </div>
      <label className="secure-safe-value">
        <span>Credential value</span>
        <input
          type="password"
          autoComplete="off"
          value={value}
          disabled={submitted}
          placeholder="Enter value — it will not be shown again"
          aria-label={`Credential value for ${secret.label}`}
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
          {submitted ? "Submitted" : "Save to Secure Safe"}
        </button>
        <button disabled={submitted} onClick={dismiss}>Dismiss</button>
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
      <div className="secure-safe-title">Secure Safe — save credential</div>
      {secrets.map((secret) => <SecretRequest key={secret.requestId} secret={secret} />)}
    </div>
  );
}
