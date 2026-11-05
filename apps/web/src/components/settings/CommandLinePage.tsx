import { useCallback, useEffect, useRef, useState } from "react";
import {
  APPROVAL_GRANT, accessLevel, createCliToken, decideCliDevice, isCompleteUserCode, loadCliAccess, lookupCliDevice,
  normalizeUserCode, revokeCliToken, setCliTrust,
  type CliAccessState, type CliDeviceRequest, type CliProfile, type CliTokenSummary, type CliTrustMode,
} from "../../cliAccess.ts";
import { getLocale, tr } from "../../i18n/index.ts";
import { takeBootSettingsCode } from "../../router.ts";
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

/** A waiting program polls every few seconds; a slow one simply shows up later. */
const LIST_RECHECK_MS = [1500, 3500, 6500, 12000];

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
  const remembered = takeBootSettingsCode();
  if (remembered) return normalizeUserCode(remembered);
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  const raw = url.searchParams.get("code");
  if (raw === null) return "";
  url.searchParams.delete("code");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return normalizeUserCode(raw);
}

/** The access list and how to reload it, shared by Command line and Apps. */
export function useCliAccess() {
  const [state, setState] = useState<CliAccessState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setState(await loadCliAccess());
      setLoadError(null);
    } catch (cause) {
      setLoadError(errorText(cause));
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { state, loadError, refresh };
}

export default function CommandLinePage() {
  const { state, loadError, refresh } = useCliAccess();
  const { withReauth, prompt } = useOwnerReauth();

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
      {state.readOnly
        ? <Notice tone="info">{tr("settings.commandline.manageInBrowser")}</Notice>
        : <DeviceConfirm withReauth={withReauth} onDone={refresh} />}
      <TokenList tokens={state.tokens.filter((token) => token.kind !== "app")} readOnly={state.readOnly} onChanged={refresh} />
      {!state.readOnly && <CreateToken state={state} withReauth={withReauth} onCreated={refresh} />}
      {state.canManageTrust && <TrustMode state={state} withReauth={withReauth} onChanged={refresh} />}
      <GetCli />
      {prompt}
    </div>
  );
}

export type WithReauth = ReturnType<typeof useOwnerReauth>["withReauth"];

/** Wording of the sign-in confirmation; the Apps page brings its own. */
export interface DeviceConfirmCopy {
  title: string;
  hint: string;
  codeLabel: string;
  codeUnknown: string;
  approved: string;
}

const terminalConfirmCopy = (): DeviceConfirmCopy => ({
  title: tr("settings.commandline.confirmTitle"),
  hint: tr("settings.commandline.confirmHint"),
  codeLabel: tr("settings.commandline.codeLabel"),
  codeUnknown: tr("settings.commandline.codeUnknown"),
  approved: tr("settings.commandline.approved"),
});

export function DeviceConfirm({ withReauth, onDone, copy = terminalConfirmCopy() }: {
  withReauth: WithReauth;
  onDone: () => Promise<void>;
  copy?: DeviceConfirmCopy;
}) {
  const [code, setCode] = useState(takeCodeFromUrl);
  const [request, setRequest] = useState<CliDeviceRequest | null>(null);
  const [busy, setBusy] = useState<"lookup" | "approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"approved" | "denied" | null>(null);
  // Off for every request: approving an app never implies this.
  const [allowApprovals, setAllowApprovals] = useState(false);
  const autoLooked = useRef(false);
  const isApp = request?.kind === "app";
  const asksApprovals = isApp && request?.asksOwnerGrants === true;
  const canAllowApprovals = asksApprovals && request?.canAllowOwnerGrants === true;

  const { codeUnknown } = copy;
  const failureText = useCallback((cause: unknown): string =>
    (cause as { code?: unknown } | null)?.code === "not-found" ? codeUnknown : errorText(cause), [codeUnknown]);

  const lookup = useCallback(async (value: string) => {
    if (!isCompleteUserCode(value)) return;
    setBusy("lookup");
    setError(null);
    setDone(null);
    setAllowApprovals(false);
    try {
      setRequest(await lookupCliDevice(value));
    } catch (cause) {
      setRequest(null);
      setError(failureText(cause));
    } finally {
      setBusy(null);
    }
  }, [failureText]);

  useEffect(() => {
    if (autoLooked.current || !isCompleteUserCode(code)) return;
    autoLooked.current = true;
    void lookup(code);
  }, [code, lookup]);

  // The token exists only once the waiting program collects it, a few seconds
  // after this approval, so keep reading the list until it has had the time.
  useEffect(() => {
    if (done !== "approved") return;
    const timers = LIST_RECHECK_MS.map((ms) => setTimeout(() => { void onDone(); }, ms));
    return () => { for (const timer of timers) clearTimeout(timer); };
  }, [done, onDone]);

  const decide = async (approve: boolean) => {
    if (!request) return;
    setBusy(approve ? "approve" : "deny");
    setError(null);
    try {
      await withReauth(() => decideCliDevice(request.userCode, approve, approve && canAllowApprovals && allowApprovals));
      setDone(approve ? "approved" : "denied");
      setRequest(null);
      setCode("");
      await onDone();
    } catch (cause) {
      if (!isReauthCancelled(cause)) setError(failureText(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title={copy.title} hint={copy.hint}>
      <form
        className="cli-code-form"
        onSubmit={(event) => { event.preventDefault(); void lookup(code); }}
      >
        <FormField label={copy.codeLabel}>
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
      {done === "approved" && <Notice tone="success" role="status">{copy.approved}</Notice>}
      {done === "denied" && <Notice tone="info" role="status">{tr("settings.commandline.denied")}</Notice>}
      {request && (
        <div className="cli-request" role="group" aria-label={tr("settings.commandline.requestLabel")}>
          <dl className="cli-facts">
            <dt>{isApp ? tr("settings.apps.appName") : tr("settings.commandline.deviceName")}</dt><dd>{request.label}</dd>
            <dt>{tr("settings.commandline.access")}</dt><dd>{accessText(accessLevel(request.grants))}</dd>
            <dt>{tr("settings.commandline.address")}</dt><dd>{request.clientAddress ?? tr("settings.commandline.unknown")}</dd>
            <dt>{tr("settings.commandline.codeExpires")}</dt><dd>{when(request.expiresAt)}</dd>
          </dl>
          <Notice tone="warning">{isApp ? tr("settings.apps.confirmWarning") : tr("settings.commandline.confirmWarning")}</Notice>
          {canAllowApprovals && (
            <ApprovalSwitch checked={allowApprovals} onChange={setAllowApprovals} />
          )}
          {asksApprovals && !canAllowApprovals && <Notice tone="info">{tr("settings.apps.ownerOnly")}</Notice>}
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

/** The owner's yes to one app answering agents: off until they turn it on, and
 *  the consequence stays in view for as long as it is on. */
function ApprovalSwitch({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <>
      <Row label={tr("settings.apps.allowApprovals")} hint={tr("settings.apps.allowApprovalsHint")}>
        <Switch checked={checked} onChange={onChange} label={tr("settings.apps.allowApprovals")} />
      </Row>
      {checked && <Notice tone="warning">{tr("settings.apps.approvalsCaution")}</Notice>}
    </>
  );
}

/** Wording of the access list; the Apps page brings its own. */
export interface TokenListCopy {
  title: string;
  empty: string;
  emptyBody: string;
}

export function TokenList({ tokens, readOnly, onChanged, copy }: {
  tokens: CliTokenSummary[];
  readOnly: boolean;
  onChanged: () => Promise<void>;
  copy?: TokenListCopy;
}) {
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
    <Section title={copy?.title ?? tr("settings.commandline.listTitle")}>
      {error && <Notice tone="error" role="alert">{error}</Notice>}
      {tokens.length === 0 ? (
        <EmptyState compact icon={copy ? "plugin" : "terminal"} title={copy?.empty ?? tr("settings.commandline.empty")} body={copy?.emptyBody ?? tr("settings.commandline.emptyBody")} />
      ) : (
        <ul className="cli-tokens">
          {tokens.map((token) => (
            <li key={token.id} className="cli-token">
              <div className="cli-token-head">
                <strong className="cli-token-name">{token.label}</strong>
                {token.kind !== "app" && (
                  <Badge tone={token.kind === "device" ? "info" : "neutral"}>
                    {token.kind === "device" ? tr("settings.commandline.kindTerminal") : tr("settings.commandline.kindAutomation")}
                  </Badge>
                )}
                {token.grants.includes(APPROVAL_GRANT) && <Badge tone="warning">{tr("settings.apps.canApprove")}</Badge>}
                {!readOnly && (
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
                )}
              </div>
              <dl className="cli-facts">
                <dt>{tr("settings.commandline.access")}</dt><dd>{token.grants.includes(APPROVAL_GRANT) ? tr("settings.apps.accessApprove") : accessText(accessLevel(token.grants))}</dd>
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

export function CreateToken({ state, withReauth, onCreated, app = false }: {
  state: CliAccessState;
  withReauth: WithReauth;
  onCreated: () => Promise<void>;
  /** Creates an app's token: other wording, and the owner's approval switch. */
  app?: boolean;
}) {
  const spaces = useSpaces();
  const current = activeSpace(spaces);
  const [label, setLabel] = useState("");
  const [profile, setProfile] = useState<CliProfile>("read");
  const [expiry, setExpiry] = useState("365");
  const [pinSpace, setPinSpace] = useState(false);
  const [allowApprovals, setAllowApprovals] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const expiresInDays = EXPIRY_OPTIONS.find(([id]) => id === expiry)?.[1] ?? null;
  // The instance owner alone may give an app this; `canManageTrust` is that test.
  const approves = app && profile === "control" && state.canManageTrust && allowApprovals;

  const create = async () => {
    if (!label.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await withReauth(() => createCliToken({
        ...(app ? { kind: "app" as const } : {}),
        label: label.trim(),
        profile: approves ? "approve" : profile,
        spaceId: pinSpace && current ? current.id : null,
        expiresInDays,
      }));
      setCreated(result.token);
      setCopied(false);
      setLabel("");
      setAllowApprovals(false);
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

  const example = !created ? ""
    : app ? `curl -H "Authorization: Bearer ${created}" ${window.location.origin}/api/v1/me`
    : `export POLYTH_URL=${window.location.origin}\nexport POLYTH_TOKEN=${created}\npolyth events --type turn.finished`;
  const levels = state.profiles;

  return (
    <Section
      title={app ? tr("settings.apps.createTitle") : tr("settings.commandline.createTitle")}
      hint={app ? tr("settings.apps.createHint") : tr("settings.commandline.createHint")}
    >
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
          <FormField label={tr("settings.commandline.nameLabel")} hint={app ? tr("settings.apps.nameHint") : tr("settings.commandline.nameHint")}>
            <TextInput value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} />
          </FormField>
          <Row
            layout="stacked"
            label={tr("settings.commandline.access")}
            hint={profile === "control" || (levels.control?.length ?? 0) === 0
              ? (app ? tr("settings.apps.profileControlHint") : tr("settings.commandline.profileControlHint"))
              : tr("settings.commandline.profileReadHint")}
          >
            <Seg<CliProfile>
              label={tr("settings.commandline.access")}
              value={profile}
              options={[["read", tr("settings.commandline.profileRead")], ["control", tr("settings.commandline.profileControl")]]}
              onChange={setProfile}
            />
          </Row>
          {app && profile === "control" && state.canManageTrust && (
            <ApprovalSwitch checked={allowApprovals} onChange={setAllowApprovals} />
          )}
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
