// Web push: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291),
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
import type { JsonObject, NotificationKind, SessionEvent, SessionProjection } from "@polyth/contracts";
import type { NotificationAccount } from "./notifications.ts";

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
  mention: "mentioned you",
  message: "posted a message",
};

const MAX_VAR_CHARS = 80;
const MAX_BODY_CHARS = 200;

/** Bounded content walk for a notification body: at most this many keyset
 *  pages of the store's newest-events window, all within one turn. */
const CONTENT_PAGES = 4;

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

// ---- plain-text excerpts --------------------------------------------------------------

const EXCERPT_INPUT_CHARS = 8000;

/** Plain-text excerpt of a markdown reply for a notification body: fenced
 *  blocks (including ```ui / ```page) are dropped, markdown syntax is reduced
 *  to its text, whitespace collapses, secret-shaped text is redacted, and the
 *  result is at most `cap` chars (ellipsis included) cut on a word boundary.
 *  Intra-word underscores (`user_id`) are never treated as emphasis. Never throws. */
export function plainTextExcerpt(raw: unknown, cap = MAX_BODY_CHARS): string {
  try {
    if (typeof raw !== "string" || cap < 2) return "";
    const lines: string[] = [];
    let fence: string | null = null;
    for (const line of raw.slice(0, EXCERPT_INPUT_CHARS).replace(/\r\n?/g, "\n").split("\n")) {
      const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length) fence = null;
        continue;
      }
      if (open) { fence = open[1]!; continue; }
      if (/^\s*([-*_]\s*){3,}$/.test(line)) continue;
      if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("|")) continue;
      let text = line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*(>\s?)+/, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "");
      if (/^\s*\|.*\|\s*$/.test(text) || (text.match(/\|/g)?.length ?? 0) >= 2) {
        text = text.split("|").map((cell) => cell.trim()).filter(Boolean).join(", ");
      }
      lines.push(text);
    }
    const flat = lines.join(" ")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
      .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      .replace(/`+([^`]*)`+/g, "$1")
      .replace(/\*\*+([^*]+?)\*\*+/g, "$1")
      .replace(/(?<![\w*])\*(?!\s)([^*]+?)(?<!\s)\*(?![\w*])/g, "$1")
      .replace(/(?<![A-Za-z0-9_])__+([^_]+?)__+(?![A-Za-z0-9_])/g, "$1")
      .replace(/(?<![A-Za-z0-9_])_(?!\s)([^_]+?)(?<!\s)_(?![A-Za-z0-9_])/g, "$1")
      .replace(/~~([^~]+?)~~/g, "$1");
    // eslint-disable-next-line no-control-regex
    const clean = redactPushText(flat.replace(/[\u0000-\u001f\u007f]/g, " ")).replace(/\s+/g, " ").trim();
    if (clean.length <= cap) return clean;
    const room = clean.slice(0, cap - 1);
    const space = room.lastIndexOf(" ");
    const cut = space >= (cap - 1) * 0.6 ? room.slice(0, space) : room;
    return `${cut.replace(/[\s,;:.\-–—]+$/, "")}…`;
  } catch {
    return "";
  }
}

const eventText = (event: SessionEvent, key: string): string | undefined => {
  const value = (event.data as JsonObject | undefined)?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
};

/** The agent's closing reply of the newest turn found in a bounded event tail:
 *  the last non-blank `assistant/message` after the newest `turn/started`. */
export function finalReplyFromTail(tail: readonly SessionEvent[]): string | undefined {
  for (let i = tail.length - 1; i >= 0; i--) {
    const event = tail[i]!;
    if (event.type === "turn/started") return undefined;
    if (event.type === "assistant/message") {
      const text = eventText(event, "text");
      if (text) return text;
    }
  }
  return undefined;
}

/** `error` of the newest `turn/stopped` in the tail. */
export function turnErrorFromTail(tail: readonly SessionEvent[]): string | undefined {
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i]!.type === "turn/stopped") return eventText(tail[i]!, "error");
  }
  return undefined;
}

const PERMISSION_VERBS: Record<string, string> = {
  bash: "Run", shell: "Run", exec: "Run", command: "Run",
  edit: "Edit", write: "Edit", patch: "Edit", multiedit: "Edit",
  read: "Read", webfetch: "Fetch", fetch: "Fetch",
};

/** `Run: npm test` / `Edit: src/a.ts` from a durable `permission/requested`
 *  event's fields (permission, patterns, tool, metadata, preview). */
export function permissionSummary(data: JsonObject | undefined): string | undefined {
  if (!data) return undefined;
  const permission = stringValue(data.permission);
  const tool = stringValue(data.tool);
  const metadata = data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
    ? data.metadata as JsonObject : {};
  const patterns = Array.isArray(data.patterns) ? data.patterns.filter((p): p is string => typeof p === "string" && p !== "") : [];
  const preview = data.preview && typeof data.preview === "object" && !Array.isArray(data.preview) ? data.preview as JsonObject : {};
  const previewLine = Array.isArray(preview.lines) ? preview.lines.find((l): l is string => typeof l === "string" && l !== "") : undefined;
  const target = stringValue(metadata.command) ?? stringValue(metadata.cmd)
    ?? stringValue(metadata.filepath) ?? stringValue(metadata.filePath) ?? stringValue(metadata.path)
    ?? patterns[0] ?? previewLine;
  const label = permission === "package-tool"
    ? "Tool"
    : permission ? PERMISSION_VERBS[permission.toLowerCase()] ?? permission : tool;
  if (!label) return undefined;
  const name = permission === "package-tool" ? tool ?? target : target;
  return name ? `${label}: ${name}` : label;
}

/** The first question's text, with "+N more" when several were asked. */
export function questionSummary(questions: readonly JsonObject[] | undefined): string | undefined {
  const first = questions?.[0];
  if (!first) return undefined;
  const more = questions!.length > 1 ? ` (+${questions!.length - 1} more)` : "";
  const text = plainTextExcerpt(
    stringValue(first.prompt) ?? stringValue(first.question) ?? stringValue(first.text)
      ?? stringValue(first.header) ?? stringValue(first.title) ?? "",
    MAX_BODY_CHARS - more.length,
  );
  return text ? `${text}${more}` : undefined;
}

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
  /** Explicit Settings test: service workers display it even with a visible window. */
  test?: true;
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
  /** Plain-text event content (reply excerpt, question, command, error). When
   *  present it replaces the status text as the body; the title still names
   *  the session. Empty/absent keeps the status body exactly. */
  content?: string;
  test?: boolean;
}): PushPayload {
  const session = clip(opts.sessionTitle || "Session", MAX_VAR_CHARS);
  const status = clip(opts.statusText ?? STATUS_TEXT[kind], MAX_VAR_CHARS);
  const quickAnswers = kind === "question" ? quickAnswersFor(opts.questions) : [];
  return {
    kind,
    sessionId: opts.sessionId,
    title: clip(`Polyth — ${session}`, MAX_VAR_CHARS + 10),
    body: opts.content ? clip(opts.content, MAX_BODY_CHARS) : clip(`${session} — ${status}`, MAX_BODY_CHARS),
    // The OS/browser tag derives from the stable key when one exists so
    // centre rows and native notifications correlate; the keyless test path
    // keeps the legacy (session, kind) tag.
    tag: opts.key ? `polyth-${opts.key}` : `polyth-${opts.sessionId}-${kind}`,
    key: opts.key ?? "",
    projectId: opts.projectId ?? "",
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    ...(quickAnswers.length > 0 ? { quickAnswers } : {}),
    ...(opts.test ? { test: true as const } : {}),
  };
}

// ---- push service --------------------------------------------------------------------

export interface PushSubscriptionDto {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushService {
  publicKey(): string;
  subscribe(account: NotificationAccount, raw: unknown): PushSubscriptionDto;
  /** Isolated legacy test seam; persisted rows still receive an owner. */
  subscribe(raw: unknown): PushSubscriptionDto;
  unsubscribe(account: NotificationAccount, endpoint: string): boolean;
  unsubscribe(endpoint: string): boolean;
  count(account: NotificationAccount): number;
  count(): number;
  /** Internal account-deletion hook. */
  removeAccount(userId: string): number;
  /** Encrypt + POST to every subscription; dead endpoints (404/410) drop.
   *  `failed` counts other rejections and network errors (kept, logged). */
  send(account: NotificationAccount, payload: PushPayload): Promise<PushSendResult>;
  send(payload: PushPayload): Promise<PushSendResult>;
}

export interface PushSendResult {
  sent: number;
  dropped: number;
  failed: number;
  /** Server-internal: which endpoints dropped. Never sent to a client. */
  droppedEndpoints: string[];
}

const MAX_LOG_DETAIL_CHARS = 200;

/** A push endpoint URL is a bearer capability: logs name only its host. */
const endpointHost = (endpoint: string): string => {
  try {
    return new URL(endpoint).host;
  } catch {
    return "invalid-endpoint";
  }
};

const logDetail = (raw: string): string =>
  // eslint-disable-next-line no-control-regex
  redactPushText(raw.replace(/[\u0000-\u001f\u007f]/g, " ")).replace(/\s+/g, " ").trim().slice(0, MAX_LOG_DETAIL_CHARS);

async function responseDetail(res: Response): Promise<string> {
  try {
    return typeof res.text === "function" ? logDetail(await res.text()) : "";
  } catch {
    return "";
  }
}

interface StoredPushSubscription extends PushSubscriptionDto {
  recipient: NotificationAccount;
}

interface PushFile {
  vapid: VapidKeys;
  subs: StoredPushSubscription[];
}

const LEGACY_TEST_ACCOUNT: NotificationAccount = { userId: "__isolated_test__", spaceId: "__isolated_test__" };
const sameAccount = (left: NotificationAccount, right: NotificationAccount): boolean =>
  left.userId === right.userId && left.spaceId === right.spaceId;
const validAccount = (value: unknown): value is NotificationAccount => {
  if (!value || typeof value !== "object") return false;
  const raw = value as { userId?: unknown; spaceId?: unknown };
  return typeof raw.userId === "string" && raw.userId.length > 0 && typeof raw.spaceId === "string" && raw.spaceId.length > 0;
};

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
  /** Durable Space membership check for subscription mutation and delivery. */
  hasAccess?: (account: NotificationAccount) => boolean;
  /** Diagnostic sink for push-service rejections; defaults to console.warn. */
  log?: (line: string) => void;
}): PushService {
  const contact = opts.contact ?? "mailto:polyth@localhost";
  const fetchFn = opts.fetchFn ?? fetch;
  const hasAccess = opts.hasAccess ?? (() => true);
  const log = opts.log ?? ((line: string) => console.warn(line));

  let state: PushFile | null = null;
  try {
    const raw = JSON.parse(readFileSync(opts.file, "utf8")) as Partial<PushFile>;
    if (raw.vapid?.publicKey && raw.vapid.privateJwk) {
      state = {
        vapid: raw.vapid,
        // Legacy global subscriptions have no owner and are deliberately
        // discarded rather than assigned to the installation owner.
        subs: Array.isArray(raw.subs)
          ? raw.subs.filter((s): s is StoredPushSubscription =>
              !!s && typeof s.endpoint === "string" &&
              typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string" && validAccount(s.recipient))
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

    subscribe(first: NotificationAccount | unknown, second?: unknown) {
      const account = second === undefined ? LEGACY_TEST_ACCOUNT : first as NotificationAccount;
      const raw = second === undefined ? first : second;
      if (!validAccount(account) || !hasAccess(account)) throw Object.assign(new Error("subscription account is invalid"), { code: "invalid-input" });
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
      const sub: StoredPushSubscription = { endpoint, keys: { p256dh, auth }, recipient: { ...account } };
      const current = s.subs.find((entry) => entry.endpoint === endpoint);
      if (current
        && sameAccount(current.recipient, account)
        && current.keys.p256dh === p256dh
        && current.keys.auth === auth) {
        return { endpoint: current.endpoint, keys: current.keys };
      }
      // A browser push endpoint is one delivery destination, never a shared
      // credential. An authenticated re-subscribe atomically transfers it to
      // the current account; scoped unsubscribe still cannot remove another
      // account's current row.
      s.subs = [...s.subs.filter((x) => x.endpoint !== endpoint), sub];
      save();
      return { endpoint: sub.endpoint, keys: sub.keys };
    },

    unsubscribe(first: NotificationAccount | string, second?: string) {
      const account = second === undefined ? LEGACY_TEST_ACCOUNT : first as NotificationAccount;
      const endpoint = second === undefined ? first as string : second;
      if (!validAccount(account) || !hasAccess(account)) return false;
      const s = ensure();
      const before = s.subs.length;
      s.subs = s.subs.filter((x) => !(x.endpoint === endpoint && sameAccount(x.recipient, account)));
      if (s.subs.length !== before) save();
      return s.subs.length !== before;
    },

    count: (account?: NotificationAccount) => {
      const owner = account ?? LEGACY_TEST_ACCOUNT;
      return validAccount(owner) && hasAccess(owner) ? ensure().subs.filter((sub) => sameAccount(sub.recipient, owner)).length : 0;
    },

    removeAccount(userId) {
      if (typeof userId !== "string" || !userId) return 0;
      const s = ensure();
      const before = s.subs.length;
      s.subs = s.subs.filter((sub) => sub.recipient.userId !== userId);
      if (s.subs.length !== before) save();
      return before - s.subs.length;
    },

    async send(first: NotificationAccount | PushPayload, second?: PushPayload) {
      const account = second === undefined ? LEGACY_TEST_ACCOUNT : first as NotificationAccount;
      const payload = second === undefined ? first as PushPayload : second;
      if (!validAccount(account) || !hasAccess(account)) return { sent: 0, dropped: 0, failed: 0, droppedEndpoints: [] };
      const s = ensure();
      const owned = s.subs.filter((sub) => sameAccount(sub.recipient, account));
      if (owned.length === 0) return { sent: 0, dropped: 0, failed: 0, droppedEndpoints: [] };
      const plaintext = Buffer.from(JSON.stringify(payload));
      // A person's message is worth delivering after a phone wakes from doze
      // and should wake it; a turn outcome goes stale within minutes.
      const people = payload.kind === "mention" || payload.kind === "message";
      const ttl = people ? "43200" : "300";
      const urgency = people ? "high" : "normal";
      let sent = 0;
      let failed = 0;
      const dead: string[] = [];
      await Promise.all(owned.map(async (sub) => {
        try {
          const res = await fetchFn(sub.endpoint, {
            method: "POST",
            headers: {
              authorization: vapidAuthorization(sub.endpoint, s.vapid, contact),
              "content-encoding": "aes128gcm",
              "content-type": "application/octet-stream",
              ttl,
              urgency,
            },
            body: new Uint8Array(encryptWebPush(sub.keys.p256dh, sub.keys.auth, plaintext)),
          });
          if (res.ok) {
            sent++;
            return;
          }
          const detail = await responseDetail(res);
          const host = endpointHost(sub.endpoint);
          if (res.status === 404 || res.status === 410) {
            dead.push(sub.endpoint);
            log(`[polyth] web push to ${host} expired (${res.status}); subscription dropped${detail ? `: ${detail}` : ""}`);
          } else {
            // 403 is typically a VAPID key mismatch, 413 an oversized payload,
            // 429 throttling: the subscription stays, the reason is logged.
            failed++;
            log(`[polyth] web push to ${host} rejected (${res.status})${detail ? `: ${detail}` : ""}`);
          }
        } catch (error) {
          // Transient network failure: keep the subscription.
          failed++;
          const reason = error instanceof Error ? error.message : String(error);
          log(`[polyth] web push to ${endpointHost(sub.endpoint)} failed: ${logDetail(reason)}`);
        }
      }));
      if (dead.length) {
        s.subs = s.subs.filter((x) => !(sameAccount(x.recipient, account) && dead.includes(x.endpoint)));
        save();
      }
      return { sent, dropped: dead.length, failed, droppedEndpoints: dead };
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
  /** A package reports this top-level session's turns itself (see
   *  `ServerSessionAttention.claimTurnNotifications`). */
  claimed?(sessionId: string): boolean;
  /** One bounded keyset page of ONE session's events (never a full replay),
   *  used only to put the concrete content in the body. `beforeSeq` walks the
   *  pages backwards (see the store's `events` keyset contract). Any failure
   *  degrades to the status text. */
  tail?(sessionId: string, beforeSeq?: number): Promise<readonly SessionEvent[]>;
}): {
  attention(sessionId: string, kind: "permission" | "question", requestId?: string, questions?: JsonObject[]): void;
  turnStopped(sessionId: string, reason: "completed" | "aborted" | "error"): void;
  waitingForPerson(sessionId: string): void;
  /** A package-owned outcome notification for a top-level session. */
  report(sessionId: string, kind: "completed" | "failed", statusText: string, key: string): void;
} {
  const fire = (p: Promise<unknown>): void => {
    void p.catch((err: unknown) => console.error("[polyth] push send failed", err));
  };

  // Content is read for the notified session only (a subagent's reply only
  // after the same-project parent check) and never throws. A tool-heavy turn
  // can push the closing reply far behind the newest 80 events, so the walk
  // reads at most CONTENT_PAGES keyset pages backwards — the store's page is
  // the newest events below `beforeSeq` — and stops at the first `turn/started`
  // so an earlier turn's content can never leak into this notification. Events
  // met while scanning backwards before that `turn/started` belong to the
  // current turn, so there is no stale-content risk. Within the bound nothing
  // found keeps the status text.
  // `found` stops the walk at the page that already holds what the caller
  // looks for, so the common case (the reply in the newest page) stays one read.
  const tailWindow = async (sessionId: string, found: (event: SessionEvent) => boolean): Promise<readonly SessionEvent[]> => {
    const seen: SessionEvent[] = [];
    let beforeSeq: number | undefined;
    try {
      for (let page = 0; page < CONTENT_PAGES; page++) {
        const chunk = (await deps.tail?.(sessionId, beforeSeq)) ?? [];
        if (chunk.length === 0) break;
        seen.unshift(...chunk); // pages arrive newest-first; keep seq ascending
        if (chunk.some((event) => event.type === "turn/started" || found(event))) break;
        beforeSeq = chunk[0]!.seq;
      }
    } catch { /* status text */ }
    return seen;
  };
  const isReply = (event: SessionEvent) =>
    event.type === "assistant/message" && typeof (event.data as JsonObject | undefined)?.text === "string"
    && ((event.data as JsonObject).text as string).trim() !== "";
  const replyExcerpt = async (sessionId: string, cap = MAX_BODY_CHARS): Promise<string> =>
    plainTextExcerpt(finalReplyFromTail(await tailWindow(sessionId, isReply)), cap);
  const errorExcerpt = async (sessionId: string, cap = MAX_BODY_CHARS): Promise<string> =>
    plainTextExcerpt(turnErrorFromTail(await tailWindow(sessionId, (event) => event.type === "turn/stopped")), cap);

  return {
    attention(sessionId, kind, requestId, questions) {
      fire((async () => {
        const proj = await deps.projection(sessionId);
        if (!proj) return;
        // The request event is durable before notify fires, so the open count
        // already includes it. A missing counter dep degrades to count 1.
        const counts = await deps.attention?.(sessionId);
        const open = Math.max(1, (kind === "question" ? counts?.questions : counts?.permissions) ?? 1);
        let content: string | undefined;
        try {
          if (kind === "question") content = questionSummary(questions);
          else if (requestId) {
            const isRequest = (e: SessionEvent) =>
              e.type === "permission/requested" && (e.data as JsonObject).requestId === requestId;
            const request = (await tailWindow(sessionId, isRequest)).findLast(isRequest);
            content = permissionSummary(request?.data as JsonObject | undefined);
          }
        } catch { /* status text */ }
        await deps.send(buildPushPayload(kind, {
          sessionId,
          sessionTitle: proj.title,
          key: `${sessionId}:${kind}:${open}`,
          projectId: proj.projectId,
          ...(content ? { content: plainTextExcerpt(content) } : {}),
          ...(requestId ? { requestId } : {}),
          ...(questions ? { questions } : {}),
        }));
      })());
    },
    waitingForPerson(sessionId) {
      fire((async () => {
        const proj = await deps.projection(sessionId);
        // Only an idle top-level chat: a running or waiting session already
        // has its own, more precise notification.
        if (!proj || proj.parentId || proj.status !== "idle") return;
        const content = await replyExcerpt(sessionId);
        await deps.send(buildPushPayload("question", {
          sessionId,
          sessionTitle: proj.title,
          statusText: "is waiting for your answer",
          ...(content ? { content } : {}),
          // Same key as the turn notification it replaces.
          key: `${sessionId}:turn:idle`,
          projectId: proj.projectId,
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
          let content = "";
          if (!parent.spaceId || !proj.spaceId || parent.spaceId === proj.spaceId) {
            const detail = reason === "error" ? await errorExcerpt(sessionId, 140) : await replyExcerpt(sessionId, 140);
            if (detail) content = plainTextExcerpt(`${proj.title || "Delegated agent"}${reason === "error" ? " failed" : ""}: ${detail}`);
          }
          await deps.send(buildPushPayload("subagent", {
            sessionId: proj.parentId,
            sessionTitle: parent.title,
            ...(content ? { content } : {}),
            statusText: reason === "error" ? "delegated agent failed" : "delegated agent finished",
            key: `${sessionId}:subagent:${reason === "error" ? "failed" : "idle"}`,
            projectId: proj.projectId,
          }));
          return;
        }
        if (deps.claimed?.(sessionId)) return;
        const content = reason === "error" ? await errorExcerpt(sessionId) : await replyExcerpt(sessionId);
        await deps.send(buildPushPayload(reason === "error" ? "failed" : "completed", {
          sessionId,
          sessionTitle: proj.title,
          ...(content ? { content } : {}),
          key: `${sessionId}:turn:${reason === "error" ? "failed" : "idle"}`,
          projectId: proj.projectId,
        }));
      })());
    },
    report(sessionId, kind, statusText, key) {
      fire((async () => {
        const proj = await deps.projection(sessionId);
        if (!proj || proj.parentId) return;
        await deps.send(buildPushPayload(kind, {
          sessionId,
          sessionTitle: proj.title,
          statusText,
          key: `${sessionId}:report:${key}`,
          projectId: proj.projectId,
        }));
      })());
    },
  };
}
