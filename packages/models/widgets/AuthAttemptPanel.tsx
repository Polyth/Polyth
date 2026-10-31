import { Button, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import CopyButton from "../../../apps/web/src/components/CopyButton.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import type { AuthAttemptDto, AuthErrorDto } from "@polyth/contracts";
import { safeHttpUrl } from "../src/auth/url.ts";
import { parseAuthorizationCode } from "../src/auth/parse.ts";
import { useEffect, useState } from "react";

export function AuthErrorLine({
  error,
  onRetry,
  retryLabel,
}: {
  error: AuthErrorDto;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="provider-auth-error" role="alert">
      <p>{error.message}</p>
      <span className="provider-auth-error-actions">
        {onRetry && <Button size="sm" onClick={onRetry}>{retryLabel ?? tr("settings.modelspage.retry")}</Button>}
        {error.details && (
          <Button size="sm" variant="ghost" onClick={() => setOpen((value) => !value)}>
            {tr("settings.modelspage.details")}
          </Button>
        )}
      </span>
      {open && error.details && <pre className="provider-auth-details">{error.details}</pre>}
    </div>
  );
}

function OpenCopy({ href, label }: { href: string; label: string }) {
  const safe = safeHttpUrl(href);
  if (!safe) return null;
  return (
    <div className="provider-auth-link-row">
      <a
        className="provider-auth-url"
        href={safe}
        target="_blank"
        rel="noopener noreferrer"
        title={safe}
      >
        {label || safe}
      </a>
      <a className="ui-btn ui-btn--quiet ui-btn--sm" href={safe} target="_blank" rel="noopener noreferrer">
        {tr("settings.modelspage.open")}
      </a>
      <CopyButton text={safe} label={tr("settings.modelspage.copy")} />
    </div>
  );
}

function formatRemaining(expiresAt: number, now: number): string | undefined {
  const delta = Math.max(0, expiresAt - now);
  if (!Number.isFinite(delta)) return undefined;
  const total = Math.floor(delta / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export default function AuthAttemptPanel({
  attempt,
  code,
  onCode,
  onComplete,
  onCancel,
  busy,
}: {
  attempt: AuthAttemptDto;
  code: string;
  onCode: (value: string) => void;
  onComplete: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!attempt.expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [attempt.expiresAt]);

  const remaining = attempt.expiresAt ? formatRemaining(attempt.expiresAt, now) : undefined;
  const heading = attempt.phase === "device_action_required"
    ? tr("settings.modelspage.completeSignIn")
    : tr("settings.modelspage.completeSignInInBrowser");
  const link = attempt.verificationUriComplete ?? attempt.verificationUri ?? attempt.url;
  const parsed = parseAuthorizationCode(code);

  return (
    <div className="provider-connect-authorization">
      <strong>{heading}</strong>
      {attempt.instructions && <p>{attempt.instructions}</p>}
      {attempt.loopbackWarning && (
        <p className="provider-auth-warning">{tr("settings.modelspage.loopbackUnreachable")}</p>
      )}
      {attempt.userCode && (
        <div className="provider-auth-code-row">
          <span className="provider-auth-label">{tr("settings.modelspage.deviceCode")}</span>
          <code className="provider-auth-code">{attempt.userCode}</code>
          <CopyButton text={attempt.userCode} label={tr("settings.modelspage.copy")} />
        </div>
      )}
      {link && (
        <div className="provider-auth-code-row">
          <span className="provider-auth-label">{tr("settings.modelspage.authorizationLink")}</span>
          <OpenCopy href={link} label={safeHttpUrl(link)?.replace(/^https?:\/\//, "") ?? link} />
        </div>
      )}
      {attempt.phase === "awaiting_code" && (
        <div className="provider-auth-code-form">
          <TextInput
            value={code}
            onChange={(event) => onCode(event.target.value)}
            placeholder={tr("settings.modelspage.pasteAuthorizationCodeOrCallbackUrl")}
            aria-label={tr("settings.modelspage.pasteAuthorizationCodeOrCallbackUrl")}
            spellCheck={false}
            autoComplete="off"
          />
          <Button
            size="sm"
            busy={busy}
            disabled={busy || !parsed.ok}
            onClick={onComplete}
          >
            {tr("settings.modelspage.complete")}
          </Button>
        </div>
      )}
      {(attempt.phase === "waiting"
        || attempt.phase === "browser_action_required"
        || attempt.phase === "device_action_required"
        || attempt.phase === "validating") && (
        <p className="muted" role="status" aria-live="polite">
          {tr("settings.modelspage.waitingForAuthorization")}
          {remaining ? ` · ${tr("settings.modelspage.expiresIn")} ${remaining}` : ""}
        </p>
      )}
      {attempt.error && <AuthErrorLine error={attempt.error} />}
      <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
        {tr("settings.modelspage.cancel")}
      </Button>
    </div>
  );
}
