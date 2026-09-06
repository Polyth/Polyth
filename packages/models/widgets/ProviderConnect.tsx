// Connect UI for one provider row: OAuth buttons (with any extra prompts a
// method needs, e.g. GitHub Enterprise's URL) and an API-key form only when
// the provider offers one. Stateless about
// whether the provider ends up connected — the caller re-fetches the
// catalog and decides what to render next.
import { useEffect, useRef, useState } from "react";
import { api, type ProviderAuthMethodDto, type ProviderAuthPromptDto } from "@polyth/session/web-api";
import { Button, Notice, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { knownOAuthFallback, shouldShowApiKeyAuth } from "./providerAuth.ts";

type PromptValues = Record<string, string>;

function promptVisible(prompt: ProviderAuthPromptDto, values: PromptValues): boolean {
  if (!prompt.when) return true;
  const actual = values[prompt.when.key] ?? "";
  return prompt.when.op === "eq" ? actual === prompt.when.value : actual !== prompt.when.value;
}

function PromptFields({
  prompts,
  values,
  onChange,
}: {
  prompts: ProviderAuthPromptDto[] | undefined;
  values: PromptValues;
  onChange: (key: string, value: string) => void;
}) {
  if (!prompts?.length) return null;
  return (
    <>
      {prompts.filter((p) => promptVisible(p, values)).map((p) => (
        p.type === "select" ? (
          <select
            key={p.key}
            className="ui-input provider-connect-select"
            aria-label={p.message}
            value={values[p.key] ?? ""}
            onChange={(e) => onChange(p.key, e.target.value)}
          >
            <option value="" disabled>{p.message}</option>
            {p.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : (
          <TextInput
            key={p.key}
            aria-label={p.message}
            placeholder={p.placeholder ?? p.message}
            value={values[p.key] ?? ""}
            onChange={(e) => onChange(p.key, e.target.value)}
          />
        )
      ))}
    </>
  );
}

export default function ProviderConnect({
  providerId,
  methods,
  onConnected,
  onDisconnect,
}: {
  providerId: string;
  methods: ProviderAuthMethodDto[] | undefined;
  /** Credentials were accepted — the caller should re-fetch the catalog. */
  onConnected: () => void;
  /** Present only for an already-connected provider's reconfigure panel. */
  onDisconnect?: () => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiPromptValues, setApiPromptValues] = useState<PromptValues>({});
  const [oauthPromptValues, setOauthPromptValues] = useState<Record<number, PromptValues>>({});
  const [authorization, setAuthorization] = useState<
    { methodIndex: number; url: string; method: "auto" | "code"; instructions: string } | null
  >(null);
  const [code, setCode] = useState("");
  const callbackAbortRef = useRef<AbortController | null>(null);

  useEffect(() => () => callbackAbortRef.current?.abort(), []);

  // Fall back to a known OAuth login when the backend reported no methods for
  // this provider (plugin providers like Cursor can be missing from
  // /provider/auth while the runtime warms up). Reported methods always win.
  const effectiveMethods = methods?.length ? methods : knownOAuthFallback(providerId, methods) ?? methods;
  const indexed = (effectiveMethods ?? []).map((m, index) => ({ ...m, index }));
  const oauthMethods = indexed.filter((m) => m.type === "oauth");
  const apiMethod = indexed.find((m) => m.type === "api");
  const showApiKey = shouldShowApiKeyAuth(effectiveMethods, providerId);

  const completeOAuth = async (methodIndex: number, code?: string) => {
    const busyKey = code ? "oauth-code" : "oauth-auto";
    const controller = new AbortController();
    callbackAbortRef.current?.abort();
    callbackAbortRef.current = controller;
    setBusy(busyKey);
    setError("");
    try {
      await api.completeProviderOAuth(providerId, methodIndex, code, controller.signal);
      if (controller.signal.aborted) return;
      setAuthorization(null);
      setCode("");
      onConnected();
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (callbackAbortRef.current === controller) callbackAbortRef.current = null;
      setBusy((current) => current === busyKey ? "" : current);
    }
  };

  const startOAuth = async (methodIndex: number) => {
    const busyKey = `oauth-${methodIndex}`;
    callbackAbortRef.current?.abort();
    setBusy(busyKey);
    setError("");
    try {
      const result = await api.authorizeProviderOAuth(providerId, methodIndex, oauthPromptValues[methodIndex]);
      setAuthorization({ methodIndex, ...result });
      if (typeof window !== "undefined" && providerId !== "claude-code") {
        window.open(result.url, "_blank", "noopener,noreferrer");
      }
      // OpenCode's auto OAuth flow persists credentials inside this blocking
      // callback. Polling the provider catalog cannot complete the login.
      if (result.method === "auto") void completeOAuth(methodIndex);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((current) => current === busyKey ? "" : current);
    }
  };

  const submitOAuthCode = async () => {
    if (!authorization || !code.trim()) return;
    await completeOAuth(authorization.methodIndex, code.trim());
  };

  const submitApiKey = async () => {
    if (!apiKey.trim()) return;
    setBusy("apikey");
    setError("");
    try {
      await api.connectProviderApiKey(
        providerId,
        apiKey.trim(),
        Object.keys(apiPromptValues).length ? apiPromptValues : undefined,
      );
      setApiKey("");
      onConnected();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const runDisconnect = async () => {
    if (!onDisconnect) return;
    setBusy("disconnect");
    setError("");
    try {
      await api.disconnectProvider(providerId);
      onDisconnect();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="provider-connect">
      {error && <div className="form-error" role="alert">{error}</div>}
      {oauthMethods.map((m) => (
        <div key={m.index} className="provider-connect-method">
          <PromptFields
            prompts={m.prompts}
            values={oauthPromptValues[m.index] ?? {}}
            onChange={(key, value) =>
              setOauthPromptValues((prev) => ({ ...prev, [m.index]: { ...prev[m.index], [key]: value } }))}
          />
          <Button
            variant="primary"
            busy={busy === `oauth-${m.index}`}
            disabled={Boolean(busy)}
            onClick={() => void startOAuth(m.index)}
          >
            {m.label}
          </Button>
          {authorization?.methodIndex === m.index && (
            <Notice tone="info" className="provider-connect-authorization">
              <p>{authorization.instructions}</p>
              <a href={authorization.url} target="_blank" rel="noopener noreferrer">
                {tr("settings.modelspage.openLoginPage")}
              </a>
              {authorization.method === "auto" ? (
                <p className="muted" role="status">{tr("settings.modelspage.waitingForBrowserLogin")}</p>
              ) : (
                <>
                  <TextInput
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder={tr("settings.modelspage.pasteTheAuthorizationCode")}
                    aria-label={tr("settings.modelspage.pasteTheAuthorizationCode")}
                  />
                  <Button size="sm" busy={busy === "oauth-code"} disabled={Boolean(busy)} onClick={() => void submitOAuthCode()}>
                    {tr("settings.modelspage.submitCode")}
                  </Button>
                </>
              )}
            </Notice>
          )}
        </div>
      ))}
      {oauthMethods.length > 0 && showApiKey && <div className="provider-connect-or muted">{tr("settings.modelspage.orApiKey")}</div>}
      {showApiKey && <div className="provider-connect-method">
        <PromptFields
          prompts={apiMethod?.prompts}
          values={apiPromptValues}
          onChange={(key, value) => setApiPromptValues((prev) => ({ ...prev, [key]: value }))}
        />
        <TextInput
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={tr("settings.modelspage.apiKey")}
          aria-label={tr("settings.modelspage.apiKey")}
        />
        <Button busy={busy === "apikey"} disabled={Boolean(busy) || !apiKey.trim()} onClick={() => void submitApiKey()}>
          {tr("settings.modelspage.connect")}
        </Button>
      </div>}
      {onDisconnect && (
        <Button variant="danger" size="sm" busy={busy === "disconnect"} disabled={Boolean(busy)} onClick={() => void runDisconnect()}>
          {tr("settings.modelspage.disconnect")}
        </Button>
      )}
    </div>
  );
}
