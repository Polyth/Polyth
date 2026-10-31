import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  GrantProfileId,
  PairingOfferDto,
  PairingStateDto,
  TunnelDeviceDto,
  TunnelStatusDto,
} from "@polyth/contracts";
import { GRANT_PROFILE_PRESETS } from "@polyth/contracts";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import type { TunnelMessageKey } from "../src/i18n/en.ts";
import { CheckGroup, EmptyState, ErrorState, PageHead, ReadonlyRow, Row, Section, Seg, Toggle } from "../../../apps/web/src/components/settings/parts.tsx";
import { Badge, Button, ChevronDownIcon, Dialog, Icon, IconButton, QrCodeIcon, RefreshIcon, Spinner, type BadgeTone } from "../../../apps/web/src/components/ui/index.ts";
import CopyButton from "../../../apps/web/src/components/CopyButton.tsx";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { applyTunnelStatusToCapability, setPolythLinkCapabilityAvailable } from "./availability.ts";
import { createTranslate, type Translate } from "./i18n.ts";
import { accessLabel, CAPABILITY_GROUPS, hasFullAccess, matchingPreset, PRESETS, withFullAccess } from "./permissions.ts";

const api = createApiTransport({
  fetch: (url, init) => fetch(url, { credentials: "include", ...init }),
});

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

type PairingOffer = PairingOfferDto & {
  qrModules?: boolean[][];
  numericCode?: string;
  numericExpiresAt?: string;
};

const pairingAccess = (t: Translate): Array<[GrantProfileId, string]> => [
  ["full-remote", t("tunnel.permissions.fullAccess")],
  ...PRESETS.map(([id, key]) => [id, t(key)] as [GrantProfileId, string]),
];

interface HostState {
  tone: BadgeTone;
  label: string;
  hint: string;
}

/** One plain-language status for "This computer". Raw policy/error codes are
 *  diagnostics and stay behind the Advanced disclosure. */
function hostState(status: TunnelStatusDto | null, t: Translate): HostState {
  const state = (tone: BadgeTone, label: TunnelMessageKey, hint: TunnelMessageKey): HostState =>
    ({ tone, label: t(label), hint: t(hint) });
  if (!status) return state("neutral", "tunnel.host.checking", "tunnel.host.checkingHint");
  if (status.unsupportedPlatform) return state("neutral", "tunnel.host.notAvailable", "tunnel.host.notAvailableHint");
  if (!status.hostBinaryFound) return state("warning", "tunnel.host.notInstalled", "tunnel.host.notInstalledHint");
  if (!status.hostProcessReady) return state("warning", "tunnel.host.reconnecting", "tunnel.host.reconnectingHint");
  if (!status.endpointBound || !status.ingressReady) return state("info", "tunnel.host.starting", "tunnel.host.startingHint");
  if (!status.identityAvailable) return state("warning", "tunnel.host.needsAttention", "tunnel.host.needsAttentionHint");
  if (!status.pairingAvailable) return state("info", "tunnel.host.connected", "tunnel.host.connectedHint");
  return { tone: "success", label: t("tunnel.host.ready"), hint: "" };
}

/** Raw diagnostics for support, never the headline. */
function hostDiagnostics(status: TunnelStatusDto | null, t: Translate): string[] {
  if (!status) return [];
  const lines = [t("tunnel.diagnostics.policy", { value: status.activePolicy ?? t("tunnel.diagnostics.none") })];
  if (status.lastErrorCode) lines.push(t("tunnel.diagnostics.lastError", { value: status.lastErrorCode }));
  if (status.identityError) lines.push(t("tunnel.diagnostics.identity", { value: status.identityError }));
  lines.push(t("tunnel.diagnostics.summary", {
    binary: t(status.hostBinaryFound ? "tunnel.diagnostics.found" : "tunnel.diagnostics.missing"),
    process: t(status.hostProcessReady ? "tunnel.diagnostics.ready" : "tunnel.diagnostics.down"),
    endpoint: t(status.endpointBound ? "tunnel.diagnostics.bound" : "tunnel.diagnostics.unbound"),
    ingress: t(status.ingressReady ? "tunnel.diagnostics.ready" : "tunnel.diagnostics.notReady"),
  }));
  return lines;
}

function deviceStatus(device: TunnelDeviceDto, t: Translate, locale: string): string {
  if (device.revokedAt) return t("tunnel.device.accessRevoked");
  if (!device.online) {
    return device.lastSeenAt
      ? t("tunnel.device.lastSeen", { date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(device.lastSeenAt)) })
      : t("tunnel.device.offline");
  }
  return device.lastTransport === "relay" ? t("tunnel.device.onlineRelay") : t("tunnel.device.online");
}

function secondsUntil(value: string | undefined, now: number): number | null {
  if (!value) return null;
  const expires = Date.parse(value);
  if (!Number.isFinite(expires)) return null;
  return Math.max(0, Math.ceil((expires - now) / 1_000));
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

function QrMatrix({ modules, t }: { modules: boolean[][]; t: Translate }) {
  return (
    <div className="pkg-tunnel-qr" role="img" aria-label={t("tunnel.permissions.qrAria")}>
      <svg viewBox={`-2 -2 ${modules.length + 4} ${modules.length + 4}`} aria-hidden="true" shapeRendering="crispEdges">
        {modules.flatMap((row, y) => row.map((on, x) => on
          ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} />
          : null))}
      </svg>
    </div>
  );
}

function DevicePermissions({ device, onChange, t }: {
  device: TunnelDeviceDto;
  onChange: (grants: string[]) => void;
  t: Translate;
}) {
  const full = hasFullAccess(device.grants);
  const preset = matchingPreset(device.grants);
  return (
    <div className="pkg-tunnel-perms">
      <Row label={t("tunnel.permissions.fullAccess")} hint={t("tunnel.permissions.fullAccessHint")}>
        <Toggle label={t("tunnel.permissions.fullAccess")} on={full} onChange={(on) => onChange(withFullAccess(device.grants, on))} />
      </Row>
      {!full && (
        <>
          <Row label={t("tunnel.permissions.startFrom")} hint={t("tunnel.permissions.startFromHint")}>
            <Seg
              label={t("tunnel.permissions.presetAria")}
              value={preset ?? ("custom" as GrantProfileId)}
              options={PRESETS.map(([id, key]) => [id, t(key)] as [GrantProfileId, string])}
              onChange={(id) => onChange([...GRANT_PROFILE_PRESETS[id]])}
            />
          </Row>
          <div className="pkg-tunnel-groups">
            {CAPABILITY_GROUPS.map((group) => (
              <div key={group.title} className="pkg-tunnel-group">
                <h4>{t(group.title)}</h4>
                <CheckGroup
                  label={t(group.title)}
                  value={device.grants.filter((grant) => group.items.some(([id]) => id === grant))}
                  options={group.items.map(([id, key]) => ({ id, label: t(key) }))}
                  onChange={(next) => {
                    const own = new Set(group.items.map(([id]) => id));
                    onChange([...device.grants.filter((grant) => !own.has(grant)), ...next]);
                  }}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function DeviceRow({ device, onGrants, onRevoke, onForget, t, locale }: {
  device: TunnelDeviceDto;
  onGrants: (grants: string[]) => Promise<void>;
  onRevoke: () => void;
  onForget: () => void;
  t: Translate;
  locale: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const panelId = useId();
  const revoked = Boolean(device.revokedAt);
  const full = hasFullAccess(device.grants);
  return (
    <li className={`pkg-tunnel-device${open ? " is-open" : ""}`}>
      <div className="pkg-tunnel-device-head">
        <span className={`pkg-tunnel-dot${device.online && !revoked ? " is-online" : ""}`} aria-hidden="true" />
        <div className="pkg-tunnel-device-copy">
          <strong>{device.label || t("tunnel.permissions.phone")}</strong>
          <span title={device.endpointFingerprint}>{deviceStatus(device, t, locale)}</span>
        </div>
        {revoked ? (
          <Button size="sm" variant="ghost" onClick={onForget}>{t("tunnel.permissions.forget")}</Button>
        ) : (
          <>
            <Badge tone={full ? "accent" : "neutral"}>{accessLabel(device.grants, t)}</Badge>
            <Button
              size="sm"
              variant="ghost"
              iconEnd={ChevronDownIcon}
              className="pkg-tunnel-disclose"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((value) => !value)}
            >
              {t("tunnel.permissions.open")}
            </Button>
          </>
        )}
      </div>
      {open && !revoked && (
        <div id={panelId} className="pkg-tunnel-device-body">
          <DevicePermissions
            device={device}
            t={t}
            onChange={(grants) => {
              setError("");
              void onGrants(grants).catch((cause) => setError(errorText(cause)));
            }}
          />
          {error && <ErrorState compact error={error} />}
          <div className="pkg-tunnel-device-foot">
            <Button size="sm" variant="danger" onClick={onRevoke}>{t("tunnel.permissions.revokeAccess")}</Button>
          </div>
        </div>
      )}
    </li>
  );
}

export default function LinkPage({ host }: { host?: WebPackageHost }) {
  const t = useMemo(() => createTranslate(host), [host]);
  const locale = host?.ui?.locale?.get?.() ?? "en";
  const [status, setStatus] = useState<TunnelStatusDto | null>(null);
  const [devices, setDevices] = useState<TunnelDeviceDto[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [profile, setProfile] = useState<GrantProfileId>("full-remote");
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [pairing, setPairing] = useState<PairingStateDto | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [signInRequired, setSignInRequired] = useState<boolean | null>(null);
  const pairingIdRef = useRef<string | null>(null);
  const statusRequestRef = useRef(0);
  pairingIdRef.current = offer?.pairing.id ?? null;

  const refreshStatus = useCallback(async () => {
    const requestId = ++statusRequestRef.current;
    try {
      const next = await api.get<TunnelStatusDto>("/api/tunnel/status");
      if (requestId === statusRequestRef.current) {
        setStatus(next);
        applyTunnelStatusToCapability(next);
      }
    } catch (cause) {
      if (requestId === statusRequestRef.current) {
        setStatus(null);
        setPolythLinkCapabilityAvailable(false);
      }
      throw cause;
    }
  }, []);

  const reload = useCallback(async () => {
    try {
      const [, nextDevices] = await Promise.all([
        refreshStatus(),
        api.get<TunnelDeviceDto[]>("/api/tunnel/devices").catch(() => [] as TunnelDeviceDto[]),
      ]);
      setDevices(nextDevices);
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [refreshStatus]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    let live = true;
    void api.get<{ required?: unknown }>("/api/auth/status").then(
      (auth) => { if (live) setSignInRequired(auth.required === true); },
      () => undefined,
    );
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!offer) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [offer]);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${proto}://${location.host}/ws/tunnel`);
    const onMessage = (event: MessageEvent<string>) => {
      let parsed: { type?: string; data?: { ready?: boolean } };
      try {
        parsed = JSON.parse(String(event.data)) as typeof parsed;
      } catch {
        return;
      }
      const type = parsed.type ?? "";
      if (type === "tunnel/host-status-changed" || type === "tunnel/snapshot") {
        if (parsed.data?.ready === false) {
          statusRequestRef.current++;
          setStatus((previous) => previous ? { ...previous, pairingAvailable: false, hostProcessReady: false } : null);
          setPolythLinkCapabilityAvailable(false);
          // Invitations are memory-only and do not survive a host generation.
          if (pairingIdRef.current) {
            setOffer(null);
            setPairing(null);
            setError(t("tunnel.identity.disconnected"));
          }
        }
        void refreshStatus().catch(() => {});
      }
      if (type.startsWith("tunnel/pairing") || type === "tunnel/snapshot") {
        const pairingId = pairingIdRef.current;
        if (pairingId) {
          void api.get<PairingStateDto>(`/api/tunnel/pairing/${pairingId}`).then((next) => {
            setPairing(next);
            if (next.state === "committed") {
              setPairingOpen(false);
              setOffer(null);
              void reload();
            }
          }).catch(() => {});
        }
      }
      if (type.startsWith("tunnel/device") || type.startsWith("tunnel/grants") || type === "tunnel/identity-rotated") {
        void reload();
      }
    };
    socket.addEventListener("message", onMessage);
    return () => {
      socket.removeEventListener("message", onMessage);
      socket.close();
    };
  }, [reload, refreshStatus, t]);

  useEffect(() => {
    if (!offer?.pairing.id) return;
    const timer = setInterval(async () => {
      try {
        const next = await api.get<PairingStateDto>(`/api/tunnel/pairing/${offer.pairing.id}`);
        setPairing(next);
        if (next.state === "committed") {
          setPairingOpen(false);
          setOffer(null);
          await reload();
        }
      } catch {
        // Snapshot catch-up only if the event socket is down.
      }
    }, 5_000);
    return () => clearInterval(timer);
  }, [offer?.pairing.id, reload]);

  // Omitting the profile lets the server apply its Full access default.
  const createPairing = (access: GrantProfileId): Promise<PairingOffer> =>
    api.post<PairingOffer>("/api/tunnel/pairing", access === "full-remote" ? {} : { profile: access });

  const issueOffer = async (access: GrantProfileId, previous: PairingOffer | null) => {
    setBusy(true);
    setError("");
    try {
      if (previous) await api.delete(`/api/tunnel/pairing/${previous.pairing.id}`).catch(() => {});
      const created = await createPairing(access);
      setOffer(created);
      setPairing(created.pairing as unknown as PairingStateDto);
    } catch (cause) {
      setOffer(null);
      setError(errorText(cause));
      await refreshStatus().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!offer) return;
    setBusy(true);
    try {
      await api.post(`/api/tunnel/pairing/${offer.pairing.id}/approve`);
    } catch (cause) {
      setError(errorText(cause));
      await refreshStatus().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const closePairing = async () => {
    // Esc, the backdrop, the header close button and Cancel all route here.
    if (offer) await api.post(`/api/tunnel/pairing/${offer.pairing.id}/reject`).catch(() => {});
    setPairingOpen(false);
    setOffer(null);
    setPairing(null);
    setError("");
  };

  const setGrants = async (device: TunnelDeviceDto, grants: string[]) => {
    const previous = devices;
    setDevices((list) => list.map((entry) => entry.id === device.id ? { ...entry, grants } : entry));
    try {
      const saved = await api.put<TunnelDeviceDto>(`/api/tunnel/devices/${device.id}/grants`, { grants });
      setDevices((list) => list.map((entry) => entry.id === saved.id ? { ...entry, ...saved } : entry));
    } catch (cause) {
      setDevices(previous);
      throw cause;
    }
  };

  const revoke = async (device: TunnelDeviceDto) => {
    if (!await confirmAlert(t("tunnel.permissions.revokeConfirm", { device: device.label }), {
      title: t("tunnel.permissions.revokeTitle"),
      confirmLabel: t("tunnel.permissions.revokeAction"),
    })) return;
    await api.post(`/api/tunnel/devices/${device.id}/revoke`);
    await reload();
  };

  const forget = async (device: TunnelDeviceDto) => {
    await api.delete(`/api/tunnel/devices/${device.id}`);
    await reload();
  };

  const rotate = async () => {
    if (!await confirmAlert(t("tunnel.identity.rotateConfirm"), {
      title: t("tunnel.identity.rotateTitle"),
      confirmLabel: t("tunnel.identity.rotateAction"),
    })) return;
    await api.post("/api/tunnel/identity/rotate");
    await reload();
  };

  const hostInfo = hostState(status, t);
  const diagnostics = hostDiagnostics(status, t);
  const openPairing = () => {
    setPairingOpen(true);
    setPairing(null);
    void issueOffer(profile, null);
  };
  const changeAccess = (next: GrantProfileId) => {
    setProfile(next);
    void issueOffer(next, offer);
  };

  const phrase = pairing?.safetyPhrase ?? null;
  const canAllow = Boolean(pairing?.deviceConfirmed) && pairing?.state !== "committed";
  const offerSeconds = secondsUntil(offer?.pairing.expiresAt, now);
  const expired = offerSeconds === 0 && !phrase;
  const numericSeconds = secondsUntil(offer?.numericExpiresAt, now);
  const address = typeof location === "undefined" ? "" : location.host;
  const active = devices.filter((device) => !device.revokedAt);
  const online = active.filter((device) => device.online).length;
  const summary = hostInfo.hint || (active.length === 0
    ? t("tunnel.hero.pairFirst")
    : t("tunnel.hero.connected", { online, total: active.length }));
  const accessOptions = pairingAccess(t);

  return (
    <div className="pkg-tunnel">
      <PageHead blurb={t("tunnel.page.blurb")} />
      {error && !pairingOpen && <ErrorState compact error={error} />}

      <section className="pkg-tunnel-hero" aria-labelledby="pkg-tunnel-hero-title" data-settings-item="tunnel.host">
        <div className="pkg-tunnel-hero-head">
          <span className="pkg-tunnel-hero-mark" aria-hidden="true"><Icon icon={QrCodeIcon} size="md" /></span>
          <div className="pkg-tunnel-hero-copy">
            <strong id="pkg-tunnel-hero-title">{t("tunnel.hero.title")}</strong>
            <span>{summary}</span>
          </div>
          <Badge tone={hostInfo.tone} dot>{hostInfo.label}</Badge>
        </div>
        <dl className="pkg-tunnel-facts">
          {address && (
            <div className="pkg-tunnel-fact">
              <dt>{t("tunnel.hero.address")}</dt>
              <dd><span className="pkg-tunnel-address" title={address}>{address}</span><CopyButton text={address} label={t("tunnel.hero.copyAddress")} /></dd>
            </div>
          )}
          <div className="pkg-tunnel-fact">
            <dt>{t("tunnel.hero.signIn")}</dt>
            <dd>{signInRequired === false ? t("tunnel.hero.signInNotRequired") : t("tunnel.hero.signInRequired")}</dd>
          </div>
        </dl>
        <Button variant="primary" className="pkg-tunnel-hero-pair" disabled={!status?.pairingAvailable} onClick={openPairing}>
          {t("tunnel.hero.pairPhone")}
        </Button>
      </section>

      <Section
        title={t("tunnel.devices.title")}
        hint={active.length > 0 ? t("tunnel.devices.hint") : undefined}
      >
        {devices.length === 0 ? (
          <EmptyState
            compact
            icon="qr"
            title={t("tunnel.devices.emptyTitle")}
            body={t("tunnel.devices.emptyBody")}
          />
        ) : (
          <ul className="pkg-tunnel-devices">
            {devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                onGrants={(grants) => setGrants(device, grants)}
                onRevoke={() => void revoke(device)}
                onForget={() => void forget(device)}
                t={t}
                locale={locale}
              />
            ))}
          </ul>
        )}
      </Section>

      <details className="pkg-tunnel-advanced">
        <summary>{t("tunnel.advanced.summary")}</summary>
        <Section
          title={t("tunnel.hero.title")}
          action={(
            <IconButton
              size="sm"
              icon={RefreshIcon}
              label={t("tunnel.advanced.refreshStatus")}
              busy={refreshing}
              onClick={() => {
                setRefreshing(true);
                void reload().finally(() => setRefreshing(false));
              }}
            />
          )}
        >
          {status?.identityAvailable && status.hostFingerprint && (
            <ReadonlyRow
              label={t("tunnel.advanced.fingerprint")}
              hint={t("tunnel.advanced.fingerprintHint")}
              value={<span className="pkg-tunnel-fingerprint" title={status.hostFingerprint}>{status.hostFingerprint}</span>}
              mono
              action={<CopyButton text={status.hostFingerprint} label={t("tunnel.advanced.copyFingerprint")} />}
            />
          )}
          {diagnostics.length > 0 && <pre className="pkg-tunnel-diagnostics">{diagnostics.join("\n")}</pre>}
        </Section>
        <Section title={t("tunnel.advanced.reset")} tone="danger">
          <Row
            label={t("tunnel.advanced.newIdentityLabel")}
            hint={t("tunnel.advanced.newIdentityHint")}
            disabled={!status?.hostProcessReady}
          >
            <Button size="sm" variant="danger" disabled={!status?.hostProcessReady} onClick={() => void rotate()}>{t("tunnel.advanced.newIdentityButton")}</Button>
          </Row>
        </Section>
      </details>

      {pairingOpen && (
        <Dialog
          title={phrase ? t("tunnel.dialog.confirmTitle") : t("tunnel.dialog.pairTitle")}
          size="sm"
          className="pkg-tunnel-dialog"
          onClose={() => { void closePairing(); }}
          footer={(
            <>
              <Button onClick={() => void closePairing()}>{t("tunnel.dialog.cancel")}</Button>
              {phrase ? (
                <Button variant="primary" busy={busy} disabled={!canAllow || !status?.pairingAvailable} onClick={() => void approve()}>
                  {t("tunnel.dialog.allow")}
                </Button>
              ) : (
                <Button variant={expired ? "primary" : "ghost"} disabled={busy || !status?.pairingAvailable} onClick={() => void issueOffer(profile, offer)}>
                  {t("tunnel.dialog.newCode")}
                </Button>
              )}
            </>
          )}
        >
          {error && <ErrorState compact error={error} />}
          {!offer && !error && (
            <div className="pkg-tunnel-pair is-loading" role="status">
              <Spinner />
              <span>{status?.pairingAvailable === false ? hostInfo.hint : t("tunnel.dialog.creating")}</span>
            </div>
          )}
          {offer && !phrase && (
            <div className="pkg-tunnel-pair">
              {offer.qrModules && offer.qrModules.length > 0 && <QrMatrix modules={offer.qrModules} t={t} />}
              <p className="pkg-tunnel-lead">
                {expired ? t("tunnel.dialog.expired") : t("tunnel.dialog.scan")}
              </p>
              <p className="pkg-tunnel-meta">
                {offer.numericCode && numericSeconds !== 0 && (
                  <>{t("tunnel.dialog.sameNetwork", { code: offer.numericCode })} </>
                )}
                {offerSeconds !== null && offerSeconds > 0 && <>{t("tunnel.dialog.expiresIn", { time: clock(offerSeconds) })}</>}
              </p>
              <details className="pkg-tunnel-access">
                <summary>{t("tunnel.dialog.accessSummary", { access: accessOptions.find(([id]) => id === profile)?.[1] ?? "" })}</summary>
                <Seg label={t("tunnel.dialog.accessAria")} value={profile} options={accessOptions} disabled={busy} onChange={changeAccess} />
                <p className="pkg-tunnel-meta">{t("tunnel.dialog.accessHint")}</p>
              </details>
            </div>
          )}
          {offer && phrase && (
            <div className="pkg-tunnel-pair">
              <ol className="pkg-tunnel-phrase">
                {phrase.map((word) => <li key={word}>{word}</li>)}
              </ol>
              <p className="pkg-tunnel-lead">
                {pairing?.deviceConfirmed
                  ? t("tunnel.dialog.confirmed", { device: pairing.device?.label || t("tunnel.dialog.phoneFallback") })
                  : t("tunnel.dialog.checkWords")}
              </p>
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}
