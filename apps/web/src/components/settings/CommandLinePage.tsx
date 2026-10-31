import { useCallback, useEffect, useRef, useState } from "react";
import {
  accessLevel, createCliToken, decideCliDevice, isCompleteUserCode, loadCliAccess, lookupCliDevice,
  normalizeUserCode, revokeCliToken, setCliTrust,
  type CliAccessState, type CliDeviceRequest, type CliProfile, type CliTokenSummary, type CliTrustMode,
} from "../../cliAccess.ts";
import { getLocale, tr } from "../../i18n/index.ts";
import { activeSpace, useSpaces } from "../../spaces.ts";
import { Badge, Button, Notice, Switch, TextInput, VisuallyHidden, confirmAlert } from "../ui/index.ts";
import { EmptyState, FormField, PageHead, Row, Section, Seg } from "./parts.tsx";
import { isReauthCancelled, useOwnerReauth } from "./ownerReauth.tsx";
import { accountErrorText } from "./usersModel.ts";
import "./CommandLinePage.css";

const when = (ts: number): string => new Date(ts).toLocaleString(getLocale());

const EXPIRY_OPTIONS: Array<[string, number | null, string]> = [
  ["30", 30, tr("settings.commandline.expiry30")],
  ["90", 90, tr("settings.commandline.expiry90")],
  ["365", 365, tr("settings.commandline.expiry365")],
  ["never", null, tr("settings.commandline.expiryNever")],
];

const TRUST_OPTIONS: Array<[CliTrustMode, string, string]> = [
  ["off", tr("settings.commandline.trustOff"), tr("settings.commandline.trustOffHint")],
  ["loopback", tr("settings.commandline.trustLoopback"), tr("settings.commandline.trustLoopbackHint")],
  ["private-network", tr("settings.commandline.trustPrivate"), tr("settings.commandline.trustPrivateHint")],
];

const accessText = (level: "read" | "control"): string =>
  level === "control" ? tr("settings.commandline.accessControl") : tr("settings.commandline.accessRead");

const errorText = (cause: unknown): string => {
  const code = (cause as { code?: unknown } | null)?.code;
  if (code === "not-found") return tr("settings.commandline.codeUnknown");
  if (code === "conflict") return tr("settings.commandline.changedElsewhere");
  return accountErrorText(cause);
};

/** `?code=` from the deep link; read once, then removed from the URL so a
 *  reload cannot re-trigger the confirmation. */
function takeCodeFromUrl(): string {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  const raw = url.searchParams.get("code");
  if (raw === null) return "";
  url.searchParams.delete("code");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return normalizeUserCode(raw);
}

export default function CommandLinePage() {
  const [state, setState] = useState<CliAccessState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { withReauth, prompt } = useOwnerReauth();

  const refresh = useCallback(async () => {
    try {
      setState(await loadCliAccess());
      setLoadError(null);
    } catch (cause) {
      setLoadError(errorText(cause));
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  if (loadError && !state) {
    return (
      <div className="cli-page">
        <PageHead blurb={tr("settings.commandline.blurb")} />
        <EmptyState title={tr("settings.commandline.loadFailed")} body={loadError} />
      </div>
    );
  }
  if (!state) {
    return (
      <div className="cli-page">
        <PageHead blurb={tr("settings.commandline.blurb")} />
        <EmptyState title={tr("common.loading")} busy />
      </div>
    );
  }
  return (
    <div className="cli-page">
      <PageHead blurb={tr("settings.commandline.blurb")} />
      <DeviceConfirm withReauth={withReauth} onDone={refresh} />
      <TokenList tokens={state.tokens} onChanged={refresh} />
      <CreateToken state={state} withReauth={withReauth} onCreated={refresh} />
      {state.canManageTrust && <TrustMode state={state} withReauth={withReauth} onChanged={refresh} />}
      <GetCli />
      {prompt}
    </div>
  );
}

type WithReauth = ReturnType<typeof useOwnerReauth>["withReauth"];

function DeviceConfirm({ withReauth, onDone }: { withReauth: WithReauth; onDone: () => Promise<void> }) {
  const [code, setCode] = useState(takeCodeFromUrl);
  const [request, setRequest] = useState<CliDeviceRequest | null>(null);
  const [busy, setBusy] = useState<"lookup" | "approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"approved" | "denied" | null>(null);
  const autoLooked = useRef(false);

  const lookup = useCallback(async (value: string) => {
    if (!isCompleteUserCode(value)) return;
    setBusy("lookup");
    setError(null);
    setDone(null);
    try {
      setRequest(await lookupCliDevice(value));
    } catch (cause) {
      setRequest(null);
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    if (autoLooked.current || !isCompleteUserCode(code)) return;
    autoLooked.current = true;
    void lookup(code);
  }, [code, lookup]);

  const decide = async (approve: boolean) => {
    if (!request) return;
    setBusy(approve ? "approve" : "deny");
    setError(null);
    try {
      await withReauth(() => decideCliDevice(request.userCode, approve));
      setDone(approve ? "approved" : "denied");
      setRequest(null);
      setCode("");
      await onDone();
    } catch (cause) {
      if (!isReauthCancelled(cause)) setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title={tr("settings.commandline.confirmTitle")} hint={tr("settings.commandline.confirmHint")}>
      <form
        className="cli-code-form"
        onSubmit={(event) => { event.preventDefault(); void lookup(code); }}
      >
        <FormField label={tr("settings.commandline.codeLabel")}>
          {(field) => (
            <TextInput
              {...field}
              className="cli-code-input"
              value={code}
              placeholder="XXXX-XXXX"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(event) => { setCode(normalizeUserCode(event.target.value)); setRequest(null); setDone(null); }}
            />
          )}
        </FormField>
        <Button type="submit" variant="quiet" busy={busy === "lookup"} disabled={!isCompleteUserCode(code) || busy !== null}>
          {tr("settings.commandline.lookUp")}
        </Button>
      </form>
      {error && <Notice tone="error" role="alert">{error}</Notice>}
      {done === "approved" && <Notice tone="success" role="status">{tr("settings.commandline.approved")}</Notice>}
      {done === "denied" && <Notice tone="info" role="status">{tr("settings.commandline.denied")}</Notice>}
      {request && (
        <div className="cli-request" role="group" aria-label={tr("settings.commandline.requestLabel")}>
          <dl className="cli-facts">
            <dt>{tr("settings.commandline.deviceName")}</dt><dd>{request.label}</dd>
            <dt>{tr("settings.commandline.access")}</dt><dd>{accessText(accessLevel(request.grants))}</dd>
            <dt>{tr("settings.commandline.address")}</dt><dd>{request.clientAddress ?? tr("settings.commandline.unknown")}</dd>
            <dt>{tr("settings.commandline.codeExpires")}</dt><dd>{when(request.expiresAt)}</dd>
          </dl>
          <Notice tone="warning">{tr("settings.commandline.confirmWarning")}</Notice>
          <div className="cli-actions">
            <Button variant="primary" busy={busy === "approve"} disabled={busy !== null} onClick={() => void decide(true)}>
              {tr("settings.commandline.approve")}
            </Button>
            <Button variant="ghost" busy={busy === "deny"} disabled={busy !== null} onClick={() => void decide(false)}>
              {tr("settings.commandline.deny")}
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

function TokenList({ tokens, onChanged }: { tokens: CliTokenSummary[]; onChanged: () => Promise<void> }) {
  const spaces = useSpaces();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const revoke = async (token: CliTokenSummary) => {
    const ok = await confirmAlert(tr("settings.commandline.revokeBody"), {
      title: tr("settings.commandline.revokeTitle", { name: token.label }),
      confirmLabel: tr("settings.commandline.revoke"),
      destructive: true,
    });
    if (!ok) return;
    setBusyId(token.id);
    setError(null);
    try {
      await revokeCliToken(token);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusyId(null);
      await onChanged();
    }
  };

  const spaceName = (id: string): string => spaces.spaces.find((space) => space.id === id)?.name ?? tr("settings.commandline.otherSpace");

  return (
    <Section title={tr("settings.commandline.listTitle")}>
      {error && <Notice tone="error" role="alert">{error}</Notice>}
      {tokens.length === 0 ? (
        <EmptyState compact icon="terminal" title={tr("settings.commandline.empty")} body={tr("settings.commandline.emptyBody")} />
      ) : (
        <ul className="cli-tokens">
          {tokens.map((token) => (
            <li key={token.id} className="cli-token">
              <div className="cli-token-head">
                <strong className="cli-token-name">{token.label}</strong>
                <Badge tone={token.kind === "device" ? "info" : "neutral"}>
                  {token.kind === "device" ? tr("settings.commandline.kindTerminal") : tr("settings.commandline.kindAutomation")}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  className="cli-token-revoke"
                  busy={busyId === token.id}
                  disabled={busyId !== null}
                  onClick={() => void revoke(token)}
                >
                  {tr("settings.commandline.revoke")}
                </Button>
              </div>
              <dl className="cli-facts">
                <dt>{tr("settings.commandline.access")}</dt><dd>{accessText(accessLevel(token.grants))}</dd>
                {token.spaceId && (<><dt>{tr("settings.commandline.space")}</dt><dd>{spaceName(token.spaceId)}</dd></>)}
                <dt>{tr("settings.commandline.created")}</dt><dd>{when(token.createdAt)}</dd>
                <dt>{tr("settings.commandline.lastUsed")}</dt>
                <dd>{token.lastUsedAt === null ? tr("settings.commandline.never") : when(token.lastUsedAt)}</dd>
                <dt>{tr("settings.commandline.expires")}</dt>
                <dd>{token.expiresAt === null ? tr("settings.commandline.never") : when(token.expiresAt)}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function CreateToken({ state, withReauth, onCreated }: { state: CliAccessState; withReauth: WithReauth; onCreated: () => Promise<void> }) {
  const spaces = useSpaces();
  const current = activeSpace(spaces);
  const [label, setLabel] = useState("");
  const [profile, setProfile] = useState<CliProfile>("read");
  const [expiry, setExpiry] = useState("365");
  const [pinSpace, setPinSpace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const expiresInDays = EXPIRY_OPTIONS.find(([id]) => id === expiry)?.[1] ?? null;

  const create = async () => {
    if (!label.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await withReauth(() => createCliToken({
        label: label.trim(),
        profile,
        spaceId: pinSpace && current ? current.id : null,
        expiresInDays,
      }));
      setCreated(result.token);
      setCopied(false);
      setLabel("");
      await onCreated();
    } catch (cause) {
      if (!isReauthCancelled(cause)) setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created);
      setCopied(true);
    } catch {
      setError(tr("settings.commandline.copyFailed"));
    }
  };

  const example = created
    ? `export POLYTH_URL=${window.location.origin}\nexport POLYTH_TOKEN=${created}\npolyth events --type turn.finished`
    : "";
  const levels = state.profiles;

  return (
    <Section title={tr("settings.commandline.createTitle")} hint={tr("settings.commandline.createHint")}>
      {created && (
        <div className="cli-created" role="status">
          <Notice tone="warning">{tr("settings.commandline.shownOnce")}</Notice>
          <div className="cli-secret-row">
            <TextInput className="cli-secret" readOnly value={created} aria-label={tr("settings.commandline.tokenLabel")} onFocus={(event) => event.currentTarget.select()} />
            <Button variant="quiet" onClick={() => void copy()}>{copied ? tr("settings.commandline.copied") : tr("settings.commandline.copy")}</Button>
          </div>
          <p className="cli-example-label">{tr("settings.commandline.exampleLabel")}</p>
          <pre className="cli-example"><code>{example}</code></pre>
          <Button variant="ghost" onClick={() => { setCreated(null); setCopied(false); }}>{tr("settings.commandline.done")}</Button>
        </div>
      )}
      {!created && (
        <form className="cli-create-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <FormField label={tr("settings.commandline.nameLabel")} hint={tr("settings.commandline.nameHint")}>
            <TextInput value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} />
          </FormField>
          <Row
            layout="stacked"
            label={tr("settings.commandline.access")}
            hint={profile === "control" || (levels.control?.length ?? 0) === 0 ? tr("settings.commandline.profileControlHint") : tr("settings.commandline.profileReadHint")}
          >
            <Seg<CliProfile>
              label={tr("settings.commandline.access")}
              value={profile}
              options={[["read", tr("settings.commandline.profileRead")], ["control", tr("settings.commandline.profileControl")]]}
              onChange={setProfile}
            />
          </Row>
          <Row layout="stacked" label={tr("settings.commandline.expiryLabel")}>
            <Seg<string>
              label={tr("settings.commandline.expiryLabel")}
              value={expiry}
              options={EXPIRY_OPTIONS.map(([id, , text]) => [id, text])}
              onChange={setExpiry}
            />
          </Row>
          {expiry === "never" && <Notice tone="warning">{tr("settings.commandline.neverCaution")}</Notice>}
          {current && (
            <Row
              label={tr("settings.commandline.pinSpace", { name: current.name })}
              hint={tr("settings.commandline.pinSpaceHint")}
            >
              <Switch checked={pinSpace} onChange={setPinSpace} label={tr("settings.commandline.pinSpace", { name: current.name })} />
            </Row>
          )}
          {error && <Notice tone="error" role="alert">{error}</Notice>}
          <div className="cli-actions">
            <Button type="submit" variant="primary" busy={busy} disabled={!label.trim()}>{tr("settings.commandline.createButton")}</Button>
          </div>
        </form>
      )}
      {created && error && <Notice tone="error" role="alert">{error}</Notice>}
    </Section>
  );
}

function TrustMode({ state, withReauth, onChanged }: { state: CliAccessState; withReauth: WithReauth; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mode = state.trust.mode;

  const change = async (next: CliTrustMode) => {
    if (next === mode || busy) return;
    setBusy(true);
    setError(null);
    try {
      await withReauth(() => setCliTrust(next, state.trust.revision));
    } catch (cause) {
      if (!isReauthCancelled(cause)) setError(errorText(cause));
    } finally {
      setBusy(false);
      await onChanged();
    }
  };

  return (
    <Section title={tr("settings.commandline.trustTitle")} hint={tr("settings.commandline.trustHint")}>
      <Notice tone="warning">{tr("settings.commandline.trustCaution")}</Notice>
      <fieldset className="cli-trust" disabled={busy}>
        <legend><VisuallyHidden>{tr("settings.commandline.trustTitle")}</VisuallyHidden></legend>
        {TRUST_OPTIONS.map(([id, text, hint]) => (
          <label key={id} className={`cli-trust-option${mode === id ? " is-selected" : ""}`}>
            <input type="radio" name="cli-trust-mode" value={id} checked={mode === id} onChange={() => void change(id)} />
            <span className="cli-trust-text">
              <span className="cli-trust-label">{text}</span>
              <span className="cli-trust-hint">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {error && <Notice tone="error" role="alert">{error}</Notice>}
    </Section>
  );
}

function GetCli() {
  return (
    <Section title={tr("settings.commandline.getTitle")}>
      <ul className="cli-help">
        <li>{tr("settings.commandline.getDesktop")}</li>
        <li>{tr("settings.commandline.getServer")} <code>node packages/cli/bin/polyth.mjs</code> · <code>npm link</code></li>
        <li>{tr("settings.commandline.getDocs")} <code>docs/dev/cli.md</code></li>
      </ul>
    </Section>
  );
}
