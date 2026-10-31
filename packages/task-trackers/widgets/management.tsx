import { useId, useState, type ReactNode } from "react";
import type { TaskTrackerProvider, TaskTrackerProviderDto } from "@polyth/contracts";
import {
  Badge,
  Button,
  Notice,
  Skeleton,
  Switch,
} from "../../../apps/web/src/components/ui/index.ts";
import { api } from "./api.ts";
import {
  AccountAvatar,
  connectCopy,
  PROVIDER_LABELS,
  ProviderMark,
  providerBlurb,
  providerState,
  relativeTime,
  stateLabel,
  STATE_TONES,
} from "./brand.tsx";
import { tt } from "./i18n.ts";
import { ConnectWizard } from "./connect.tsx";
import { applyManagement, friendly, loadManagement, updatePreferences, useManagement } from "./store.ts";
import {
  TASK_TRACKER_PROVIDERS,
  type TaskTrackerConnectionDto,
  type TaskTrackerConnectionScope,
  type TaskTrackerPersonalConnectionDto,
  type TaskTrackerPreferences,
  type TaskTrackerWidgetId,
} from "../src/types.ts";

const WIDGET_KEYS = {
  "task-trackers.board": { title: "tasktrackers.widget.board.title", body: "tasktrackers.widget.board.body" },
  "task-trackers.linked-task": { title: "tasktrackers.widget.linked.title", body: "tasktrackers.widget.linked.body" },
  "task-trackers.overview": { title: "tasktrackers.widget.overview.title", body: "tasktrackers.widget.overview.body" },
} as const;

export function widgetCopy(id: TaskTrackerWidgetId): { title: string; body: string } {
  const keys = WIDGET_KEYS[id];
  return { title: tt(keys.title), body: tt(keys.body) };
}

export const WIDGET_IDS = Object.keys(WIDGET_KEYS) as TaskTrackerWidgetId[];

const FEATURE_KEYS = [
  {
    key: "agentHandoff" as const,
    title: "tasktrackers.feature.agentHandoff.title",
    body: "tasktrackers.feature.agentHandoff.body",
  },
  {
    key: "statusUpdates" as const,
    title: "tasktrackers.feature.statusUpdates.title",
    body: "tasktrackers.feature.statusUpdates.body",
  },
  {
    key: "demo" as const,
    title: "tasktrackers.feature.demo.title",
    body: "tasktrackers.feature.demo.body",
  },
] as const;

export function SettingRow({
  title,
  body,
  checked,
  disabled,
  onChange,
  children,
}: {
  title: string;
  body: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={`tt-setting-row${checked ? "" : " off"}`}>
      {children}
      <span className="tt-setting-copy">
        <strong id={id}>{title}</strong>
        <small>{body}</small>
      </span>
      <Switch checked={checked} disabled={disabled} labelledBy={id} onChange={onChange} />
    </div>
  );
}

/** Older servers send neither field: their personal account was always on here. */
const isOn = (item: TaskTrackerPersonalConnectionDto): boolean => item.enabled !== false;

/**
 * The caller's own accounts for one service. They belong to the person, not
 * the Space, and act here only while turned on here; agents use them only on
 * turns this person started.
 */
function PersonalAccount({
  provider,
  connections,
  emphasize,
  available,
  onConnect,
}: {
  provider: TaskTrackerProvider;
  /** Every account of this service the caller owns, across Spaces. */
  connections: TaskTrackerPersonalConnectionDto[];
  /** Primary only when it is the caller's one way to connect. */
  emphasize: boolean;
  available: boolean;
  onConnect: (provider: TaskTrackerProvider, scope: TaskTrackerConnectionScope) => void;
}) {
  const [busy, setBusy] = useState<"verify" | "disconnect" | "toggle" | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const active = connections.find(isOn);
  const primary = active ?? connections[0];
  const run = async (kind: "verify" | "disconnect") => {
    setBusy(kind);
    setMessage(null);
    try {
      applyManagement(kind === "verify"
        ? await api.taskTrackerVerifyConnection(provider, "personal", primary?.id)
        : await api.taskTrackerDisconnect(provider, "personal", primary?.id));
      if (kind === "verify") setMessage({ tone: "success", text: tt("tasktrackers.manage.yourAccountWorks") });
    } catch (cause) {
      setMessage({ tone: "error", text: friendly(kind === "verify" ? tt("tasktrackers.manage.providerNoResponse", { provider: PROVIDER_LABELS[provider] }) : tt("tasktrackers.manage.couldNotDisconnect"), cause) });
    } finally {
      setBusy(null);
    }
  };
  const toggle = async (connection: TaskTrackerPersonalConnectionDto, enabled: boolean) => {
    if (!connection.id) return;
    setBusy("toggle");
    setMessage(null);
    try {
      applyManagement(await api.taskTrackerSetPersonalEnabled(connection.id, enabled));
    } catch (cause) {
      setMessage({ tone: "error", text: friendly(tt("tasktrackers.manage.couldNotChangeUse"), cause) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="tt-personal">
      <span className="tt-personal-label">{tt("tasktrackers.manage.yourAccount")}</span>
      {connections.length > 0 ? connections.map((connection) => (
        <div className={`tt-account-row${isOn(connection) ? "" : " off"}`} key={connection.id ?? connection.provider}>
          <AccountAvatar account={connection.account} />
          <span>
            <strong>{connection.account.name}</strong>
            <small>{isOn(connection)
              ? tt("tasktrackers.manage.changesAsYou")
              : tt("tasktrackers.manage.offInSpace", { site: connection.account.site ? ` · ${connection.account.site}` : "" })}</small>
          </span>
          {connection.id && connection.enabled !== undefined && (
            <Switch
              className="tt-account-switch"
              checked={connection.enabled}
              disabled={busy !== null}
              label={tt("tasktrackers.manage.useInSpace", { name: connection.account.name })}
              onChange={(value) => void toggle(connection, value)}
            />
          )}
        </div>
      )) : (
        <p className="tt-service-hint">{tt("tasktrackers.manage.connectOwnHint")}</p>
      )}
      {connections.length > 0 && !active && (
        <p className="tt-service-hint">{tt("tasktrackers.manage.turnOnHint")}</p>
      )}
      {message && <p className={`tt-inline-message ${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p>}
      <div className="tt-service-actions">
        <Button
          size="sm"
          variant={active || !emphasize ? "quiet" : "primary"}
          disabled={!available || busy !== null}
          onClick={() => onConnect(provider, "personal")}
        >
          {active ? tt("tasktrackers.manage.reconnect") : tt("tasktrackers.manage.connectMyAccount")}
        </Button>
        {primary && (
          <>
            <Button size="sm" variant="ghost" busy={busy === "verify"} disabled={busy !== null} onClick={() => void run("verify")}>{tt("tasktrackers.manage.test")}</Button>
            <Button size="sm" variant="ghost" busy={busy === "disconnect"} disabled={busy !== null} onClick={() => void run("disconnect")}>{tt("tasktrackers.manage.disconnect")}</Button>
          </>
        )}
      </div>
    </div>
  );
}

function ServiceCard({
  provider,
  info,
  connection,
  personal,
  preferences,
  canManage,
  canConnect,
  vaultAvailable,
  personalAvailable,
  onConnect,
}: {
  provider: TaskTrackerProvider;
  info: TaskTrackerProviderDto | undefined;
  connection: TaskTrackerConnectionDto | undefined;
  personal: TaskTrackerPersonalConnectionDto[];
  preferences: TaskTrackerPreferences;
  canManage: boolean;
  canConnect: boolean;
  vaultAvailable: boolean;
  personalAvailable: boolean;
  onConnect: (provider: TaskTrackerProvider, scope: TaskTrackerConnectionScope) => void;
}) {
  const titleId = useId();
  const enabled = preferences.providers[provider];
  const state = providerState(info ? { ...info, enabled } : undefined);
  const [busy, setBusy] = useState<"verify" | "disconnect" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const run = async (kind: "verify" | "disconnect") => {
    setBusy(kind);
    setMessage(null);
    try {
      if (kind === "verify") {
        applyManagement(await api.taskTrackerVerifyConnection(provider));
        setMessage({ tone: "success", text: tt("tasktrackers.manage.connectionWorks") });
      } else {
        applyManagement(await api.taskTrackerDisconnect(provider));
        setConfirming(false);
      }
    } catch (cause) {
      setMessage({
        tone: "error",
        text: friendly(kind === "verify" ? tt("tasktrackers.manage.providerNoResponse", { provider: PROVIDER_LABELS[provider] }) : tt("tasktrackers.manage.couldNotDisconnect"), cause),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={`tt-service-card ${provider}${enabled ? "" : " off"}`} data-state={state} data-settings-item={`task-trackers-${provider}`} aria-labelledby={titleId}>
      <header className="tt-service-head">
        <ProviderMark provider={provider} size="lg" />
        <span className="tt-service-title">
          <strong id={titleId}>{PROVIDER_LABELS[provider]}</strong>
          <small>{providerBlurb(provider)}</small>
        </span>
        <Switch
          checked={enabled}
          disabled={!canManage}
          label={tt("tasktrackers.manage.useProvider", { name: PROVIDER_LABELS[provider] })}
          onChange={(value) => void updatePreferences({ providers: { [provider]: value } })}
        />
      </header>
      {!enabled && <p className="tt-service-off-hint">{tt("tasktrackers.manage.turnedOff")}</p>}

      <div className="tt-collapse" data-open={enabled}>
        <div className="tt-collapse-inner">
          <div className="tt-service-status">
            <Badge tone={state === "demo" ? "info" : STATE_TONES[state]} dot>{state === "demo" ? tt("tasktrackers.manage.usingDemo") : stateLabel(state)}</Badge>
            {connection && <small>{tt("tasktrackers.manage.checked", { time: relativeTime(connection.verifiedAt) })}</small>}
            {state === "env" && <small>{tt("tasktrackers.manage.fromEnv", { env: info?.requiredEnv.join(", ") ?? "" })}</small>}
          </div>

          {(connection || canManage) && <span className="tt-personal-label">{tt("tasktrackers.manage.sharedAccount")}</span>}
          {connection ? (
            <div className="tt-account-row">
              <AccountAvatar account={connection.account} />
              <span>
                <strong>{connection.account.name}</strong>
                <small>{connection.account.site ?? connection.account.email ?? ""}</small>
              </span>
            </div>
          ) : (
            <p className="tt-service-hint">
              {state === "env"
                ? tt("tasktrackers.manage.serverCredentials")
                : canManage
                  ? tt("tasktrackers.manage.connectUnderMinute", { how: connectCopy(provider).how })
                  : tt("tasktrackers.manage.noSharedAccount")}
            </p>
          )}

          {message && <p className={`tt-inline-message ${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p>}

          <div className="tt-service-actions">
            {confirming ? (
              <div className="tt-confirm" role="group" aria-label={tt("tasktrackers.manage.disconnectProvider", { provider: PROVIDER_LABELS[provider] })}>
                <span>{tt("tasktrackers.manage.removeCredential")}</span>
                <Button size="sm" variant="danger" busy={busy === "disconnect"} onClick={() => void run("disconnect")}>{tt("tasktrackers.manage.disconnect")}</Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirming(false)}>{tt("tasktrackers.manage.keep")}</Button>
              </div>
            ) : (
              <>
                {canManage && <Button
                  size="sm"
                  variant={connection ? "quiet" : "primary"}
                  disabled={!vaultAvailable || busy !== null}
                  onClick={() => onConnect(provider, "space")}
                >
                  {connection ? tt("tasktrackers.manage.reconnect") : tt("tasktrackers.manage.connectProvider", { provider: PROVIDER_LABELS[provider] })}
                </Button>}
                {connection && canManage && (
                  <>
                    <Button size="sm" variant="ghost" busy={busy === "verify"} disabled={busy !== null} onClick={() => void run("verify")}>
                      {tt("tasktrackers.manage.testConnection")}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirming(true)}>
                      {tt("tasktrackers.manage.disconnect")}
                    </Button>
                  </>
                )}
              </>
            )}
          </div>
          {canConnect && (
            <PersonalAccount
              provider={provider}
              connections={personal}
              emphasize={!canManage}
              available={personalAvailable}
              onConnect={onConnect}
            />
          )}
        </div>
      </div>
    </article>
  );
}

/** The package's management surface: services, behavior, and widgets. */
export function TaskTrackerManagement({ intro = true }: { intro?: boolean }) {
  const { data, error, loading, preferences } = useManagement();
  const [connecting, setConnecting] = useState<{ provider: TaskTrackerProvider; scope: TaskTrackerConnectionScope } | null>(null);
  const [policyError, setPolicyError] = useState("");

  if (!data) {
    return (
      <div className="tt-manage" aria-busy={loading}>
        {error ? (
          <Notice tone="error" actions={<Button size="sm" onClick={() => void loadManagement(true)}>{tt("tasktrackers.manage.tryAgain")}</Button>}>
            {error}
          </Notice>
        ) : (
          <div className="tt-manage-skeleton" role="status" aria-label={tt("tasktrackers.manage.loadingSettings")}>
            <Skeleton shape="block" height={120} /><Skeleton shape="block" height={120} /><Skeleton shape="block" height={72} />
          </div>
        )}
      </div>
    );
  }

  const canManage = data.canManage;
  const canConnect = data.canConnect ?? canManage;
  const liveCount = data.providers.filter((item) => {
    const state = providerState({ ...item, enabled: preferences.providers[item.provider] });
    return state === "connected" || state === "env";
  }).length;
  const enabledCount = TASK_TRACKER_PROVIDERS.filter((provider) => preferences.providers[provider]).length;
  // Older servers sent no personal availability: it followed the vault.
  const personalAvailable = data.personalAvailable ?? data.vaultAvailable;
  const personalFor = (provider: TaskTrackerProvider) => (data.personalConnections ?? [])
    .filter((item) => item.provider === provider)
    .sort((a, b) => Number(isOn(b)) - Number(isOn(a)));
  const setAgentPolicy = async (value: boolean) => {
    try {
      applyManagement(await api.taskTrackerSetServicePolicy(value));
    } catch (cause) {
      setPolicyError(friendly(tt("tasktrackers.manage.couldNotSave"), cause));
    }
  };

  return (
    <div className="tt-manage">
      {intro && (
        <header className="tt-manage-intro">
          {/* The settings shell already shows the page title; repeating it
              here read as two headings. Keep the one-line purpose + summary. */}
          <p>{tt("tasktrackers.manage.intro")}</p>
          <div className="tt-manage-stats" role="group" aria-label={tt("tasktrackers.manage.summary")}>
            <span>{tt("tasktrackers.manage.connectedCount", { count: liveCount })}</span>
            <span>{tt("tasktrackers.manage.turnedOnCount", { count: enabledCount, total: TASK_TRACKER_PROVIDERS.length })}</span>
          </div>
        </header>
      )}

      {!canManage && <Notice tone="info">{canConnect
        ? tt("tasktrackers.manage.adminsOnly")
        : tt("tasktrackers.manage.viewOnly")}</Notice>}
      {!data.vaultAvailable && (
        <Notice tone="warning" heading={tt("tasktrackers.manage.vaultOff")}>
          {tt("tasktrackers.manage.vaultOffBody")}
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      <section className="tt-manage-section" aria-labelledby="tt-manage-services">
        <h3 id="tt-manage-services">{tt("tasktrackers.manage.services")}</h3>
        <div className="tt-service-grid">
          {TASK_TRACKER_PROVIDERS.map((provider) => (
            <ServiceCard
              key={provider}
              provider={provider}
              info={data.providers.find((item) => item.provider === provider)}
              connection={data.connections.find((item) => item.provider === provider)}
              personal={personalFor(provider)}
              preferences={preferences}
              canManage={canManage}
              canConnect={canConnect}
              vaultAvailable={data.vaultAvailable}
              personalAvailable={personalAvailable}
              onConnect={(next, scope) => setConnecting({ provider: next, scope })}
            />
          ))}
        </div>
      </section>

      <section className="tt-manage-section" aria-labelledby="tt-manage-features">
        <h3 id="tt-manage-features">{tt("tasktrackers.manage.features")}</h3>
        <div className="tt-setting-list">
          {FEATURE_KEYS.map((feature) => (
            <SettingRow
              key={feature.key}
              title={tt(feature.title)}
              body={tt(feature.body)}
              checked={preferences[feature.key]}
              disabled={!canManage}
              onChange={(value) => void updatePreferences({ [feature.key]: value })}
            />
          ))}
          {canManage && data.agentsMayUseService !== undefined && (
            <SettingRow
              title={tt("tasktrackers.manage.agentsMayUse")}
              body={tt("tasktrackers.manage.agentsMayUseBody")}
              checked={data.agentsMayUseService}
              disabled={!personalAvailable}
              onChange={(value) => { setPolicyError(""); void setAgentPolicy(value); }}
            />
          )}
        </div>
        {policyError && <p className="tt-inline-message error" role="alert">{policyError}</p>}
      </section>

      <section className="tt-manage-section" aria-labelledby="tt-manage-widgets" data-settings-item="task-trackers-widgets">
        <h3 id="tt-manage-widgets">{tt("tasktrackers.manage.widgets")}</h3>
        <div className="tt-setting-list">
          {WIDGET_IDS.map((id) => (
            <SettingRow
              key={id}
              title={widgetCopy(id).title}
              body={widgetCopy(id).body}
              checked={preferences.widgets[id]}
              disabled={!canManage}
              onChange={(value) => void updatePreferences({ widgets: { [id]: value } })}
            />
          ))}
        </div>
      </section>

      {connecting && (
        <ConnectWizard
          provider={connecting.provider}
          scope={connecting.scope}
          existing={connecting.scope === "personal"
            ? personalFor(connecting.provider).find(isOn)
            : data.connections.find((item) => item.provider === connecting.provider)}
          onClose={() => setConnecting(null)}
        />
      )}
    </div>
  );
}

/** Settings → Task trackers. */
export function TaskTrackerSettingsPage() {
  return <div className="tt-settings-page"><TaskTrackerManagement /></div>;
}
