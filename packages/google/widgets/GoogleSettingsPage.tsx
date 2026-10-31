import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { createApiTransport, type SettingsNavigationTarget, type WebPackageHost } from "@polyth/web-sdk";
import { EmptyState, ErrorState, FormField, PageHead, Row, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import { Badge, Button, ExternalLinkIcon, Notice, Switch, TextInput, UploadIcon } from "../../../apps/web/src/components/ui/index.ts";
import type { GoogleAccountDto, GoogleClientConfigDto, GoogleServiceAccountLabelDto } from "../src/accounts.ts";
import type { GoogleMessageKey } from "../src/i18n/en.ts";
import type { OAuthFlowOwner, OAuthFlowView } from "../src/oauth.ts";
import type { GoogleCapability, GoogleService } from "../src/scopes.ts";
import { createTranslate, type Translate } from "./i18n.ts";

interface Snapshot {
  client: GoogleClientConfigDto;
  /** The signed-in person's own accounts, with `enabled` for this Space. */
  accounts: GoogleAccountDto[];
  /** Space service accounts: full for admins, a label for everyone else. */
  service: Array<GoogleAccountDto | GoogleServiceAccountLabelDto>;
  policy: { agentsMayUseService: boolean };
  canManage: boolean;
}

interface Envelope<T> { ok: boolean; data: T }

interface AccessLevel { capabilities: GoogleCapability[]; badge: GoogleMessageKey; hint: GoogleMessageKey }

interface ConnectRequest { capabilities: GoogleCapability[]; accountId?: string; owner: OAuthFlowOwner }

/** Access levels per service, strongest first. */
const SERVICES: ReadonlyArray<{ id: GoogleService; label: GoogleMessageKey; levels: AccessLevel[] }> = [
  { id: "gmail", label: "google.service.gmail.label", levels: [
    { capabilities: ["gmail.read", "gmail.write"], badge: "google.level.readWrite", hint: "google.gmail.readWriteHint" },
    { capabilities: ["gmail.read"], badge: "google.level.readOnly", hint: "google.gmail.readHint" },
    { capabilities: ["gmail.send"], badge: "google.level.sendOnly", hint: "google.gmail.sendHint" },
  ] },
  { id: "calendar", label: "google.service.calendar.label", levels: [
    { capabilities: ["calendar.read", "calendar.write"], badge: "google.level.readWrite", hint: "google.calendar.readWriteHint" },
    { capabilities: ["calendar.read"], badge: "google.level.readOnly", hint: "google.calendar.readHint" },
  ] },
  { id: "drive", label: "google.service.drive.label", levels: [
    { capabilities: ["drive.read", "drive.write"], badge: "google.level.readWrite", hint: "google.drive.readWriteHint" },
    { capabilities: ["drive.read"], badge: "google.level.readOnly", hint: "google.drive.readHint" },
    { capabilities: ["drive.file"], badge: "google.level.polythFiles", hint: "google.drive.filesHint" },
  ] },
];

/** Google Cloud pages for the one-time setup, in order. */
const SETUP_LINKS = {
  project: "https://console.cloud.google.com/projectcreate",
  apis: "https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com",
  consent: "https://console.cloud.google.com/auth/overview",
  client: "https://console.cloud.google.com/auth/clients",
} as const;

const ADVANCED_ITEMS = new Set(["google.client", "google.service"]);

const isFullAccount = (account: GoogleAccountDto | GoogleServiceAccountLabelDto): account is GoogleAccountDto => "id" in account;

const covers = (held: readonly GoogleCapability[], level: AccessLevel): boolean => level.capabilities.every((capability) => held.includes(capability));

/** The loopback redirect reaches the server only when this browser runs on it. */
const onServerMachine = (): boolean => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);

/** A redirect address Google produced: it carries the sign-in's state and a code or an error. */
const looksLikeRedirect = (text: string): boolean => {
  try {
    const url = new URL(text.trim());
    return url.searchParams.has("state") && (url.searchParams.has("code") || url.searchParams.has("error"));
  } catch {
    return false;
  }
};

/** The file Google offers on a client's page: `{ installed: { client_id, client_secret, … } }`. */
export function clientFromGoogleFile(text: string, t: Translate): { clientId: string; clientSecret: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(t("google.setup.fileNotJson"));
  }
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  if (record.web && !record.installed) throw new Error(t("google.setup.fileWebClient"));
  const installed = record.installed && typeof record.installed === "object" ? record.installed as Record<string, unknown> : {};
  if (typeof installed.client_id !== "string" || typeof installed.client_secret !== "string" || !installed.client_secret) {
    throw new Error(t("google.setup.fileNotJson"));
  }
  return { clientId: installed.client_id, clientSecret: installed.client_secret };
}

export default function GoogleSettingsPage({ host, settingsTarget }: { host: WebPackageHost; settingsTarget?: SettingsNavigationTarget }) {
  const t = useMemo(() => createTranslate(host), [host]);
  const api = useMemo(() => createApiTransport(), []);
  const mounted = useRef(true);
  const lastRequest = useRef<ConnectRequest | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [flow, setFlow] = useState<OAuthFlowView | null>(null);
  const [pasted, setPasted] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [editingClient, setEditingClient] = useState(false);
  const [advanced, setAdvanced] = useState(() => ADVANCED_ITEMS.has(settingsTarget?.itemId ?? ""));
  // A search hit on a row behind Advanced opens it in the same render, so the
  // row is mounted by the time the host scrolls to it.
  const [seenTarget, setSeenTarget] = useState(settingsTarget);
  if (settingsTarget !== seenTarget) {
    setSeenTarget(settingsTarget);
    if (ADVANCED_ITEMS.has(settingsTarget?.itemId ?? "")) setAdvanced(true);
  }

  const load = async () => {
    try {
      const result = await api.get<Envelope<Snapshot>>("/api/google");
      if (!mounted.current) return;
      setSnapshot(result.data);
      setLoadError(null);
    } catch (cause) {
      if (mounted.current) setLoadError(cause);
    }
  };

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, []);

  // A pending sign-in finishes in another tab or device; follow it until it settles.
  useEffect(() => {
    if (!flow || flow.status !== "pending") return;
    const timer = setInterval(() => {
      void api.get<Envelope<OAuthFlowView>>(`/api/google/connect/${flow.state}`).then((result) => {
        if (!mounted.current || result.data.status === "pending") return;
        setFlow(result.data);
        if (result.data.status === "completed") void load();
      }).catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [flow?.state, flow?.status]);

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error && cause.message ? cause.message : t("google.error.unavailable"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const connect = (request: ConnectRequest) => {
    if (busy) return;
    lastRequest.current = request;
    // Phone browsers only allow a tab opened during the click itself. The
    // desktop app sends window.open to the system browser and returns null.
    const tab = window.open("about:blank", "_blank");
    void run(async () => {
      try {
        const result = await api.post<Envelope<OAuthFlowView>>("/api/google/connect", {
          capabilities: request.capabilities,
          owner: request.owner,
          ...(request.accountId ? { accountId: request.accountId } : {}),
        });
        setPasted("");
        setPasteOpen(false);
        setFlow(result.data);
        if (tab && !tab.closed) {
          tab.opener = null;
          tab.location.href = result.data.url;
        } else {
          window.open(result.data.url, "_blank", "noopener,noreferrer");
        }
      } catch (cause) {
        tab?.close();
        throw cause;
      }
    });
  };

  const finishFromPaste = (address = pasted) => run(async () => {
    if (!flow || !address.trim()) return;
    const result = await api.post<Envelope<OAuthFlowView>>(`/api/google/connect/${flow.state}/complete`, { url: address.trim() });
    setFlow(result.data);
    if (result.data.status === "completed") await load();
  });

  // Pasting the address is the whole step: no separate Finish click needed.
  const onPasteAddress = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!looksLikeRedirect(text)) return;
    event.preventDefault();
    setPasted(text.trim());
    void finishFromPaste(text);
  };

  const pasteFromClipboard = () => void navigator.clipboard.readText().then((text) => {
    setPasted(text.trim());
    if (looksLikeRedirect(text)) void finishFromPaste(text);
  }, () => undefined);

  const closeFlow = () => run(async () => {
    if (!flow) return;
    if (flow.status === "pending") await api.delete(`/api/google/connect/${flow.state}`).catch(() => undefined);
    setFlow(null);
  });

  const disconnect = (account: GoogleAccountDto, owner: OAuthFlowOwner) => run(async () => {
    const where = owner === "person" ? t("google.account.scopeEverywhere") : t("google.account.scopeSpace");
    if (!window.confirm(t("google.account.disconnectConfirm", { email: account.email, where }))) return;
    const path = owner === "person" ? "accounts" : "service-accounts";
    const result = await api.delete<Envelope<{ revoked: boolean }>>(`/api/google/${path}/${encodeURIComponent(account.id)}`);
    if (!result.data.revoked) setError(t("google.account.revokeUnconfirmed", { email: account.email }));
    await load();
  });

  const setEnabled = (account: GoogleAccountDto, enabled: boolean) => run(async () => {
    await api.put(`/api/google/accounts/${encodeURIComponent(account.id)}`, { enabled });
    await load();
  });

  const setPolicy = (agentsMayUseService: boolean) => run(async () => {
    await api.put("/api/google/policy", { agentsMayUseService });
    await load();
  });

  const saveClient = (input: { clientId: string; clientSecret?: string }) => run(async () => {
    await api.put("/api/google/client", { clientId: input.clientId.trim(), ...(input.clientSecret ? { clientSecret: input.clientSecret.trim() } : {}) });
    setEditingClient(false);
    await load();
  });

  const saveClientFile = (file: File) => run(async () => {
    const client = clientFromGoogleFile(await file.text(), t);
    await api.put("/api/google/client", client);
    setEditingClient(false);
    await load();
  });

  const removeClient = () => run(async () => {
    await api.delete("/api/google/client");
    await load();
  });

  if (loadError) return <ErrorState title={t("google.error.unavailableTitle")} error={loadError} onRetry={() => void load()} />;
  if (!snapshot) return <EmptyState title={t("google.loading.accounts")} busy />;
  const { client, accounts, service, policy, canManage } = snapshot;
  const pending = flow?.status === "pending";
  const builtin = client.source === "builtin";
  const signIn = () => connect({ capabilities: client.capabilities, owner: "person" });
  const remote = !onServerMachine();

  return (
    <div className="google-settings">
      <PageHead blurb={t("google.page.blurb")} />

      {flow && (
        <Notice
          tone={flow.status === "completed" ? "success" : flow.status === "pending" ? "info" : "warning"}
          heading={flow.status === "completed" ? t("google.notice.connected", { account: flow.email ?? t("google.notice.accountFallback") }) : flow.status === "pending" ? t("google.notice.waiting") : flow.status === "cancelled" ? t("google.notice.cancelled") : t("google.notice.notCompleted")}
          actions={(
            <>
              {!pending && flow.status !== "completed" && lastRequest.current && (
                <Button size="sm" variant="primary" disabled={busy} onClick={() => connect(lastRequest.current!)}>{t("google.notice.tryAgain")}</Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => void closeFlow()} disabled={busy}>{pending ? t("google.notice.cancel") : t("google.notice.dismiss")}</Button>
            </>
          )}
        >
          {pending ? (
            <div className="google-settings-flow">
              <p>{t("google.notice.pending")} <a href={flow.url} target="_blank" rel="noopener noreferrer">{t("google.notice.openAgain")}</a></p>
              {remote || pasteOpen ? (
                <>
                  <p className="google-settings-muted">{t("google.notice.otherDevice")}</p>
                  <div className="google-settings-paste">
                    <TextInput value={pasted} disabled={busy} aria-label={t("google.notice.pasteAria")} placeholder="http://127.0.0.1:…" onPaste={onPasteAddress} onChange={(event: ChangeEvent<HTMLInputElement>) => setPasted(event.target.value)} />
                    {typeof navigator.clipboard?.readText === "function" && !pasted.trim() && (
                      <Button size="sm" disabled={busy} onClick={pasteFromClipboard}>{t("google.notice.paste")}</Button>
                    )}
                    {pasted.trim() && <Button size="sm" variant="primary" disabled={busy} busy={busy} onClick={() => void finishFromPaste()}>{t("google.notice.finish")}</Button>}
                  </div>
                </>
              ) : (
                <button type="button" className="google-settings-link" onClick={() => setPasteOpen(true)}>{t("google.notice.otherDeviceLink")}</button>
              )}
            </div>
          ) : flow.status === "completed" ? (
            <p>{t("google.notice.completedBody")}</p>
          ) : flow.status === "failed" ? (
            <p>{flow.error?.message ?? t("google.notice.failed")}</p>
          ) : null}
        </Notice>
      )}

      {error && <Notice tone="error">{error}</Notice>}

      <Section
        title={t("google.accounts.title")}
        itemId="google.accounts"
        hint={client.configured ? t("google.accounts.hint") : undefined}
        action={client.configured && accounts.length > 0 ? <Button size="sm" variant="quiet" disabled={busy || pending} onClick={signIn}>{t("google.accounts.addAccount")}</Button> : undefined}
      >
        {!client.configured && (canManage
          ? <SetupGuide t={t} busy={busy} onFile={(file) => void saveClientFile(file)} onSave={(input) => void saveClient(input)} />
          : <EmptyState compact icon="key" title={t("google.accounts.noClientTitle")} body={t("google.accounts.noClientMemberBody")} />)}
        {client.configured && !accounts.length && !pending && (
          <div className="google-signin">
            <Button variant="primary" size="lg" disabled={busy} busy={busy} onClick={signIn}>{t("google.accounts.signIn")}</Button>
            <p className="google-settings-muted">{t("google.accounts.signInHint")}</p>
          </div>
        )}
        {accounts.map((account) => (
          <AccountCard
            key={account.id}
            t={t}
            account={account}
            offered={client.capabilities}
            canChange
            busy={busy}
            pending={pending}
            onConnect={(capabilities) => connect({ capabilities, accountId: account.id, owner: "person" })}
            onDisconnect={() => void disconnect(account, "person")}
          >
            <Row label={t("google.accounts.useInSpace")} hint={account.enabled ? t("google.accounts.useHintOn") : t("google.accounts.useHintOff")}>
              <Switch label={t("google.accounts.useSwitch", { email: account.email })} checked={account.enabled === true} disabled={busy} onChange={(on) => void setEnabled(account, on)} />
            </Row>
          </AccountCard>
        ))}
        {accounts.length > 0 && <p className="google-settings-muted">{t("google.accounts.reduce")}</p>}
      </Section>

      <Section
        title={t("google.advanced.title")}
        itemId="google.client"
        hint={t("google.advanced.hint")}
        action={<Button size="sm" variant="ghost" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? t("google.advanced.hide") : t("google.advanced.show")}</Button>}
      >
        {advanced && client.configured && !editingClient && (
          <Row
            label={t("google.advanced.appLabel")}
            hint={builtin ? t("google.advanced.hintBundled") : client.source === "environment" ? t("google.advanced.clientIdEnvHint") : client.hasSecret ? t("google.advanced.appOwn") : t("google.advanced.appNoSecret")}
          >
            {builtin
              ? <span className="set-row-value">Polyth</span>
              : <span className="set-row-value is-mono google-settings-client" title={client.clientId}>{client.clientId?.replace(/\.apps\.googleusercontent\.com$/, "")}</span>}
            {canManage && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditingClient(true)}>{builtin ? t("google.advanced.useOwn") : t("google.advanced.change")}</Button>}
            {canManage && client.source === "space" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void removeClient()}>{t("google.advanced.remove")}</Button>}
          </Row>
        )}
        {advanced && client.configured && editingClient && canManage && (
          <ClientForm
            t={t}
            busy={busy}
            initialId={client.source === "space" ? client.clientId ?? "" : ""}
            keepsSecret={client.source === "space" && client.hasSecret}
            onFile={(file) => void saveClientFile(file)}
            onSave={(input) => void saveClient(input)}
            onCancel={() => setEditingClient(false)}
          />
        )}
      </Section>

      {advanced && (canManage || service.length > 0) && (
        <Section
          title={t("google.service.title")}
          itemId="google.service"
          hint={canManage ? t("google.service.hintAdmin") : t("google.service.hintMember")}
          action={canManage && client.configured ? <Button size="sm" variant="quiet" disabled={busy || pending} onClick={() => connect({ capabilities: client.capabilities, owner: "space" })}>{t("google.service.connect")}</Button> : undefined}
        >
          <Row label={t("google.service.agentsMayUse")} hint={service.length ? undefined : t("google.service.noAccount")}>
            {canManage
              ? <Switch label={t("google.service.agentsMayUse")} checked={policy.agentsMayUseService} disabled={busy} onChange={(on) => void setPolicy(on)} />
              : <Badge tone={policy.agentsMayUseService ? "success" : "neutral"}>{policy.agentsMayUseService ? t("google.service.allowed") : t("google.service.notAllowed")}</Badge>}
          </Row>
          {service.map((account, index) => isFullAccount(account) ? (
            <AccountCard
              key={account.id}
              t={t}
              account={account}
              offered={client.capabilities}
              canChange={canManage}
              busy={busy}
              pending={pending}
              onConnect={(capabilities) => connect({ capabilities, accountId: account.id, owner: "space" })}
              onDisconnect={() => void disconnect(account, "space")}
            />
          ) : (
            <AccountCard key={`label-${index}`} t={t} account={account} offered={client.capabilities} canChange={false} busy={busy} pending={pending} />
          ))}
        </Section>
      )}
    </div>
  );
}

/** A file picker that also accepts a dropped file. */
function FilePick({ t, busy, onFile }: { t: Translate; busy: boolean; onFile: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const take = (file: File | undefined) => { if (file) onFile(file); };
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event: ChangeEvent<HTMLInputElement>) => { take(event.target.files?.[0]); event.target.value = ""; }}
      />
      <Button
        variant="primary"
        iconStart={UploadIcon}
        disabled={busy}
        busy={busy}
        onClick={() => input.current?.click()}
        onDragOver={(event: DragEvent<HTMLButtonElement>) => event.preventDefault()}
        onDrop={(event: DragEvent<HTMLButtonElement>) => { event.preventDefault(); take(event.dataTransfer.files[0]); }}
      >
        {t("google.setup.chooseFile")}
      </Button>
    </>
  );
}

/** One-time setup for a Space admin when no Google app is available: four
 *  Google Cloud pages, then the file Google gives for the client. */
function SetupGuide({ t, busy, onFile, onSave }: {
  t: Translate;
  busy: boolean;
  onFile: (file: File) => void;
  onSave: (input: { clientId: string; clientSecret: string }) => void;
}) {
  const [typing, setTyping] = useState(false);
  const steps: Array<{ text: string; action?: { href: string; label: string } }> = [
    { text: t("google.setup.step1"), action: { href: SETUP_LINKS.project, label: t("google.setup.step1Action") } },
    { text: t("google.setup.step2"), action: { href: SETUP_LINKS.apis, label: t("google.setup.step2Action") } },
    { text: t("google.setup.step3"), action: { href: SETUP_LINKS.consent, label: t("google.setup.step3Action") } },
    { text: t("google.setup.step4"), action: { href: SETUP_LINKS.client, label: t("google.setup.step4Action") } },
  ];
  return (
    <div className="google-setup">
      <div className="google-setup-head">
        <strong>{t("google.setup.title")}</strong>
        <p className="google-settings-muted">{t("google.setup.intro")}</p>
      </div>
      <ol className="google-setup-steps">
        {steps.map((step, index) => (
          <li key={index} className="google-setup-step">
            <span className="google-setup-number" aria-hidden="true">{index + 1}</span>
            <span className="google-setup-text">{step.text}</span>
            {step.action && (
              <a className="google-setup-action" href={step.action.href} target="_blank" rel="noopener noreferrer">
                {step.action.label}<ExternalLinkIcon size={14} aria-hidden="true" />
              </a>
            )}
          </li>
        ))}
        <li className="google-setup-step is-final">
          <span className="google-setup-number" aria-hidden="true">{steps.length + 1}</span>
          <span className="google-setup-text">{t("google.setup.step5")}</span>
          <span className="google-setup-file"><FilePick t={t} busy={busy} onFile={onFile} /></span>
        </li>
      </ol>
      {typing
        ? <ClientForm t={t} busy={busy} initialId="" keepsSecret={false} onSave={onSave} onCancel={() => setTyping(false)} />
        : <button type="button" className="google-settings-link" onClick={() => setTyping(true)}>{t("google.setup.typeInstead")}</button>}
    </div>
  );
}

function ClientForm({ t, busy, initialId, keepsSecret, onFile, onSave, onCancel }: {
  t: Translate;
  busy: boolean;
  initialId: string;
  /** The same client already has a saved secret, so the field may stay empty. */
  keepsSecret: boolean;
  onFile?: (file: File) => void;
  onSave: (input: { clientId: string; clientSecret: string }) => void;
  onCancel: () => void;
}) {
  const [clientId, setClientId] = useState(initialId);
  const [clientSecret, setClientSecret] = useState("");
  const secretNeeded = !(keepsSecret && clientId.trim() === initialId);
  return (
    <form className="google-settings-client-form" onSubmit={(event) => { event.preventDefault(); onSave({ clientId, clientSecret }); }}>
      {onFile && <div className="google-settings-actions"><FilePick t={t} busy={busy} onFile={onFile} /></div>}
      <FormField label={t("google.advanced.clientId")} hint={t("google.advanced.clientIdHint")}>
        <TextInput value={clientId} required disabled={busy} autoComplete="off" spellCheck={false} onChange={(event: ChangeEvent<HTMLInputElement>) => setClientId(event.target.value)} />
      </FormField>
      <FormField label={t("google.advanced.clientSecret")} hint={secretNeeded ? t("google.advanced.clientSecretNewHint") : t("google.advanced.clientSecretKeepHint")}>
        <TextInput type="password" value={clientSecret} required={secretNeeded} disabled={busy} autoComplete="off" onChange={(event: ChangeEvent<HTMLInputElement>) => setClientSecret(event.target.value)} />
      </FormField>
      <div className="google-settings-actions">
        <Button type="submit" size="sm" variant={onFile ? "quiet" : "primary"} disabled={busy || !clientId.trim() || (secretNeeded && !clientSecret.trim())} busy={busy}>{t("google.advanced.saveClient")}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{t("google.notice.cancel")}</Button>
      </div>
    </form>
  );
}

/** One account and its per-service access. A service account seen by a member
 *  is a label only. `offered` is what the Space's client may ask Google for. */
function AccountCard({ t, account, offered, canChange, busy, pending, onConnect, onDisconnect, children }: {
  t: Translate;
  account: GoogleAccountDto | GoogleServiceAccountLabelDto;
  offered: readonly GoogleCapability[];
  canChange: boolean;
  busy: boolean;
  pending: boolean;
  onConnect?: (capabilities: GoogleCapability[]) => void;
  onDisconnect?: () => void;
  children?: ReactNode;
}) {
  const full = isFullAccount(account) ? account : undefined;
  const title = isFullAccount(account) ? account.name ?? account.email : account.label;
  const reconnect = account.status === "reauthorization-required";
  const manage = canChange && Boolean(full);
  return (
    <div className="google-account">
      <Row
        label={<span className="google-account-name">{full?.picture && <img src={full.picture} alt="" referrerPolicy="no-referrer" />}{title}</span>}
        hint={reconnect ? `${full?.name ? `${full.email}. ` : ""}${t("google.account.reconnectHint")}` : full?.name ? full.email : undefined}
      >
        {reconnect && <Badge tone="warning" dot>{t("google.account.reconnectNeeded")}</Badge>}
        {reconnect && manage && <Button size="sm" variant="primary" disabled={busy || pending} onClick={() => onConnect?.([])}>{t("google.account.reconnect")}</Button>}
        {manage && <Button size="sm" variant="danger" disabled={busy} onClick={onDisconnect}>{t("google.account.disconnect")}</Button>}
      </Row>
      {children}
      {SERVICES.map((service) => {
        const current = service.levels.find((level) => covers(account.capabilities, level));
        // The strongest access this client may ask for.
        const offer = service.levels.find((level) => covers(offered, level));
        return (
          <Row key={service.id} label={t(service.label)} hint={current ? t(current.hint) : undefined}>
            <Badge tone={current ? "success" : "neutral"}>{current ? t(current.badge) : t("google.service.notAllowed")}</Badge>
            {manage && offer && !covers(account.capabilities, offer) && (
              <Button size="sm" disabled={busy || pending} onClick={() => onConnect?.(offer.capabilities)}>{current ? t("google.account.allowMore") : t("google.account.allow")}</Button>
            )}
          </Row>
        );
      })}
    </div>
  );
}
