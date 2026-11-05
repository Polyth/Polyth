// The desktop app's server list: this computer's Polyth, the servers it paired
// with through Polyth Link and the ones it opens by address. It runs from the
// app's own bundle on its own origin, with no server behind it, and is the only
// page that may pair, connect or forget. The window reaches this page whenever
// there is a choice to make; a server that opens hands the window over.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  ConnectionController,
  connectionPhaseBusy,
  type ConnectionControllerState,
  type ConnectionPhase,
} from "@polyth/mobile/connection-controller";
import { bootstrapUrlWithNext, LAUNCH_STALL_MS, RESUME_COOLDOWN_MS } from "@polyth/mobile/connection-ui";
import type { ConnectionMetadata, PolythLinkNative, ProxyLaunch } from "@polyth/mobile/link";
import { isPairingDeepLink } from "@polyth/mobile/runtime";
import { applyBackgroundToDom } from "../backgrounds.ts";
import { POLYTH_MARK_SRC } from "../brandAsset.ts";
import { installDesktopIntegration } from "../desktop.tsx";
import {
  desktopBridge,
  type DesktopServersResult,
  type DesktopServersView,
  type PolythDesktopServersApi,
} from "../desktopBridge.ts";
import { getLocaleSnapshot, subscribeLocale, tr, type TranslationKey } from "../i18n/index.ts";
import { applySettingsToDom } from "../settings.ts";
import { getState } from "../store.ts";
import { applyUiSettings } from "../uiPrefs.ts";
import SlotHost from "./slots/SlotHost.ts";
import {
  Button,
  CheckIcon,
  ChevronRightIcon,
  GlobeIcon,
  Icon,
  IconButton,
  LinkIcon,
  Menu,
  type MenuEntry,
  MonitorIcon,
  MoreIcon,
  Spinner,
  Switch,
  TextInput,
} from "./ui/index.ts";

const unwrap = <T,>(answer: DesktopServersResult<T>): T => {
  if (answer.ok) return answer.result;
  throw Object.assign(new Error(answer.code), { code: answer.code });
};

/** The phones' connection state machine, over the main process's Link client. */
export function desktopLinkAdapter(servers: PolythDesktopServersApi): PolythLinkNative {
  const call = async <T,>(method: string, params?: Record<string, unknown>): Promise<T> =>
    unwrap(await servers.link(method, params)) as T;
  return {
    parsePairingTicket: (raw) => call("pairing.parse", { ticket: raw }),
    beginPairing: (raw, label) => call("pairing.begin", { ticket: raw, ...(label ? { label } : {}) }),
    // Finding nearby servers needs local discovery the desktop app does not have.
    beginNumericPairing: () => Promise.reject(Object.assign(new Error("unavailable"), { code: "unavailable" })),
    confirmPairing: (attemptId) => call("pairing.confirm", { attemptId }),
    cancelPairing: async (attemptId) => { await call("pairing.cancel", { attemptId }); },
    listConnections: () => call("connections.list"),
    connect: (connectionId) => call("connect", { connectionId }),
    recoverConnection: (connectionId) => call("connection.recover", { connectionId }),
    disconnect: async (connectionId) => { await call("disconnect", { connectionId }); },
    forgetConnection: async (connectionId) => { await call("forget", { connectionId }); },
    renameConnection: async (connectionId, label) => { await call("connections.rename", { connectionId, label }); },
    getStatus: (connectionId) => call("status", { connectionId }),
  };
}

/** Failures the list explains; anything else reads as a plain failure to connect. */
const FAILURE_MESSAGES: Readonly<Partial<Record<ConnectionPhase | string, TranslationKey>>> = {
  offline: "desktop.servers.errorOffline",
  unreachable: "desktop.servers.errorUnreachable",
  "server-unreachable": "desktop.servers.errorAddressUnreachable",
  revoked: "desktop.servers.errorRevoked",
  "identity-mismatch": "desktop.servers.errorIdentity",
  incompatible: "desktop.servers.errorIncompatible",
  "pairing-expired": "desktop.servers.errorPairingExpired",
  "pairing-rejected": "desktop.servers.errorPairingRejected",
  "invalid-address": "desktop.servers.errorInvalid",
  "not-polyth": "desktop.servers.errorNotPolyth",
  "link-unavailable": "desktop.servers.errorLinkUnavailable",
  "pairing-invalid": "desktop.servers.errorPairingInvalid",
};

const FAILURE_PHASES: ReadonlySet<ConnectionPhase> = new Set<ConnectionPhase>([
  "offline", "unreachable", "revoked", "identity-mismatch", "incompatible",
  "pairing-expired", "pairing-rejected", "fatal-error",
]);

function failureMessage(state: ConnectionControllerState | null, ownCode: string | null): string | null {
  if (ownCode) return tr(FAILURE_MESSAGES[ownCode] ?? "desktop.servers.errorGeneric");
  if (!state) return null;
  if (FAILURE_PHASES.has(state.phase)) {
    return tr(FAILURE_MESSAGES[state.phase] ?? FAILURE_MESSAGES[state.error ?? ""] ?? "desktop.servers.errorGeneric");
  }
  // A ticket refused before any connection stays on the list with its reason.
  if (state.error) return tr(FAILURE_MESSAGES[state.error] ?? "desktop.servers.errorGeneric");
  return null;
}

/** Session storage of this origin survives the trip to a server and back, so a
 *  page that keeps failing settles on the list instead of bouncing forever. */
const LAST_RESUME_KEY = "polyth.desktop.last-resume-at";

function resumeAllowed(): boolean {
  try {
    const last = Number(sessionStorage.getItem(LAST_RESUME_KEY));
    if (Number.isFinite(last) && last > 0 && Date.now() - last < RESUME_COOLDOWN_MS) return false;
    sessionStorage.setItem(LAST_RESUME_KEY, String(Date.now()));
  } catch { /* best effort */ }
  return true;
}

const addressHost = (url: string): string => {
  try { return new URL(url).host; } catch { return url; }
};

function linkDetail(connection: ConnectionMetadata): string {
  if (connection.revoked || connection.pairingState === "revoked") return tr("desktop.servers.statusRevoked");
  if (!connection.hasSecureIdentity) return tr("desktop.servers.statusPairAgain");
  if (connection.pairingState === "prepared") return tr("desktop.servers.statusResumePairing");
  return connection.lastTransport === "relay" ? tr("desktop.servers.statusReadyRelay") : tr("desktop.servers.statusReady");
}

function localDetail(view: DesktopServersView): string {
  if (view.local === "setup") return tr("desktop.servers.localSetup");
  return view.local === "running" ? tr("desktop.servers.localRunning") : tr("desktop.servers.localStopped");
}

interface RowProps {
  icon: typeof MonitorIcon;
  title: string;
  detail: string;
  current?: boolean;
  tone?: "danger";
  disabled?: boolean;
  busy?: boolean;
  onOpen: () => void;
  menu?: MenuEntry[];
  menuLabel?: string;
}

function ServerRow({ icon, title, detail, current, tone, disabled, busy, onOpen, menu, menuLabel }: RowProps) {
  return (
    <li className="desktop-servers-row">
      <button type="button" className="desktop-servers-open" disabled={disabled} aria-current={current || undefined} onClick={onOpen}>
        <span className="setup-usage-icon" aria-hidden="true"><Icon icon={icon} size="md" /></span>
        <span className="setup-usage-text">
          <span className="setup-usage-title" dir="auto">{title}</span>
          <span className="setup-usage-detail" data-tone={tone}>{detail}</span>
        </span>
        <span className="desktop-servers-trail" aria-hidden="true">
          {busy ? <Spinner size="sm" /> : <Icon icon={current ? CheckIcon : ChevronRightIcon} size="sm" />}
        </span>
      </button>
      {menu && menu.length > 0 && (
        <Menu label={menuLabel ?? title} align="end" entries={menu}>
          {(trigger) => <IconButton {...trigger} icon={MoreIcon} size="sm" label={menuLabel ?? title} className="desktop-servers-more" />}
        </Menu>
      )}
    </li>
  );
}

function DesktopServerList({ servers, query }: { servers: PolythDesktopServersApi; query: URLSearchParams }) {
  useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot);
  const controller = useMemo(() => new ConnectionController(desktopLinkAdapter(servers)), [servers]);
  const [state, setState] = useState<ConnectionControllerState | null>(() => controller.state);
  const [view, setView] = useState<DesktopServersView | null>(null);
  const [listLoaded, setListLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [ownError, setOwnError] = useState<string | null>(query.get("error"));
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [forgetting, setForgetting] = useState<{ title: string; run: () => void } | null>(null);
  const autoOpen = useRef(false);
  const stall = useRef<number | null>(null);
  const next = query.get("next") ?? undefined;

  const phase = state?.phase ?? "idle";
  const attempt = state?.pairingAttempt ?? null;
  const trusted = state?.trusted ?? [];
  const target = trusted.find((connection) => connection.id === state?.targetConnectionId);
  const connecting = phase === "reconnecting" || phase === "switching" || phase === "recovering" || phase === "connected";

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    void servers.state().then((current) => {
      setView(current);
      if (current.linkAvailable) return controller.loadTrustedConnections();
      return undefined;
    }).finally(() => setListLoaded(true));
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller, servers]);

  useEffect(() => {
    const leaving = () => { if (stall.current !== null) window.clearTimeout(stall.current); };
    window.addEventListener("pagehide", leaving);
    return () => { window.removeEventListener("pagehide", leaving); leaving(); };
  }, []);

  const hand = (launch: ProxyLaunch | undefined): void => {
    if (!launch) return;
    // Nothing in this page hears a navigation that failed before committing.
    stall.current = window.setTimeout(() => controller.launchStalled(launch.connectionId), LAUNCH_STALL_MS);
    location.replace(bootstrapUrlWithNext(launch.bootstrapUrl, next));
  };

  const openLink = (connection: ConnectionMetadata): void => {
    setOwnError(null);
    const pending = connection.pairingState === "prepared"
      ? controller.recoverPrepared(connection.id)
      : controller.connect(connection.id);
    void pending.then(hand);
  };

  const openDirect = (key: string, run: () => ReturnType<PolythDesktopServersApi["open"]>): void => {
    setOwnError(null);
    setOpening(key);
    void run().then((answer) => {
      // On success the window is already moving to that server.
      if (!answer.ok) {
        setOwnError(answer.code);
        setOpening(null);
      }
    }, () => {
      setOwnError("unavailable");
      setOpening(null);
    });
  };

  // Opened to reconnect a server: go straight there, unless it keeps failing.
  useEffect(() => {
    const open = query.get("open");
    if (!open || autoOpen.current || !listLoaded || state?.phase !== "idle") return;
    autoOpen.current = true;
    if (query.get("resume") === "1" && !resumeAllowed()) return;
    const connection = trusted.find((item) => item.id === open);
    if (connection && !connection.revoked && connection.hasSecureIdentity) openLink(connection);
  }, [listLoaded, state?.phase, trusted]);

  const submitAdd = (event: FormEvent): void => {
    event.preventDefault();
    const value = input.trim();
    if (!value) return;
    setOwnError(null);
    if (isPairingDeepLink(value)) {
      if (view?.linkAvailable === false) {
        setOwnError("link-unavailable");
        return;
      }
      void controller.beginPairing(value).then((pairing) => {
        if (pairing) setInput("");
        if (pairing && !pairing.safetyPhrase?.length) void controller.confirmPairing().then(hand);
      });
      return;
    }
    openDirect(`address:${value}`, () => servers.open({ kind: "address", url: value }));
  };

  const header = (title: string, hint?: string) => (
    <>
      <div className="lock-mark-frame">
        <img className="welcome-mark" src={POLYTH_MARK_SRC} alt="" aria-hidden="true" />
      </div>
      <h1 id="desktop-servers-title">{title}</h1>
      {hint && <p className="lock-hint">{hint}</p>}
    </>
  );

  const chrome = (card: ReactNode) => (
    <div className="lock-screen desktop-servers">
      <SlotHost slot="app.window.controls" />
      <div className="lock-card lock-card--setup" aria-labelledby="desktop-servers-title">{card}</div>
    </div>
  );

  // Pairing replaces the list: the words and the approval are all that matter.
  if (attempt && phase === "awaiting-host-approval") {
    return chrome(
      <div className="setup-status" role="status" aria-live="polite">
        {header(tr("desktop.servers.waitingTitle"), tr("desktop.servers.waitingBody"))}
        <Spinner className="setup-spinner" size="md" />
        <div className="lock-actions">
          <Button onClick={() => controller.cancelPairing()}>{tr("common.cancel")}</Button>
        </div>
      </div>,
    );
  }
  if (attempt) {
    const words = attempt.safetyPhrase ?? [];
    return chrome(
      <>
        {header(tr("desktop.servers.checkWordsTitle"), tr("desktop.servers.checkWordsBody"))}
        <ol className="desktop-servers-words">
          {words.map((word) => <li key={word} dir="auto">{word}</li>)}
        </ol>
        <div className="lock-actions">
          <Button variant="primary" className="lock-submit" block onClick={() => void controller.confirmPairing().then(hand)}>
            {tr("desktop.servers.wordsMatch")}
          </Button>
          <Button block onClick={() => controller.cancelPairing()}>{tr("common.cancel")}</Button>
        </div>
      </>,
    );
  }
  if (phase === "validating-pairing" || phase === "preparing-pairing" || phase === "pairing" || phase === "committing") {
    return chrome(
      <div className="setup-status" role="status" aria-live="polite">
        {header(tr("desktop.servers.pairingTitle"))}
        <Spinner className="setup-spinner" size="md" />
      </div>,
    );
  }
  if (connecting) {
    return chrome(
      <div className="setup-status" role="status" aria-live="polite">
        {header(tr("desktop.servers.connectingTo", { name: target?.hostLabel || "Polyth" }))}
        <Spinner className="setup-spinner" size="md" />
        <div className="lock-actions">
          <Button onClick={() => void controller.disconnectActive()}>{tr("desktop.servers.chooseAnother")}</Button>
        </div>
      </div>,
    );
  }

  const busy = opening !== null || (state ? connectionPhaseBusy(state.phase) : false);
  const error = failureMessage(state, ownError);
  const others = trusted.length + (view?.addresses.length ?? 0);
  const onlyLocal = listLoaded && others === 0;
  const activeLocal = view?.active.kind === "local";

  return chrome(
    <>
      {header(
        onlyLocal ? tr("desktop.servers.titleFirst") : tr("desktop.servers.title"),
        onlyLocal ? tr("desktop.servers.introFirst") : undefined,
      )}
      <ul className="setup-usage desktop-servers-list">
        {view && (
          <ServerRow
            icon={MonitorIcon}
            title={tr("desktop.servers.thisComputer")}
            detail={localDetail(view)}
            current={activeLocal && view.local !== "stopped"}
            disabled={busy}
            busy={opening === "local"}
            onOpen={() => openDirect("local", () => servers.open({ kind: "local" }))}
          />
        )}
        {trusted.map((connection) => {
          if (renaming?.id === connection.id) {
            return (
              <li key={connection.id} className="desktop-servers-row desktop-servers-rename">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void controller.rename(connection.id, renaming.draft).finally(() => setRenaming(null));
                  }}
                >
                  <TextInput
                    aria-label={tr("desktop.servers.renameLabel")}
                    value={renaming.draft}
                    placeholder={connection.serverLabel || "Polyth"}
                    maxLength={80}
                    autoFocus
                    onChange={(event) => setRenaming({ id: connection.id, draft: event.target.value })}
                    onKeyDown={(event) => { if (event.key === "Escape") setRenaming(null); }}
                  />
                  <Button size="sm" type="submit">{tr("common.save")}</Button>
                </form>
              </li>
            );
          }
          const unusable = connection.revoked || connection.pairingState === "revoked" || !connection.hasSecureIdentity;
          const name = connection.hostLabel || "Polyth";
          return (
            <ServerRow
              key={connection.id}
              icon={LinkIcon}
              title={name}
              detail={linkDetail(connection)}
              {...(unusable ? { tone: "danger" as const } : {})}
              disabled={busy || unusable}
              menuLabel={tr("desktop.servers.moreFor", { name })}
              menu={[
                { id: "rename", label: tr("desktop.servers.rename"), onSelect: () => setRenaming({ id: connection.id, draft: connection.customLabel || connection.hostLabel || "" }) },
                {
                  id: "forget",
                  label: tr("desktop.servers.forget"),
                  onSelect: () => setForgetting({ title: name, run: () => void controller.forget(connection.id) }),
                },
              ]}
              onOpen={() => openLink(connection)}
            />
          );
        })}
        {view?.addresses.map((address) => {
          const name = addressHost(address.url);
          const key = `address:${address.url}`;
          return (
            <ServerRow
              key={address.url}
              icon={GlobeIcon}
              title={name}
              detail={address.url.startsWith("http:") ? tr("desktop.servers.addressPlain") : tr("desktop.servers.addressSecure")}
              current={view.active.kind === "address" && view.active.url === address.url}
              disabled={busy}
              busy={opening === key}
              menuLabel={tr("desktop.servers.moreFor", { name })}
              menu={[{
                id: "forget",
                label: tr("desktop.servers.forget"),
                onSelect: () => setForgetting({
                  title: name,
                  run: () => void servers.forgetAddress(address.url).then(setView),
                }),
              }]}
              onOpen={() => openDirect(key, () => servers.open({ kind: "address", url: address.url }))}
            />
          );
        })}
      </ul>

      {forgetting && (
        <div className="desktop-servers-confirm" role="alertdialog" aria-label={tr("desktop.servers.forgetTitle", { name: forgetting.title })}>
          <span>{tr("desktop.servers.forgetTitle", { name: forgetting.title })}</span>
          <div>
            <Button size="sm" onClick={() => setForgetting(null)}>{tr("common.cancel")}</Button>
            <Button size="sm" variant="danger" onClick={() => { forgetting.run(); setForgetting(null); }}>{tr("desktop.servers.forget")}</Button>
          </div>
        </div>
      )}

      {error && <div className="lock-error" role="alert">{error}</div>}

      <form className="desktop-servers-add" onSubmit={submitAdd}>
        <label htmlFor="desktop-servers-add-input">{tr("desktop.servers.addLabel")}</label>
        <div>
          <TextInput
            id="desktop-servers-add-input"
            autoFocus={query.get("add") === "1"}
            value={input}
            placeholder={tr("desktop.servers.addPlaceholder")}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => { setInput(event.target.value); setOwnError(null); }}
          />
          <Button type="submit" variant={onlyLocal ? "primary" : "quiet"} disabled={busy || !input.trim()}>
            {tr("desktop.servers.connect")}
          </Button>
        </div>
        <p>{tr("desktop.servers.addHint")}</p>
      </form>

      {view && others > 0 && (
        <label className="desktop-servers-keep">
          <span className="setup-usage-text">
            <span className="setup-usage-title">{tr("desktop.servers.keepRunning")}</span>
            <span className="setup-usage-detail">{tr("desktop.servers.keepRunningHint")}</span>
          </span>
          <Switch
            checked={view.runLocalServer}
            label={tr("desktop.servers.keepRunning")}
            onChange={(checked) => { void servers.setRunLocalServer(checked).then(setView); }}
          />
        </label>
      )}
    </>,
  );
}

export function renderDesktopServerList(): void {
  const servers = desktopBridge()?.servers;
  if (!servers) return;
  applySettingsToDom(getState().settings);
  applyUiSettings();
  applyBackgroundToDom();
  installDesktopIntegration();
  createRoot(document.getElementById("root") as HTMLElement).render(
    <DesktopServerList servers={servers} query={new URLSearchParams(location.search)} />,
  );
}

export { DesktopServerList };
