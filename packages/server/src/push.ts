// F18 web push: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291),
// all node:crypto — no push libraries. Keys are generated once into the data
// dir; subscriptions persist beside them; payloads reuse the same allowlisted
// template semantics the in-page notifier ships (bounded, control-stripped).
import {
  createCipheriv, createECDH, createPrivateKey, generateKeyPairSync,
  hkdfSync, randomBytes, sign as cryptoSign,
  type JsonWebKey as CryptoJwk,
} from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonObject, SessionProjection } from "@polyth/contracts";

// ---- base64url helpers ---------------------------------------------------------

export const b64u = (buf: Buffer | Uint8Array): string => Buffer.from(buf).toString("base64url");
export const b64uDecode = (s: string): Buffer => Buffer.from(s, "base64url");

// ---- payload encryption (RFC 8291, aes128gcm) -----------------------------------

const uint32BE = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** Encrypt one push message for a subscription's (p256dh, auth) pair.
 *  Returns the full aes128gcm body: header ‖ ciphertext ‖ tag. */
export function encryptWebPush(p256dhB64: string, authB64: string, plaintext: Buffer): Buffer {
  const uaPublic = b64uDecode(p256dhB64);
  const authSecret = b64uDecode(authB64);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("p256dh must be an uncompressed P-256 point");
  if (authSecret.length !== 16) throw new Error("auth must be 16 bytes");

  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const prkInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", sharedSecret, authSecret, prkInfo, 32));
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 marks the (only) record's end per RFC 8188/8291.
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.concat([salt, uint32BE(4096), Buffer.from([asPublic.length]), asPublic]);
  return Buffer.concat([header, sealed]);
}

// ---- VAPID (RFC 8292) --------------------------------------------------------------

export interface VapidKeys {
  /** base64url uncompressed P-256 point — the applicationServerKey. */
  publicKey: string;
  privateJwk: CryptoJwk;
}

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" }) as CryptoJwk;
  const point = Buffer.concat([Buffer.from([4]), b64uDecode(jwk.x!), b64uDecode(jwk.y!)]);
  return { publicKey: b64u(point), privateJwk: jwk };
}

/** `Authorization: vapid t=<ES256 JWT>, k=<publicKey>` for one push origin. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, contact: string, now = Date.now): string {
  const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64u(Buffer.from(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now() / 1000) + 12 * 3600,
    sub: contact,
  })));
  const data = `${head}.${payload}`;
  const key = createPrivateKey({ key: keys.privateJwk, format: "jwk" });
  const sig = cryptoSign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${data}.${b64u(sig)}, k=${keys.publicKey}`;
}

// ---- template payloads --------------------------------------------------------------

export type PushKind = "completed" | "failed" | "question" | "permission" | "subagent";

const STATUS_TEXT: Record<PushKind, string> = {
  completed: "finished",
  failed: "failed",
  question: "has a question for you",
  permission: "needs a permission decision",
  subagent: "delegated agent finished",
};

const MAX_VAR_CHARS = 80;
const MAX_BODY_CHARS = 200;

// Same allowlisted-variable semantics as the in-page notifier: unknown {vars}
// stay literal, values are control-stripped and capped, output is bounded.
const clip = (raw: string, cap: number): string => {
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, " ");
  return clean.length > cap ? `${clean.slice(0, cap)}…` : clean;
};

export interface PushPayload extends JsonObject {
  kind: PushKind;
  /** Session activated on notification click (the parent for subagent kinds). */
  sessionId: string;
  title: string;
  body: string;
  /** Notification tag: repeats per (session, kind) replace instead of piling up. */
  tag: string;
}

export function buildPushPayload(kind: PushKind, opts: {
  sessionId: string;
  sessionTitle: string;
  projectName?: string;
  statusText?: string;
}): PushPayload {
  const session = clip(opts.sessionTitle || "Session", MAX_VAR_CHARS);
  const status = clip(opts.statusText ?? STATUS_TEXT[kind], MAX_VAR_CHARS);
  return {
    kind,
    sessionId: opts.sessionId,
    title: clip(`Polyth — ${session}`, MAX_VAR_CHARS + 10),
    body: clip(`${session} — ${status}`, MAX_BODY_CHARS),
    tag: `polyth-${opts.sessionId}-${kind}`,
  };
}

// ---- push service --------------------------------------------------------------------

export interface PushSubscriptionDto {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushService {
  publicKey(): string;
  subscribe(raw: unknown): PushSubscriptionDto;
  unsubscribe(endpoint: string): boolean;
  count(): number;
  /** Encrypt + POST to every subscription; dead endpoints (404/410) drop. */
  send(payload: PushPayload): Promise<{ sent: number; dropped: number }>;
}

interface PushFile {
  vapid: VapidKeys;
  subs: PushSubscriptionDto[];
}

const isHttpsOrLoopback = (endpoint: string): boolean => {
  try {
    const u = new URL(endpoint);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1");
  } catch {
    return false;
  }
};

export function createPushService(opts: {
  file: string;
  contact?: string;
  fetchFn?: typeof fetch;
}): PushService {
  const contact = opts.contact ?? "mailto:polyth@localhost";
  const fetchFn = opts.fetchFn ?? fetch;

  let state: PushFile | null = null;
  try {
    const raw = JSON.parse(readFileSync(opts.file, "utf8")) as Partial<PushFile>;
    if (raw.vapid?.publicKey && raw.vapid.privateJwk) {
      state = {
        vapid: raw.vapid,
        subs: Array.isArray(raw.subs)
          ? raw.subs.filter((s): s is PushSubscriptionDto =>
              !!s && typeof s.endpoint === "string" &&
              typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string")
          : [],
      };
    }
  } catch { /* first boot */ }

  const save = (): void => {
    if (!state) return;
    mkdirSync(dirname(opts.file), { recursive: true });
    writeFileSync(opts.file, `${JSON.stringify(state, null, 2)}\n`);
  };

  // VAPID keys are minted once and reused forever — rotating them would orphan
  // every existing browser subscription.
  const ensure = (): PushFile => {
    if (!state) {
      state = { vapid: generateVapidKeys(), subs: [] };
      save();
    }
    return state;
  };

  return {
    publicKey: () => ensure().vapid.publicKey,

    subscribe(raw) {
      const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
      const endpoint = typeof r?.endpoint === "string" ? r.endpoint : "";
      const p256dh = typeof r?.keys?.p256dh === "string" ? r.keys.p256dh : "";
      const auth = typeof r?.keys?.auth === "string" ? r.keys.auth : "";
      if (!isHttpsOrLoopback(endpoint)) {
        throw Object.assign(new Error("subscription endpoint must be https"), { code: "invalid-input" });
      }
      if (b64uDecode(p256dh).length !== 65 || b64uDecode(auth).length !== 16) {
        throw Object.assign(new Error("subscription keys are malformed"), { code: "invalid-input" });
      }
      const s = ensure();
      const sub: PushSubscriptionDto = { endpoint, keys: { p256dh, auth } };
      s.subs = [...s.subs.filter((x) => x.endpoint !== endpoint), sub];
      save();
      return sub;
    },

    unsubscribe(endpoint) {
      const s = ensure();
      const before = s.subs.length;
      s.subs = s.subs.filter((x) => x.endpoint !== endpoint);
      if (s.subs.length !== before) save();
      return s.subs.length !== before;
    },

    count: () => ensure().subs.length,

    async send(payload) {
      const s = ensure();
      if (s.subs.length === 0) return { sent: 0, dropped: 0 };
      const plaintext = Buffer.from(JSON.stringify(payload));
      let sent = 0;
      const dead: string[] = [];
      await Promise.all(s.subs.map(async (sub) => {
        try {
          const res = await fetchFn(sub.endpoint, {
            method: "POST",
            headers: {
              authorization: vapidAuthorization(sub.endpoint, s.vapid, contact),
              "content-encoding": "aes128gcm",
              "content-type": "application/octet-stream",
              ttl: "300",
              urgency: "normal",
            },
            body: new Uint8Array(encryptWebPush(sub.keys.p256dh, sub.keys.auth, plaintext)),
          });
          if (res.status === 404 || res.status === 410) dead.push(sub.endpoint);
          else if (res.ok || res.status === 201) sent++;
        } catch { /* transient network failure: keep the subscription */ }
      }));
      if (dead.length) {
        s.subs = s.subs.filter((x) => !dead.includes(x.endpoint));
        save();
      }
      return { sent, dropped: dead.length };
    },
  };
}

// ---- session-event notifier -----------------------------------------------------------

/** Bridges the session service's notify seam to push payloads. Subagent
 *  completions attribute to the parent session (same as the in-page router);
 *  aborted turns stay silent. Fire-and-forget: push must never block a turn. */
export function createPushNotifier(deps: {
  send(payload: PushPayload): Promise<unknown>;
  projection(sessionId: string): Promise<SessionProjection | undefined>;
  projectName?(projectId: string): Promise<string | undefined>;
}): {
  attention(sessionId: string, kind: "permission" | "question"): void;
  turnStopped(sessionId: string, reason: "completed" | "aborted" | "error"): void;
} {
  const fire = (p: Promise<unknown>): void => {
    void p.catch((err: unknown) => console.error("[polyth] push send failed", err));
  };

  return {
    attention(sessionId, kind) {
      fire((async () => {
        const proj = await deps.projection(sessionId);
        if (!proj) return;
        await deps.send(buildPushPayload(kind, { sessionId, sessionTitle: proj.title }));
      })());
    },
    turnStopped(sessionId, reason) {
      if (reason === "aborted") return;
      fire((async () => {
        const proj = await deps.projection(sessionId);
        if (!proj) return;
        if (proj.parentId) {
          const parent = await deps.projection(proj.parentId);
          await deps.send(buildPushPayload("subagent", {
            sessionId: proj.parentId,
            sessionTitle: parent?.title ?? "Delegated agent",
            statusText: reason === "error" ? "delegated agent failed" : "delegated agent finished",
          }));
          return;
        }
        await deps.send(buildPushPayload(reason === "error" ? "failed" : "completed", {
          sessionId,
          sessionTitle: proj.title,
        }));
      })());
    },
  };
}
