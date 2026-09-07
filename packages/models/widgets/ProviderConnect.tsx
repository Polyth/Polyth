import { useEffect, useState } from "react";
import {
  api,
  type ProviderAuthView as ProviderAuthViewDto,
} from "@polyth/session/web-api";
import type { AuthErrorDto, NormalizedAuthMethod } from "@polyth/contracts";
import { Button, Dialog } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  clearSecretValues,
  firstIncompleteField,
  pruneHiddenValues,
  withSelectDefaults,
  type PromptValues,
} from "../src/auth/prompts.ts";
import { classifyAuthUrl, safeHttpUrl } from "../src/auth/url.ts";
import { parseAuthorizationCode } from "../src/auth/parse.ts";
import { isTerminalPhase } from "../src/auth/state.ts";
import AuthFields from "./AuthFields.tsx";
import AuthAttemptPanel, { AuthErrorLine } from "./AuthAttemptPanel.tsx";
import { interactiveMethods, shouldOfferChooser } from "./providerAuth.ts";
import { useProviderAuthAttempt } from "./useProviderAuthAttempt.ts";

const sourceLabel = (view: ProviderAuthViewDto): string => {
  const source = view.credential?.source;
  if (source === "environment") return tr("settings.modelspage.credentialsFromEnvironment");
  if (view.credential?.verification === "saved") return tr("settings.modelspage.credentialsSaved");
  if (view.credential?.verification === "needs_reauth") return tr("settings.modelspage.needsReauthentication");
  return tr("settings.modelspage.connected");
};

const openSafe = (href: string | undefined): void => {
  const safe = safeHttpUrl(href);
  if (!safe) return;
  window.open(safe, "_blank", "noopener,noreferrer");
};

export default function ProviderConnect({
  providerId,
  view,
  onConnected,
  onDisconnect,
  onRetryDiscovery,
}: {
  providerId: string;
  view: ProviderAuthViewDto | undefined;
  onConnected: () => void;
  onDisconnect?: () => void;
  onRetryDiscovery?: () => void;
}) {
  const methods = interactiveMethods(view);
  const [selectedId, setSelectedId] = useState(methods[0]?.id ?? "");
  const [values, setValues] = useState<Record<string, PromptValues>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<AuthErrorDto | undefined>();
  const [methodErrors, setMethodErrors] = useState<Record<string, AuthErrorDto>>({});
  const [code, setCode] = useState("");
  const [reauth, setReauth] = useState(false);
  const { attempt, setAttempt } = useProviderAuthAttempt({
    restored: view?.activeAttempt,
    onConnected: () => {
      setCode("");
      setValues((prev) => {
        const next = { ...prev };
        for (const method of methods) next[method.id] = clearSecretValues(method.fields, next[method.id] ?? {});
        return next;
      });
      setReauth(false);
      onConnected();
    },
    onMethodError: (methodId, next) => {
      if (methodId) setMethodErrors((prev) => ({ ...prev, [methodId]: next }));
      setCode("");
      setValues((prev) => {
        const nextValues = { ...prev };
        for (const method of methods) nextValues[method.id] = clearSecretValues(method.fields, nextValues[method.id] ?? {});
        return nextValues;
      });
    },
  });

  useEffect(() => {
    if (!methods.some((method) => method.id === selectedId)) setSelectedId(methods[0]?.id ?? "");
  }, [methods, selectedId]);

  useEffect(() => () => {
    setValues({});
    setCode("");
  }, []);

  const startMethod = async (method: NormalizedAuthMethod) => {
    if (busy) return;
    setBusy(method.id);
    setError(undefined);
    setMethodErrors((prev) => {
      const next = { ...prev };
      delete next[method.id];
      return next;
    });
    try {
      const inputs = pruneHiddenValues(method.fields, withSelectDefaults(method.fields, values[method.id] ?? {}));
      const missing = firstIncompleteField(method.fields, inputs);
      if (missing) {
        setMethodErrors((prev) => ({
          ...prev,
          [method.id]: { code: "AUTH_INPUT_INVALID", message: tr("settings.modelspage.checkRequiredFields"), field: missing },
        }));
        return;
      }
      const started = await api.startProviderAuthAttempt(
        providerId,
        method.id,
        Object.keys(inputs).length ? inputs : undefined,
        view?.discovery.revision,
      );
      const href = started.verificationUriComplete ?? started.url;
      const kind = started.urlKind ?? classifyAuthUrl(href);
      if (href && (kind === "authorization" || kind === "device_verification")) openSafe(href);
      setAttempt(started);
      setValues((prev) => ({ ...prev, [method.id]: clearSecretValues(method.fields, inputs) }));
    } catch (caught) {
      const mapped: AuthErrorDto = {
        code: ((caught as { code?: string }).code as AuthErrorDto["code"]) ?? "AUTH_CALLBACK_FAILED",
        message: caught instanceof Error ? caught.message : String(caught),
        ...((caught as { details?: string }).details ? { details: (caught as { details: string }).details } : {}),
        ...((caught as { field?: string }).field ? { field: (caught as { field: string }).field } : {}),
      };
      setMethodErrors((prev) => ({ ...prev, [method.id]: mapped }));
    } finally {
      setBusy("");
    }
  };

  const submitCode = async () => {
    if (!attempt) return;
    const parsed = parseAuthorizationCode(code);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy("complete");
    try {
      setAttempt(await api.completeProviderAuthAttempt(attempt.id, parsed.code));
      setCode("");
    } catch (caught) {
      setError({
        code: ((caught as { code?: string }).code as AuthErrorDto["code"]) ?? "AUTH_CALLBACK_FAILED",
        message: caught instanceof Error ? caught.message : String(caught),
        ...((caught as { field?: string }).field ? { field: (caught as { field: string }).field } : {}),
      });
    } finally {
      setBusy("");
    }
  };

  const cancel = async () => {
    if (!attempt) return;
    setBusy("cancel");
    try {
      await api.cancelProviderAuthAttempt(attempt.id);
      setAttempt(null);
      setCode("");
      const method = methods.find((item) => item.id === attempt.methodId);
      if (method) {
        setValues((prev) => ({ ...prev, [method.id]: clearSecretValues(method.fields, prev[method.id] ?? {}) }));
      }
    } finally {
      setBusy("");
    }
  };

  const runDisconnect = async () => {
    if (!onDisconnect) return;
    setBusy("disconnect");
    setError(undefined);
    try {
      const result = await api.disconnectProvider(providerId) as { ok: true; remaining?: ProviderAuthViewDto["credential"] };
      onDisconnect();
      if (result.remaining?.source === "environment") {
        setError({
          code: "AUTH_SAVE_FAILED",
          message: tr("settings.modelspage.credentialsStillFromEnvironment"),
        });
      }
    } catch (caught) {
      setError({
        code: "AUTH_SAVE_FAILED",
        message: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setBusy("");
    }
  };

  const chooser = shouldOfferChooser(methods);
  const compactConnected = Boolean(
    view?.credential
    && view.credential.source !== "none"
    && onDisconnect
    && !attempt
    && !reauth,
  );
  const showRemoveStored = Boolean(
    onDisconnect
    && view?.credential
    && view.credential.source !== "environment"
    && view.credential.source !== "none",
  );

  return (
    <div className="provider-connect">
      {compactConnected && (
        <div className="provider-auth-status" role="status" aria-live="polite">
          <strong>{sourceLabel(view!)}</strong>
          {view?.credential?.envVarNames?.length ? (
            <span className="muted">{view.credential.envVarNames.join(", ")}</span>
          ) : null}
          <span className="provider-auth-error-actions">
            <Button size="sm" onClick={() => setReauth(true)}>
              {tr("settings.modelspage.reauthenticate")}
            </Button>
          </span>
        </div>
      )}
      {error && <AuthErrorLine error={error} onRetry={error.code === "AUTH_NETWORK_ERROR" ? onRetryDiscovery : undefined} />}
      {view?.discovery.status === "unavailable" && (
        <p className="muted">{tr("settings.modelspage.authManagedByDeployment")}</p>
      )}
      {view?.discovery.error && !methods.length && view.discovery.status !== "unavailable" && (
        <AuthErrorLine error={view.discovery.error} onRetry={onRetryDiscovery} />
      )}
      {view?.discovery.status === "empty" && !methods.length && (
        <p className="muted">{tr("settings.modelspage.noAuthMethods")}</p>
      )}
      {!compactConnected && chooser && (
        <div className="provider-auth-chooser" role="tablist" aria-label={tr("settings.modelspage.connectionSettings")}>
          {methods.map((method) => (
            <button
              key={method.id}
              type="button"
              role="tab"
              className={`chip provider-chip ${selectedId === method.id ? "on" : ""}`}
              aria-selected={selectedId === method.id}
              onClick={() => {
                const previous = methods.find((item) => item.id === selectedId);
                if (previous) {
                  setValues((prev) => ({ ...prev, [previous.id]: clearSecretValues(previous.fields, prev[previous.id] ?? {}) }));
                }
                setSelectedId(method.id);
              }}
            >
              {method.label}
            </button>
          ))}
        </div>
      )}
      {!compactConnected && (chooser ? methods.filter((method) => method.id === selectedId) : methods).map((method) => (
        <div key={method.id} className="provider-connect-method">
          {methodErrors[method.id] && (
            <AuthErrorLine
              error={methodErrors[method.id]!}
              retryLabel={tr("settings.modelspage.startAgain")}
              onRetry={methodErrors[method.id]?.code === "AUTH_CREDENTIAL_INVALID" || methodErrors[method.id]?.code === "AUTH_INPUT_INVALID"
                ? undefined
                : () => void startMethod(method)}
            />
          )}
          {(!method.usable || method.unavailability) && method.unavailability && (
            <AuthErrorLine error={method.unavailability} onRetry={() => void startMethod(method)} />
          )}
          {attempt?.methodId === method.id && !isTerminalPhase(attempt.phase) ? (
            <AuthAttemptPanel
              attempt={attempt}
              code={code}
              onCode={setCode}
              onComplete={() => void submitCode()}
              onCancel={() => void cancel()}
              busy={Boolean(busy)}
            />
          ) : (
            <>
              <AuthFields
                fields={method.fields}
                values={withSelectDefaults(method.fields, values[method.id] ?? {})}
                disabled={Boolean(busy)}
                invalidKey={methodErrors[method.id]?.field}
                onChange={(key, value) =>
                  setValues((prev) => ({ ...prev, [method.id]: { ...prev[method.id], [key]: value } }))}
              />
              <Button
                variant="primary"
                busy={busy === method.id}
                disabled={Boolean(busy) || !method.usable}
                onClick={() => void startMethod(method)}
              >
                {method.kind === "api" ? tr("settings.modelspage.connect") : method.label}
              </Button>
              {method.docsUrl && method.kind === "api" && safeHttpUrl(method.docsUrl) && (
                <a href={safeHttpUrl(method.docsUrl)} target="_blank" rel="noopener noreferrer">
                  {tr("settings.modelspage.getApiKey")}
                </a>
              )}
            </>
          )}
        </div>
      ))}
      {showRemoveStored && (
        <Button variant="danger" size="sm" busy={busy === "disconnect"} disabled={Boolean(busy)} onClick={() => void runDisconnect()}>
          {tr("settings.modelspage.removeStoredCredential")}
        </Button>
      )}
    </div>
  );
}

export function OrganizationLogin({ onDone }: { onDone: () => void }) {
  const [origin, setOrigin] = useState("");
  const [preview, setPreview] = useState<{ origin: string; hash: string; command: string[]; env: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<AuthErrorDto | undefined>();
  const executing = busy === "execute";

  const runPreview = async () => {
    setBusy("preview");
    setError(undefined);
    try {
      const next = await api.previewWellKnownAuth(origin) as { origin: string; hash: string; command: string[]; env: string };
      setPreview(next);
    } catch (caught) {
      setError({
        code: ((caught as { code?: string }).code as AuthErrorDto["code"]) ?? "AUTH_WELLKNOWN_UNSAFE",
        message: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setBusy("");
    }
  };

  const closePreview = () => {
    // Closing does not abort the reviewed command. While it is running, the
    // dialog stays open so Close cannot be mistaken for kill.
    if (executing) return;
    setPreview(null);
  };

  return (
    <div className="provider-org-login">
      <p className="muted">{tr("settings.modelspage.organizationLoginHint")}</p>
      <label className="provider-auth-field">
        <span className="provider-auth-label">{tr("settings.modelspage.organizationUrl")}</span>
        <input
          className="ui-input"
          value={origin}
          onChange={(event) => setOrigin(event.target.value)}
          placeholder="https://organization.example"
          autoComplete="url"
          spellCheck={false}
        />
      </label>
      {error && <AuthErrorLine error={error} />}
      <Button size="sm" variant="primary" busy={busy === "preview"} disabled={!origin.trim() || Boolean(busy)} onClick={() => void runPreview()}>
        {tr("settings.modelspage.reviewOrganizationLogin")}
      </Button>
      {preview && (
        <Dialog
          title={tr("settings.modelspage.confirmRemoteCommand")}
          onClose={closePreview}
          footer={(
            <>
              <Button disabled={executing} onClick={closePreview}>{tr("settings.modelspage.close")}</Button>
              <Button
                variant="primary"
                busy={executing}
                disabled={executing}
                onClick={() => {
                  const pending = preview;
                  setBusy("execute");
                  // Execute has no cancel: the reviewed command runs on this host until
                  // it exits or the server timeout. Close does not abort it.
                  void api.executeWellKnownAuth(pending.origin, pending.hash).then(() => {
                    setPreview(null);
                    setOrigin("");
                    onDone();
                  }).catch((caught) => {
                    setError({
                      code: ((caught as { code?: string }).code as AuthErrorDto["code"]) ?? "AUTH_CALLBACK_FAILED",
                      message: caught instanceof Error ? caught.message : String(caught),
                    });
                  }).finally(() => setBusy(""));
                }}
              >
                {tr("settings.modelspage.executeCommand")}
              </Button>
            </>
          )}
        >
          <p>{tr("settings.modelspage.remoteCommandFrom")} {preview.origin}</p>
          <p className="muted">{preview.env}</p>
          <pre className="provider-auth-details">{preview.command.map((part) => JSON.stringify(part)).join(" ")}</pre>
        </Dialog>
      )}
    </div>
  );
}
