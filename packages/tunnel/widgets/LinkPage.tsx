import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GrantProfileId,
  PairingOfferDto,
  PairingStateDto,
  TunnelDeviceDto,
  TunnelStatusDto,
} from "@polyth/contracts";
import { GRANT_PROFILE_PRESETS } from "@polyth/contracts";
import { createApiTransport } from "@polyth/web-sdk";
import { EmptyState, PageHead } from "../../../apps/web/src/components/settings/parts.tsx";
import { Button, Dialog, Select, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import CopyButton from "../../../apps/web/src/components/CopyButton.tsx";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { applyTunnelStatusToCapability } from "./availability.ts";

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

const PROFILE_OPTIONS: Array<{ value: GrantProfileId; label: string }> = [
  { value: "observe", label: "Observe" },
  { value: "interact", label: "Interact" },
  { value: "developer", label: "Developer" },
  { value: "full-remote", label: "Full remote control" },
];

function hostReadiness(status: TunnelStatusDto | null): string {
  if (!status) return "Checking host status…";
  if (status.unsupportedPlatform) return "Polyth Link is not supported on this platform.";
  if (!status.hostBinaryFound) return "Host binary not found. Pairing is disabled.";
  if (!status.hostProcessReady) return "Host process is not connected.";
  if (!status.endpointBound) return "Host is running, but no endpoint is bound yet.";
  if (!status.ingressReady) return "Endpoint is bound, but local ingress is not ready.";
  if (!status.identityAvailable) return "Host identity is unavailable.";
  return "Host is ready for pairing.";
}

function policyLabel(status: TunnelStatusDto | null): string {
  const policy = status?.activePolicy ?? null;
  if (policy === "direct-preferred") return "Active policy: direct preferred";
  if (policy) return `Policy ${policy} is not available in this build`;
  return "Active policy: none (endpoint not bound)";
}

function transportLabel(value?: string): string {
  if (value === "direct") return "Connected directly";
  if (value === "relay") return "Connected through encrypted relay";
  return "Offline";
}

function secondsUntil(value: string | undefined, now: number): number | null {
  if (!value) return null;
  const expires = Date.parse(value);
  if (!Number.isFinite(expires)) return null;
  return Math.max(0, Math.ceil((expires - now) / 1_000));
}

function QrMatrix({ modules, payload }: { modules: boolean[][]; payload: string }) {
  return (
    <div className="pkg-tunnel-qr" role="img" aria-label="Pairing QR code">
      <svg viewBox={`0 0 ${modules.length} ${modules.length}`} aria-hidden="true">
        {modules.flatMap((row, y) => row.map((on, x) => on
          ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} />
          : null))}
      </svg>
      <code>{payload}</code>
    </div>
  );
}

export default function LinkPage() {
  const [status, setStatus] = useState<TunnelStatusDto | null>(null);
  const [devices, setDevices] = useState<TunnelDeviceDto[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [profile, setProfile] = useState<GrantProfileId>("interact");
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [pairing, setPairing] = useState<PairingStateDto | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pairingIdRef = useRef<string | null>(null);
  pairingIdRef.current = offer?.pairing.id ?? null;

  const reload = useCallback(async () => {
    try {
      const [nextStatus, nextDevices] = await Promise.all([
        api.get<TunnelStatusDto>("/api/tunnel/status"),
        api.get<TunnelDeviceDto[]>("/api/tunnel/devices").catch(() => [] as TunnelDeviceDto[]),
      ]);
      setStatus(nextStatus);
      applyTunnelStatusToCapability(nextStatus);
      setDevices(nextDevices);
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (!offer?.numericExpiresAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [offer?.numericExpiresAt]);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${proto}://${location.host}/ws/tunnel`);
    const onMessage = (event: MessageEvent<string>) => {
      let parsed: { type?: string };
      try {
        parsed = JSON.parse(String(event.data)) as { type?: string };
      } catch {
        return;
      }
      const type = parsed.type ?? "";
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
      if (type.startsWith("tunnel/device") || type === "tunnel/identity-rotated") {
        void reload();
      }
    };
    socket.addEventListener("message", onMessage);
    return () => {
      socket.removeEventListener("message", onMessage);
      socket.close();
    };
  }, [reload]);

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

  const createPairing = async (): Promise<PairingOffer> => {
    return api.post<PairingOffer>("/api/tunnel/pairing", { label, profile });
  };

  const startPairing = async () => {
    setBusy(true);
    setError("");
    try {
      const created = await createPairing();
      setOffer(created);
      setPairing(created.pairing as unknown as PairingStateDto);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const regeneratePairing = async () => {
    if (!offer) return;
    setBusy(true);
    setError("");
    try {
      await api.delete(`/api/tunnel/pairing/${offer.pairing.id}`);
      const created = await createPairing();
      setOffer(created);
      setPairing(created.pairing as unknown as PairingStateDto);
    } catch (cause) {
      setError(errorText(cause));
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
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!offer) return;
    await api.post(`/api/tunnel/pairing/${offer.pairing.id}/reject`).catch(() => {});
    setPairingOpen(false);
    setOffer(null);
    setPairing(null);
  };

  const revoke = async (device: TunnelDeviceDto) => {
    if (!await confirmAlert(`Revoke “${device.label}”? Active connections close immediately.`, {
      title: "Revoke device",
      confirmLabel: "Revoke",
    })) return;
    await api.post(`/api/tunnel/devices/${device.id}/revoke`);
    await reload();
  };

  const forget = async (device: TunnelDeviceDto) => {
    await api.delete(`/api/tunnel/devices/${device.id}`);
    await reload();
  };

  const rotate = async () => {
    if (!await confirmAlert("Rotate the host identity? Every paired device must scan a new QR code.", {
      title: "Rotate host identity",
      confirmLabel: "Rotate",
    })) return;
    await api.post("/api/tunnel/identity/rotate");
    await reload();
  };

  const phrase = pairing?.safetyPhrase ?? null;
  const canAllow = Boolean(pairing?.deviceConfirmed) && pairing?.state !== "committed";
  const numericSeconds = secondsUntil(offer?.numericExpiresAt, now);

  return (
    <div className="pkg-tunnel">
      <PageHead title="Polyth Link" blurb="Pair a phone with a short-lived QR or six-digit code. Both bootstrap the same pinned Polyth Link trust flow; the code is never sent as a plaintext credential." />
      {error && <div className="pkg-tunnel-error" role="alert">{error}</div>}
      <section className="pkg-tunnel-status">
        <div>
          <strong>This computer</strong>
          <span>{hostReadiness(status)}</span>
          <span>{policyLabel(status)}</span>
          <span>{status?.identityAvailable ? `Fingerprint ${status.hostFingerprint}` : status?.identityError ?? "Host identity unavailable"}</span>
          {status?.lastErrorCode && <span>Last error: {status.lastErrorCode}</span>}
        </div>
        {status?.hostFingerprint && <CopyButton text={status.hostFingerprint} label="Copy fingerprint" />}
      </section>
      <div className="pkg-tunnel-actions">
        <Button
          variant="primary"
          disabled={!status?.pairingAvailable}
          onClick={() => { setPairingOpen(true); setOffer(null); setPairing(null); }}
        >
          Pair device
        </Button>
        <Button disabled={!status?.hostProcessReady} onClick={() => void rotate()}>Rotate host identity</Button>
      </div>
      {devices.length === 0 ? (
        <EmptyState title="No paired devices" body="Create a pairing invitation, then scan the QR or enter its six-digit code in the Polyth mobile app. Compare the four words before allowing the device." />
      ) : (
        <ul className="pkg-tunnel-devices">
          {devices.map((device) => (
            <li key={device.id}>
              <div>
                <strong>{device.label}</strong>
                <span>{device.online ? transportLabel(device.lastTransport) : "Offline"} · {device.endpointFingerprint} · {device.grants.length} grants</span>
              </div>
              <div>
                {!device.revokedAt && <Button size="sm" variant="danger" onClick={() => void revoke(device)}>Revoke</Button>}
                {device.revokedAt && <Button size="sm" onClick={() => void forget(device)}>Forget</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {pairingOpen && (
        <Dialog
          title="Pair device"
          onClose={() => { void reject(); }}
          footer={offer ? (
            <>
              <Button disabled={busy} onClick={() => void regeneratePairing()}>Generate new code</Button>
              <Button disabled={busy} onClick={() => void reject()}>Reject</Button>
              <Button variant="primary" disabled={!canAllow || busy} onClick={() => void approve()}>
                Allow device
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => setPairingOpen(false)}>Cancel</Button>
              <Button variant="primary" busy={busy} onClick={() => void startPairing()}>Create invitation</Button>
            </>
          )}
        >
          {!offer && (
            <div className="pkg-tunnel-form">
              <label className="pkg-tunnel-field">
                <span>Device label</span>
                <TextInput value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Optional" />
              </label>
              <Select label="Access profile" value={profile} options={PROFILE_OPTIONS} onChange={(value) => setProfile(value as GrantProfileId)} />
              <p>Default access is Interact. Full remote control still cannot manage pairing, grants, or host identity.</p>
            </div>
          )}
          {offer && (
            <div className="pkg-tunnel-pair">
              {offer.qrModules && offer.qrModules.length > 0
                ? <QrMatrix modules={offer.qrModules} payload={offer.qrPayload} />
                : <code className="pkg-tunnel-code">{offer.qrPayload}</code>}
              {offer.numericCode && (
                <div className="pkg-tunnel-numeric">
                  <span>Or enter this code on your phone</span>
                  <div>
                    <strong>{offer.numericCode}</strong>
                    <CopyButton text={offer.numericCode.replace(/\s+/g, "")} label="Copy pairing code" />
                  </div>
                  <span>
                    {numericSeconds === null
                      ? "Short-lived pairing code"
                      : numericSeconds > 0
                        ? `Expires in ${numericSeconds}s`
                        : "Code expired — generate a new code"}
                  </span>
                </div>
              )}
              {phrase ? (
                <ol className="pkg-tunnel-phrase">
                  {phrase.map((word) => <li key={word}>{word}</li>)}
                </ol>
              ) : (
                <p>Waiting for the phone to connect securely…</p>
              )}
              <p>
                {pairing?.deviceConfirmed ? "The phone confirmed the words. Allow this device to finish pairing." : "Allow stays disabled until the phone confirms the same four words."}
              </p>
              <p className="pkg-tunnel-grants">{GRANT_PROFILE_PRESETS[profile].join(", ")}</p>
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}