import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  GrantProfileId,
  PairingOfferDto,
  PairingStateDto,
  TunnelDeviceDto,
  TunnelStatusDto,
} from "@polyth/contracts";
import { GRANT_PROFILE_PRESETS } from "@polyth/contracts";
import { ApiError, createApiTransport, type SettingsNavigationTarget, type WebPackageHost } from "@polyth/web-sdk";
import type { TunnelMessageKey } from "../src/i18n/en.ts";
import { SERVER_NAME_MAX_CHARS, type TunnelServerNameDto } from "../src/serverName.ts";
import { CheckGroup, EmptyState, ErrorState, PageHead, ReadonlyRow, Row, SaveStatus, Section, Seg, Toggle, type SaveStatusState } from "../../../apps/web/src/components/settings/parts.tsx";
import { Badge, Button, ChevronDownIcon, Dialog, Icon, IconButton, QrCodeIcon, RefreshIcon, Spinner, Select, TextInput, type BadgeTone } from "../../../apps/web/src/components/ui/index.ts";
import CopyButton from "../../../apps/web/src/components/CopyButton.tsx";
import { copyText } from "../../../apps/web/src/utils.ts";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { applyTunnelStatusToCapability, setPolythLinkCapabilityAvailable } from "./availability.ts";
import { createTranslate, type Translate } from "./i18n.ts";
import { accessLabel, CAPABILITY_GROUPS, hasFullAccess, matchingPreset, PRESETS, withFullAccess } from "./permissions.ts";
import { loadTeammates, type Teammate } from "./people.ts";
import JoinedServers from "./JoinedServers.tsx";

const api = createApiTransport({
  fetch: (url, init) => fetch(url, { credentials: "include", ...init }),
});

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

type PairingOffer = PairingOfferDto & {
  qrModules?: boolean[][];
  numericCode?: string;
  numericExpiresAt?: string;
  /** Set when the invitation joins another person's account. */
  forUserId?: string;
};

/** A device this owner paired into someone else's account. */
type IssuedDevice = TunnelDeviceDto & { accountId: string };

/** Deep-link targets already acted on, so a remount does not reopen the dialog. */
const handledTargets = new WeakSet<SettingsNavigationTarget>();

const FOR_SELF = "self";
const FOR_PREFIX = "user:";

/** Full access first: for another person it means everything that person may
 *  do when signed in here, bounded by their own account, never yours. */
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

/** A computer cannot scan its own screen, so it takes the invitation as a link. */
function CopyPairingLink({ link, t }: { link: string; t: Translate }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button size="sm" variant="ghost" onClick={() => void copyText(link).then((ok) => { if (ok) setCopied(true); })}>
      {t(copied ? "tunnel.dialog.linkCopied" : "tunnel.dialog.copyLink")}
    </Button>
  );
}

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

/** The name paired phones show for this server: commits on blur or Enter,
 *  Escape goes back. Empty means the host name (the placeholder). */
function ServerNameFact({ value, onSave, t }: {
  value: TunnelServerNameDto;
  onSave: (name: string) => Promise<void>;
  t: Translate;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value.name);
  const [state, setState] = useState<SaveStatusState>("idle");
  const [failure, setFailure] = useState("");
  useEffect(() => { setDraft(value.name); }, [value.name]);
  const commit = async () => {
    if (draft.trim() === value.name) {
      setDraft(value.name);
      return;
    }
    setState("saving");
    try {
      await onSave(draft);
      setState("saved");
    } catch (cause) {
      setFailure(errorText(cause));
      setState("error");
    }
  };
  return (
    <div className="pkg-tunnel-fact" data-settings-item="tunnel.serverName">
      <dt>{value.editable ? <label htmlFor={id}>{t("tunnel.hero.serverName")}</label> : t("tunnel.hero.serverName")}</dt>
      <dd>
        {state !== "idle" && <SaveStatus state={state} {...(failure ? { error: failure } : {})} />}
        {value.editable ? (
          <TextInput
            id={id}
            name="server-name"
            uiSize="sm"
            className="pkg-tunnel-name"
            value={draft}
            placeholder={value.fallback}
            maxLength={SERVER_NAME_MAX_CHARS}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setDraft(event.target.value);
              setState("idle");
            }}
            onBlur={() => { void commit(); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setDraft(value.name);
            }}
          />
        ) : (
          <span className="pkg-tunnel-name-value">{value.name || value.fallback}</span>
        )}
      </dd>
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

function IssuedDeviceRow({ device, person, onRevoke, onForget, t, locale }: {
  device: IssuedDevice;
  person: string;
  onRevoke: () => void;
  onForget: () => void;
  t: Translate;
  locale: string;
}) {
  const revoked = Boolean(device.revokedAt);
  return (
    <li className="pkg-tunnel-device">
      <div className="pkg-tunnel-device-head">
        <span className={`pkg-tunnel-dot${device.online && !revoked ? " is-online" : ""}`} aria-hidden="true" />
        <div className="pkg-tunnel-device-copy">
          <strong>{device.label || t("tunnel.permissions.phone")}</strong>
          <span title={device.endpointFingerprint}>
            {[person, device.platform, deviceStatus(device, t, locale)].filter(Boolean).join(" · ")}
          </span>
        </div>
        {revoked
          ? <Button size="sm" variant="ghost" onClick={onForget}>{t("tunnel.permissions.forget")}</Button>
          : <Button size="sm" variant="ghost" onClick={onRevoke}>{t("tunnel.permissions.revokeAction")}</Button>}
      </div>
    </li>
  );
}

export default function LinkPage({ host, settingsTarget }: {
  host?: WebPackageHost;
  settingsTarget?: SettingsNavigationTarget;
}) {
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
  const [serverName, setServerName] = useState<TunnelServerNameDto | null>(null);
  const [issued, setIssued] = useState<IssuedDevice[]>([]);
  // Null until known, and for everyone but the instance owner.
  const [teammates, setTeammates] = useState<Teammate[] | null>(null);
  // Empty pairs the owner's own device.
  const [forUserId, setForUserId] = useState("");
  const [teammateProfile, setTeammateProfile] = useState<GrantProfileId>("full-remote");
  const [targetError, setTargetError] = useState("");
  const issueRef = useRef(0);
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
      const [, nextDevices, nextIssued] = await Promise.all([
        refreshStatus(),
        api.get<TunnelDeviceDto[]>("/api/tunnel/devices").catch(() => [] as TunnelDeviceDto[]),
        api.get<IssuedDevice[]>("/api/tunnel/devices/issued").catch(() => [] as IssuedDevice[]),
      ]);
      setDevices(nextDevices);
      setIssued(Array.isArray(nextIssued) ? nextIssued : []);
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [refreshStatus]);

  useEffect(() => { void reload(); }, [reload]);
  const refreshTeammates = useCallback(async () => {
    const next = await loadTeammates(api);
    setTeammates(next);
    return next;
  }, []);
  // Without the list the page still pairs the person's own devices.
  useEffect(() => { void refreshTeammates().catch(() => {}); }, [refreshTeammates]);
  const refreshServerName = useCallback(async () => {
    try {
      const next = await api.get<TunnelServerNameDto>("/api/tunnel/server-name");
      if (typeof next.name === "string" && typeof next.fallback === "string") setServerName(next);
    } catch {
      // A server without the setting shows no row.
    }
  }, []);
  useEffect(() => { void refreshServerName(); }, [refreshServerName]);
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
            if (pairingIdRef.current !== pairingId) return;
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
      if (type === "tunnel/server-name-changed") void refreshServerName();
    };
    socket.addEventListener("message", onMessage);
    return () => {
      socket.removeEventListener("message", onMessage);
      socket.close();
    };
  }, [reload, refreshStatus, refreshServerName, t]);

  useEffect(() => {
    if (!offer?.pairing.id) return;
    const timer = setInterval(async () => {
      try {
        const next = await api.get<PairingStateDto>(`/api/tunnel/pairing/${offer.pairing.id}`);
        if (pairingIdRef.current !== offer.pairing.id) return;
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

  const personName = (id: string): string =>
    teammates?.find((person) => person.id === id)?.name || t("tunnel.for.teammate");

  // For the owner's own device, omitting the profile lets the server apply its
  // Full access default.
  const createPairing = (access: GrantProfileId, forId: string): Promise<PairingOffer> =>
    api.post<PairingOffer>("/api/tunnel/pairing", forId
      ? { forUserId: forId, profile: access }
      : access === "full-remote" ? {} : { profile: access });

  const cancelPairing = (id: string) => api.delete(`/api/tunnel/pairing/${id}`).catch(() => {});

  const issueOffer = async (access: GrantProfileId, forId: string, previousId: string | null) => {
    // Only the newest request may show its code: an older one could belong to a
    // different person than the dialog now names.
    const request = ++issueRef.current;
    setBusy(true);
    setError("");
    try {
      if (previousId) await cancelPairing(previousId);
      if (request !== issueRef.current) return;
      const created = await createPairing(access, forId);
      if (request !== issueRef.current) {
        await cancelPairing(created.pairing.id);
        return;
      }
      if (forId && created.forUserId !== forId) {
        await cancelPairing(created.pairing.id);
        throw new Error(t("tunnel.for.mismatch"));
      }
      setOffer(created);
      setPairing(created.pairing as unknown as PairingStateDto);
    } catch (cause) {
      if (request !== issueRef.current) return;
      setOffer(null);
      setError(forId && cause instanceof ApiError && cause.status === 403 ? t("tunnel.for.ownerOnly") : errorText(cause));
      await refreshStatus().catch(() => {});
    } finally {
      if (request === issueRef.current) setBusy(false);
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
    issueRef.current++;
    setBusy(false);
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
  // A new person starts a new invitation; the old code leaves the screen at once.
  const pairFor = (forId: string) => {
    const previousId = pairingIdRef.current;
    setForUserId(forId);
    setTeammateProfile("full-remote");
    setOffer(null);
    setPairing(null);
    void issueOffer(forId ? "full-remote" : profile, forId, previousId);
  };
  const openPairing = (forId = "") => {
    setPairingOpen(true);
    setTargetError("");
    pairFor(forId);
  };
  const changeAccess = (next: GrantProfileId) => {
    if (forUserId) setTeammateProfile(next);
    else setProfile(next);
    void issueOffer(next, forUserId, offer?.pairing.id ?? null);
  };

  useEffect(() => {
    const target = settingsTarget;
    const id = target?.sectionId === "pair-for" ? target.itemId : undefined;
    if (!target || !id || handledTargets.has(target)) return undefined;
    let live = true;
    const settle = (apply: () => void) => {
      if (!live || handledTargets.has(target)) return;
      handledTargets.add(target);
      apply();
    };
    void refreshTeammates().then(
      (list) => settle(() => {
        if (list?.some((person) => person.id === id)) openPairing(id);
        else setTargetError(t(list ? "tunnel.for.unavailable" : "tunnel.for.ownerOnly"));
      }),
      (cause) => settle(() => setTargetError(
        cause instanceof ApiError && cause.status === 403 ? t("tunnel.for.ownerOnly") : errorText(cause),
      )),
    );
    return () => { live = false; };
    // Runs once per target; the handlers it calls only use state setters and refs.
  }, [settingsTarget, refreshTeammates]);

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
  const access = forUserId ? teammateProfile : profile;
  const accessOptions = pairingAccess(t);
  const forName = forUserId ? personName(forUserId) : "";

  return (
    <div className="pkg-tunnel">
      <PageHead blurb={t("tunnel.page.blurb")} />
      {error && !pairingOpen && <ErrorState compact error={error} />}
      {targetError && <ErrorState compact error={targetError} />}

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
          {serverName && (
            <ServerNameFact
              value={serverName}
              t={t}
              onSave={async (name) => {
                setServerName(await api.put<TunnelServerNameDto>("/api/tunnel/server-name", { name }));
              }}
            />
          )}
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
        <Button variant="primary" className="pkg-tunnel-hero-pair" disabled={!status?.pairingAvailable} onClick={() => openPairing()}>
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

      {issued.length > 0 && (
        <Section title={t("tunnel.issued.title")} hint={t("tunnel.issued.hint")}>
          <ul className="pkg-tunnel-devices">
            {issued.map((device) => (
              <IssuedDeviceRow
                key={device.id}
                device={device}
                person={personName(device.accountId)}
                onRevoke={() => void revoke(device)}
                onForget={() => void forget(device)}
                t={t}
                locale={locale}
              />
            ))}
          </ul>
        </Section>
      )}

      <JoinedServers api={api} t={t} {...(settingsTarget ? { settingsTarget } : {})} />

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
          title={!phrase
            ? t("tunnel.dialog.pairTitle")
            : forUserId ? t("tunnel.for.confirmTitle", { name: forName }) : t("tunnel.dialog.confirmTitle")}
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
                <Button variant={expired ? "primary" : "ghost"} disabled={busy || !status?.pairingAvailable} onClick={() => void issueOffer(access, forUserId, offer?.pairing.id ?? null)}>
                  {t("tunnel.dialog.newCode")}
                </Button>
              )}
            </>
          )}
        >
          {!phrase && teammates && teammates.length > 0 && (
            <div className="pkg-tunnel-for">
              <span aria-hidden="true">{t("tunnel.for.label")}</span>
              <Select
                label={t("tunnel.for.label")}
                value={forUserId ? `${FOR_PREFIX}${forUserId}` : FOR_SELF}
                options={[
                  { value: FOR_SELF, label: t("tunnel.for.me") },
                  ...teammates.map((person) => ({ value: `${FOR_PREFIX}${person.id}`, label: personName(person.id) })),
                ]}
                disabled={busy}
                onChange={(value) => {
                  const next = value.startsWith(FOR_PREFIX) ? value.slice(FOR_PREFIX.length) : "";
                  if (next !== forUserId) pairFor(next);
                }}
              />
            </div>
          )}
          {forUserId && !phrase && (
            <p className="pkg-tunnel-for-notice">{t("tunnel.for.notice", { name: forName })}</p>
          )}
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
                {expired
                  ? t("tunnel.dialog.expired")
                  : forUserId ? t("tunnel.for.send", { name: forName }) : t("tunnel.dialog.scan")}
              </p>
              <p className="pkg-tunnel-meta">
                {offer.numericCode && numericSeconds !== 0 && (
                  <>{t("tunnel.dialog.sameNetwork", { code: offer.numericCode })} </>
                )}
                {offerSeconds !== null && offerSeconds > 0 && <>{t("tunnel.dialog.expiresIn", { time: clock(offerSeconds) })}</>}
              </p>
              {!expired && offer.qrPayload && (
                <p className="pkg-tunnel-computer">
                  <span>{t("tunnel.dialog.computer")}</span>
                  <CopyPairingLink link={offer.qrPayload} t={t} />
                </p>
              )}
              <details className="pkg-tunnel-access">
                <summary>{t("tunnel.dialog.accessSummary", { access: accessOptions.find(([id]) => id === access)?.[1] ?? "" })}</summary>
                <Seg label={t("tunnel.dialog.accessAria")} value={access} options={accessOptions} disabled={busy} onChange={changeAccess} />
                <p className="pkg-tunnel-meta">{t(forUserId ? "tunnel.for.accessHint" : "tunnel.dialog.accessHint")}</p>
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
                  ? t(forUserId ? "tunnel.for.confirmed" : "tunnel.dialog.confirmed", { device: pairing.device?.label || t("tunnel.dialog.phoneFallback"), name: forName })
                  : forUserId ? t("tunnel.for.checkWords", { name: forName }) : t("tunnel.dialog.checkWords")}
              </p>
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}
