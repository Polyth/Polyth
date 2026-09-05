// Connect UI for one provider row: OAuth buttons (with any extra prompts a
// method needs, e.g. GitHub Enterprise's URL) and a plain API-key form,
// stacked so every offered method is visible at once. Stateless about
// whether the provider ends up connected — the caller re-fetches the
// catalog and decides what to render next.
import { useEffect, useRef, useState } from "react";
import { api, type ProviderAuthMethodDto, type ProviderAuthPromptDto } from "@polyth/session/web-api";
import { Button, Notice, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

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
  /** Credentials were accepted (or a background OAuth check ran) — the
   *  caller should re-fetch the catalog. */
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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollAttemptsRef = useRef(0);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const indexed = (methods ?? []).map((m, index) => ({ ...m, index }));
  const oauthMethods = indexed.filter((m) => m.type === "oauth");
  const apiMethod = indexed.find((m) => m.type === "api");

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const checkNow = async () => {
    try { await api.refreshProviders(); } catch { /* best effort */ }
    onConnected();
  };

  const startPolling = () => {
    stopPolling();
    pollAttemptsRef.current = 0;
    pollRef.current = setInterval(() => {
      pollAttemptsRef.current += 1;
      if (pollAttemptsRef.current > 15) { stopPolling(); return; }
      void checkNow();
    }, 4000);
  };

  const startOAuth = async (methodIndex: number) => {
    setBusy(`oauth-${methodIndex}`);
    setError("");
    try {
      const result = await api.authorizeProviderOAuth(providerId, methodIndex, oauthPromptValues[methodIndex]);
      setAuthorization({ methodIndex, ...result });
      if (typeof window !== "undefined") window.open(result.url, "_blank", "noopener,noreferrer");
      if (result.method === "auto") startPolling();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  const submitOAuthCode = async () => {
    if (!authorization || !code.trim()) return;
    setBusy("oauth-code");
    setError("");
    try {
      await api.completeProviderOAuth(providerId, authorization.methodIndex, code.trim());
      setAuthorization(null);
      setCode("");
      onConnected();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
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
                <>
                  <p className="muted">{tr("settings.modelspage.waitingForBrowserLogin")}</p>
                  <Button size="sm" onClick={() => void checkNow()}>{tr("settings.modelspage.checkNow")}</Button>
                </>
              ) : (
                <>
                  <TextInput
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder={tr("settings.modelspage.pasteTheAuthorizationCode")}
                    aria-label={tr("settings.modelspage.pasteTheAuthorizationCode")}
                  />
                  <Button size="sm" busy={busy === "oauth-code"} onClick={() => void submitOAuthCode()}>
                    {tr("settings.modelspage.submitCode")}
                  </Button>
                </>
              )}
            </Notice>
          )}
        </div>
      ))}
      {oauthMethods.length > 0 && <div className="provider-connect-or muted">{tr("settings.modelspage.orApiKey")}</div>}
      <div className="provider-connect-method">
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
        <Button busy={busy === "apikey"} disabled={!apiKey.trim()} onClick={() => void submitApiKey()}>
          {tr("settings.modelspage.connect")}
        </Button>
      </div>
      {onDisconnect && (
        <Button variant="danger" size="sm" busy={busy === "disconnect"} onClick={() => void runDisconnect()}>
          {tr("settings.modelspage.disconnect")}
        </Button>
      )}
    </div>
  );
}
