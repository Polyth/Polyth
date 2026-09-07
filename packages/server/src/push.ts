// F18 web push: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291),
// all node:crypto — no push libraries. Keys are generated once into the data
// dir; subscriptions persist beside them; payloads reuse the same allowlisted
// template semantics the in-page notifier ships (bounded, control-stripped).
import {
  createCipheriv, createECDH, createPrivateKey, generateKeyPairSync,
  hkdfSync, randomBytes, sign as cryptoSign,
  type JsonWebKey as CryptoJwk,
} from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";
import type { JsonObject, NotificationKind, SessionProjection } from "@polyth/contracts";

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

export type PushKind = NotificationKind;

const STATUS_TEXT: Record<PushKind, string> = {
  completed: "finished",
  failed: "failed",
  question: "has a question for you",
  permission: "needs a permission decision",
  subagent: "delegated agent finished",
};

const MAX_VAR_CHARS = 80;
const MAX_BODY_CHARS = 200;

// NTF-01: same secret redaction as the in-page formatter — payloads persist in
// the notification centre now, so a secret-shaped session title must never
// reach the inbox file, the WS envelope, or a push endpoint.
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk|ghp|gho|ghu|ghs|xoxb|xoxp|AKIA)[A-Za-z0-9_-]{12,}\b/g,
  // whole header line: "authorization: Bearer x" must not leave the token behind
  /\b(authorization|proxy-authorization)\s*[:=][^\n]+/gi,
  /\b(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*\S+/gi,
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
];

function redactPushText(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, "[redacted]");
  return out;
}

// Same allowlisted-variable semantics as the in-page notifier: unknown {vars}
// stay literal, values are control-stripped, redacted, and capped.
const clip = (raw: string, cap: number): string => {
  // eslint-disable-next-line no-control-regex
  const clean = redactPushText(raw.replace(/[\u0000-\u001f\u007f]/g, " "));
  return clean.length > cap ? `${clean.slice(0, cap)}…` : clean;
};

export interface PushQuickAnswer extends JsonObject {
  title: string;
  answers: JsonObject;
}

export type PushPayload = JsonObject & {
  kind: PushKind;
  /** Session activated on notification click (the parent for subagent kinds). */
  sessionId: string;
  title: string;
  body: string;
  /** Notification tag: repeats of one transition replace instead of piling up. */
  tag: string;
  /** Stable transition key (NTF-01), copied verbatim into the inbox record.
   *  Empty ONLY on the /api/push/test path, which never records a row. */
  key: string;
  /** Trusted source project (NTF-01), read from the canonical projection.
   *  Empty only on the keyless test path. */
  projectId: string;
  /** Pending request identity. The service worker sends actions only when this
   *  is present; the authenticated session API still validates it is open. */
  requestId?: string;
  /** Direct answers are deliberately limited to one single-choice question
   *  with at most two closed options (the practical notification action cap). */
  quickAnswers?: PushQuickAnswer[];
};

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

function quickAnswersFor(questions: JsonObject[] | undefined): PushQuickAnswer[] {
  if (!questions || questions.length !== 1) return [];
  const question = questions[0]!;
  if (
    question.type === "multi"
    || question.multiple === true
    || question.multi === true
    || question.allowOther === true
    || question.other === true
  ) return [];
  const rawOptions = Array.isArray(question.options)
    ? question.options
    : Array.isArray(question.choices) ? question.choices : [];
  if (rawOptions.length < 1 || rawOptions.length > 2) return [];
  const questionId = stringValue(question.id) ?? "q1";
  const answers: PushQuickAnswer[] = [];
  for (const raw of rawOptions) {
    if (typeof raw === "string") {
      if (!raw) return [];
      answers.push({ title: clip(raw, 36), answers: { [questionId]: raw } });
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const option = raw as JsonObject;
    const value = stringValue(option.value) ?? stringValue(option.id) ?? stringValue(option.label);
    if (!value) return [];
    answers.push({
      title: clip(stringValue(option.label) ?? value, 36),
      answers: { [questionId]: value },
    });
  }
  return answers;
}

export function buildPushPayload(kind: PushKind, opts: {
  sessionId: string;
  sessionTitle: string;
  projectName?: string;
  statusText?: string;
  key?: string;
  projectId?: string;
  requestId?: string;
  questions?: JsonObject[];
}): PushPayload {
  const session = clip(opts.sessionTitle || "Session", MAX_VAR_CHARS);
  const status = clip(opts.statusText ?? STATUS_TEXT[kind], MAX_VAR_CHARS);
  const quickAnswers = kind === "question" ? quickAnswersFor(opts.questions) : [];
  return {
    kind,
    sessionId: opts.sessionId,
    title: clip(`Polyth — ${session}`, MAX_VAR_CHARS + 10),
    body: clip(`${session} — ${status}`, MAX_BODY_CHARS),
    // The OS/browser tag derives from the stable key when one exists so
    // centre rows and native notifications correlate; the keyless test path
    // keeps the legacy (session, kind) tag.
    tag: opts.key ? `polyth-${opts.key}` : `polyth-${opts.sessionId}-${kind}`,
    key: opts.key ?? "",
    projectId: opts.projectId ?? "",
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    ...(quickAnswers.length > 0 ? { quickAnswers } : {}),
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
    atomicWriteSync(opts.file, `${JSON.stringify(state, null, 2)}\n`, 0o600);
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
 *  aborted turns stay silent. Fire-and-forget: push must never block a turn.
 *
 *  NTF-01: this seam is the ONLY producer of notification-centre records —
 *  every payload it emits carries the stable transition `key` and the trusted
 *  source `projectId`, and calls `deps.send` exactly once per transition. */
export function createPushNotifier(deps: {
  send(payload: PushPayload): Promise<unknown>;
  projection(sessionId: string): Promise<SessionProjection | undefined>;
  projectName?(projectId: string): Promise<string | undefined>;
  /** Durable unresolved-request counters: question/permission keys derive
   *  from the already-appended request state, never from a snapshot diff. */
  attention?(sessionId: string): Promise<{ questions: number; permissions: number } | undefined>;
}): {
  attention(sessionId: string, kind: "permission" | "question", requestId?: string, questions?: JsonObject[]): void;
  turnStopped(sessionId: string, reason: "completed" | "aborted" | "error"): void;
} {
  const fire = (p: Promise<unknown>): void => {
    void p.catch((err: unknown) => console.error("[polyth] push send failed", err));
  };

  return {
    attention(sessionId, kind, requestId, questions) {
      fire((async () => {
        const proj = await deps.projection(sessionId);
        if (!proj) return;
        // The request event is durable before notify fires, so the open count
        // already includes it. A missing counter dep degrades to count 1.
        const counts = await deps.attention?.(sessionId);
        const open = Math.max(1, (kind === "question" ? counts?.questions : counts?.permissions) ?? 1);
        await deps.send(buildPushPayload(kind, {
          sessionId,
          sessionTitle: proj.title,
          key: `${sessionId}:${kind}:${open}`,
          projectId: proj.projectId,
          ...(requestId ? { requestId } : {}),
          ...(questions ? { questions } : {}),
        }));
      })());
    },
    turnStopped(sessionId, reason) {
      if (reason === "aborted") return;
      fire((async () => {
        const proj = await deps.projection(sessionId);
        if (!proj) return;
        if (proj.parentId) {
          const parent = await deps.projection(proj.parentId);
          // Parent and child must resolve to the same project before the
          // payload is published (NTF-01); a missing/mismatched parent stays
          // silent rather than creating a row with an unverified target.
          if (!parent || parent.projectId !== proj.projectId) return;
          await deps.send(buildPushPayload("subagent", {
            sessionId: proj.parentId,
            sessionTitle: parent.title,
            statusText: reason === "error" ? "delegated agent failed" : "delegated agent finished",
            key: `${sessionId}:subagent:${reason === "error" ? "failed" : "idle"}`,
            projectId: proj.projectId,
          }));
          return;
        }
        await deps.send(buildPushPayload(reason === "error" ? "failed" : "completed", {
          sessionId,
          sessionTitle: proj.title,
          key: `${sessionId}:turn:${reason === "error" ? "failed" : "idle"}`,
          projectId: proj.projectId,
        }));
      })());
    },
  };
}
