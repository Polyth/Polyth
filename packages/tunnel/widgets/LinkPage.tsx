import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GrantProfileId,
  PairingOfferDto,
  PairingStateDto,
  PolythLinkPathPolicy,
  TunnelDeviceDto,
  TunnelStatusDto,
} from "@polyth/contracts";
import { GRANT_PROFILE_PRESETS } from "@polyth/contracts";
import { createApiTransport } from "@polyth/web-sdk";
import { EmptyState, PageHead } from "../../../apps/web/src/components/settings/parts.tsx";
import { Button, Dialog, Select, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import CopyButton from "../../../apps/web/src/components/CopyButton.tsx";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";

const api = createApiTransport({
  fetch: (url, init) => fetch(url, { credentials: "include", ...init }),
});

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const PROFILE_OPTIONS: Array<{ value: GrantProfileId; label: string }> = [
  { value: "observe", label: "Observe" },
  { value: "interact", label: "Interact" },
  { value: "developer", label: "Developer" },
  { value: "full-remote", label: "Full remote control" },
];

const MODE_OPTIONS: Array<{ value: PolythLinkPathPolicy; label: string }> = [
  { value: "direct-preferred", label: "Direct preferred" },
  { value: "relay-only", label: "Encrypted relay only" },
  { value: "air-gapped", label: "Air-gapped" },
];

function transportLabel(value?: string): string {
  if (value === "direct") return "Connected directly";
  if (value === "relay") return "Connected through encrypted relay";
  return "Offline";
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
  const [mode, setMode] = useState<PolythLinkPathPolicy>("direct-preferred");
  const [offer, setOffer] = useState<(PairingOfferDto & { qrModules?: boolean[][] }) | null>(null);
  const [pairing, setPairing] = useState<PairingStateDto | null>(null);
  const pairingIdRef = useRef<string | null>(null);
  pairingIdRef.current = offer?.pairing.id ?? null;

  const reload = useCallback(async () => {
    try {
      const [nextStatus, nextDevices] = await Promise.all([
        api.get<TunnelStatusDto>("/api/tunnel/status"),
        api.get<TunnelDeviceDto[]>("/api/tunnel/devices").catch(() => [] as TunnelDeviceDto[]),
      ]);
      setStatus(nextStatus);
      setDevices(nextDevices);
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

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

  const startPairing = async () => {
    setBusy(true);
    setError("");
    try {
      const created = await api.post<PairingOfferDto & { qrModules?: boolean[][] }>("/api/tunnel/pairing", {
        label, profile, mode,
      });
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

  return (
    <div className="pkg-tunnel">
      <PageHead title="Polyth Link" blurb="Pair a phone with a short-lived QR code. Remote access uses authenticated Iroh, never a password in the QR." />
      {error && <div className="pkg-tunnel-error" role="alert">{error}</div>}
      <section className="pkg-tunnel-status">
        <div>
          <strong>This computer</strong>
          <span>{status?.identityAvailable ? `Fingerprint ${status.hostFingerprint}` : status?.identityError ?? "Host identity unavailable"}</span>
          <span>{status?.mode === "relay-only" ? "Encrypted relay only" : status?.mode === "air-gapped" ? "Air-gapped" : "Direct preferred, relay fallback"}</span>
        </div>
        {status?.hostFingerprint && <CopyButton text={status.hostFingerprint} label="Copy fingerprint" />}
      </section>
      <div className="pkg-tunnel-actions">
        <Button variant="primary" onClick={() => { setPairingOpen(true); setOffer(null); setPairing(null); }}>Pair device</Button>
        <Button onClick={() => void rotate()}>Rotate host identity</Button>
      </div>
      {devices.length === 0 ? (
        <EmptyState title="No paired devices" body="Create a QR code, scan it from the Polyth mobile app, then compare the four words on both screens." />
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
              <Button onClick={() => void reject()}>Reject</Button>
              <Button variant="primary" disabled={!canAllow || busy} onClick={() => void approve()}>
                Allow device
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => setPairingOpen(false)}>Cancel</Button>
              <Button variant="primary" busy={busy} onClick={() => void startPairing()}>Create QR</Button>
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
              <Select label="Connection policy" value={mode} options={MODE_OPTIONS} onChange={(value) => setMode(value as PolythLinkPathPolicy)} />
              <p>Default access is Interact. Full remote control still cannot manage pairing, grants, or host identity.</p>
            </div>
          )}
          {offer && (
            <div className="pkg-tunnel-pair">
              {offer.qrModules && offer.qrModules.length > 0
                ? <QrMatrix modules={offer.qrModules} payload={offer.qrPayload} />
                : <code className="pkg-tunnel-code">{offer.qrPayload}</code>}
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
