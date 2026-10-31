// Native-push relay client. The relay is deliberately a blind delivery layer:
// session/project/request/action data never leaves this process, and title/body
// only leave it sealed for one device key (docs/mobile/native-push-content.md).
import { createECDH, createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";
import type { NotificationKind } from "@polyth/contracts";
import type { RouteHandler } from "./http.ts";
import { b64u, encryptWebPush } from "./push.ts";

const TIMEOUT_MS = 5_000;
const CAPABILITY_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_-]{22}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Sealed content ceiling in base64url characters (docs/mobile/native-push-content.md). */
const MAX_SEALED_CHARS = 3072;

export interface NativePushAuthority {
  /** Stable pinned host identity, never a transport connection id. */
  hostEndpointId(): Promise<string | undefined>;
  /** Durable account/member/device/revocation/grant verification. */
  validate(input: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string }): Promise<boolean>;
}

interface NativeSubscription {
  userId: string;
  spaceId: string;
  deviceId: string;
  deviceEndpointId: string;
  hostEndpointId: string;
  relayId: string;
  subscriptionId: string;
  senderToken: string;
  createdAt: number;
  updatedAt: number;
  /** Public half of the device content key; absent means generic text. */
  contentKey?: NativeContentKey;
}

export interface NativeContentKey { p256dh: string; auth: string }

interface NativeFile { version: 1; subscriptions: NativeSubscription[] }

const isText = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const accountDeviceKey = (input: Pick<NativeSubscription, "userId" | "spaceId" | "deviceEndpointId">): string =>
  `${input.userId}\0${input.spaceId}\0${input.deviceEndpointId}`;

/** Strict content-key check: base64url, a 65-byte uncompressed point that is on P-256, a 16-byte auth. */
export const parseContentKey = (value: unknown): NativeContentKey | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { p256dh, auth } = value as Record<string, unknown>;
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length !== 87 || auth.length !== 22
    || !BASE64URL.test(p256dh) || !BASE64URL.test(auth)) return undefined;
  const point = Buffer.from(p256dh, "base64url");
  if (point.length !== 65 || point[0] !== 0x04 || Buffer.from(auth, "base64url").length !== 16) return undefined;
  // computeSecret rejects a point that is not on the curve; it needs a local key pair to run.
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    ecdh.computeSecret(point);
  } catch { return undefined; }
  return { p256dh, auth };
};

/** base64url RFC 8291 body of `{v,title,body}`, the body shortened on a word boundary until it fits. */
export const sealNativeContent = (key: NativeContentKey, title: string, body: string): string => {
  const seal = (text: string) => b64u(encryptWebPush(key.p256dh, key.auth, Buffer.from(JSON.stringify({ v: 1, title, body: text }))));
  let text = Array.from(body);
  let sealed = seal(text.join(""));
  while (sealed.length > MAX_SEALED_CHARS && text.length > 0) {
    // Cut by the estimated overshoot (4 base64 chars per 3 bytes), then to a word boundary.
    const over = Math.max(1, Math.ceil(((sealed.length - MAX_SEALED_CHARS) * 3) / 4));
    let next = text.slice(0, Math.max(0, text.length - over));
    const space = next.lastIndexOf(" ");
    if (space > 0) next = next.slice(0, space);
    if (next.length >= text.length) next = text.slice(0, -1);
    text = next;
    sealed = seal(text.join(""));
  }
  return sealed;
};

/** Frozen native/client binding: lowercase base64url SHA-256 of a canonical tuple. */
export const nativePushBinding = (input: { hostEndpointId: string; deviceEndpointId: string; userId: string }): string =>
  createHash("sha256")
    .update("polyth-native-push-binding-v1\0")
    .update(input.hostEndpointId).update("\0")
    .update(input.deviceEndpointId).update("\0")
    .update(input.userId)
    .digest("base64url").toLowerCase();

/** Relay receives only a bounded opaque transition fingerprint. */
export const nativePushTag = (transitionKey: string): string =>
  createHash("sha256").update("polyth-native-push/tag/v1\0").update(transitionKey).digest("base64url").slice(0, 43);

const relayOrigin = (raw: string | undefined): URL | undefined => {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    if ((url.protocol !== "https:" && !loopback) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) return undefined;
    return url;
  } catch { return undefined; }
};

async function relayFetch(fetchFn: typeof fetch, url: URL, init: RequestInit): Promise<Response> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  return fetchFn(url, { ...init, signal, redirect: "error", headers: { accept: "application/json", ...(init.headers ?? {}) } });
}

export interface NativePushService {
  status(account: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string }): Promise<{ enabled: boolean; subscribed: boolean; subscriptionId?: string }>;
  claim(input: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string; claimToken: string; contentKey?: unknown }): Promise<{ subscriptionId: string }>;
  unregister(input: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string }): Promise<boolean>;
  /** Internal account-deletion hook; local sender authority is removed before
   * best-effort relay revocation, so an offline relay cannot retain delivery. */
  removeAccount(userId: string): Promise<number>;
  send(input: { userId: string; spaceId: string; notificationId: string; kind: NotificationKind; transitionKey: string; title?: string; body?: string }): Promise<{ sent: number }>;
}

export function createNativePushService(opts: {
  file: string;
  relayOrigin?: string;
  /** Resolved lazily: package enable order is not dependency order. */
  authority?: () => NativePushAuthority | undefined;
  fetchFn?: typeof fetch;
  now?: () => number;
}): NativePushService {
  const relay = relayOrigin(opts.relayOrigin);
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  let state: NativeFile = { version: 1, subscriptions: [] };
  try {
    const raw = JSON.parse(readFileSync(opts.file, "utf8")) as Partial<NativeFile>;
    if (raw.version === 1 && Array.isArray(raw.subscriptions)) {
      state.subscriptions = raw.subscriptions.filter((entry): entry is NativeSubscription =>
        !!entry && isText(entry.userId) && isText(entry.spaceId) && isText(entry.deviceId) && isText(entry.deviceEndpointId)
        && isText(entry.hostEndpointId) && isText(entry.relayId) && isText(entry.subscriptionId) && SUBSCRIPTION_ID.test(entry.subscriptionId)
        && isText(entry.senderToken) && CAPABILITY_TOKEN.test(entry.senderToken) && Number.isSafeInteger(entry.createdAt) && Number.isSafeInteger(entry.updatedAt))
        // A malformed stored key degrades to generic text; the subscription stays.
        .map((entry) => {
          const contentKey = parseContentKey(entry.contentKey);
          const { contentKey: _stored, ...rest } = entry;
          return contentKey ? { ...rest, contentKey } : rest;
        });
    }
  } catch { /* missing/corrupt state is empty, never adopted */ }
  const save = () => {
    mkdirSync(dirname(opts.file), { recursive: true });
    atomicWriteSync(opts.file, `${JSON.stringify(state)}\n`, 0o600);
  };
  const verify = async (input: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string }): Promise<string | undefined> => {
    const authority = opts.authority?.();
    if (!relay || !authority || !await authority.validate(input)) return undefined;
    const hostEndpointId = await authority.hostEndpointId();
    return isText(hostEndpointId) ? hostEndpointId : undefined;
  };
  const current = (input: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string }) =>
    state.subscriptions.find((entry) => accountDeviceKey(entry) === accountDeviceKey(input));

  return {
    async status(input) {
      const hostEndpointId = await verify(input);
      const entry = current(input);
      const subscribed = Boolean(hostEndpointId && entry?.hostEndpointId === hostEndpointId);
      return {
        enabled: Boolean(hostEndpointId),
        subscribed,
        ...(subscribed && entry ? { subscriptionId: entry.subscriptionId } : {}),
      };
    },
    async claim(input) {
      if (!CAPABILITY_TOKEN.test(input.claimToken)) throw Object.assign(new Error("claimToken is invalid"), { code: "invalid-input" });
      let contentKey: NativeContentKey | undefined;
      if (input.contentKey !== undefined && input.contentKey !== null) {
        contentKey = parseContentKey(input.contentKey);
        if (!contentKey) throw Object.assign(new Error("contentKey is invalid"), { code: "invalid-input" });
      }
      const hostEndpointId = await verify(input);
      if (!hostEndpointId || !relay) throw Object.assign(new Error("native push unavailable"), { code: "unavailable" });
      let response: Response;
      try {
        response = await relayFetch(fetchFn, new URL("/v1/claims/redeem", relay), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ claimToken: input.claimToken, binding: nativePushBinding({ hostEndpointId, deviceEndpointId: input.deviceEndpointId, userId: input.userId }) }),
        });
      } catch { throw Object.assign(new Error("native relay unavailable"), { code: "unavailable" }); }
      let body: unknown;
      try { body = await response.json(); } catch { body = null; }
      if (!response.ok || !body || typeof body !== "object" || Array.isArray(body)
        || Object.getPrototypeOf(body) !== Object.prototype
        || Object.keys(body).length !== 2 || !("subscriptionId" in body) || !("senderToken" in body)) {
        throw Object.assign(new Error("native claim rejected"), { code: "invalid-input" });
      }
      const result = body as { subscriptionId?: unknown; senderToken?: unknown };
      if (typeof result.subscriptionId !== "string" || !SUBSCRIPTION_ID.test(result.subscriptionId)
        || typeof result.senderToken !== "string" || !CAPABILITY_TOKEN.test(result.senderToken)) {
        throw Object.assign(new Error("invalid native relay response"), { code: "invalid-input" });
      }
      const entry: NativeSubscription = {
        userId: input.userId, spaceId: input.spaceId, deviceId: input.deviceId, deviceEndpointId: input.deviceEndpointId, hostEndpointId,
        relayId: relay.origin, subscriptionId: result.subscriptionId, senderToken: result.senderToken,
        createdAt: current(input)?.createdAt ?? now(), updatedAt: now(),
        // A re-claim without a key clears the previous one.
        ...(contentKey ? { contentKey } : {}),
      };
      state.subscriptions = [...state.subscriptions.filter((row) => accountDeviceKey(row) !== accountDeviceKey(input)), entry];
      save();
      return { subscriptionId: entry.subscriptionId };
    },
    async unregister(input) {
      const entry = current(input);
      if (!entry) return false;
      state.subscriptions = state.subscriptions.filter((row) => accountDeviceKey(row) !== accountDeviceKey(input));
      save();
      if (relay && entry.relayId === relay.origin) {
        try { await relayFetch(fetchFn, new URL(`/v1/senders/${encodeURIComponent(entry.subscriptionId)}`, relay), { method: "DELETE", headers: { authorization: `Bearer ${entry.senderToken}` } }); } catch { /* local revocation is durable */ }
      }
      return true;
    },
    async removeAccount(userId) {
      if (!isText(userId)) return 0;
      const removed = state.subscriptions.filter((entry) => entry.userId === userId);
      if (!removed.length) return 0;
      state.subscriptions = state.subscriptions.filter((entry) => entry.userId !== userId);
      save();
      await Promise.allSettled(removed.map(async (entry) => {
        if (!relay || entry.relayId !== relay.origin) return;
        await relayFetch(fetchFn, new URL(`/v1/senders/${encodeURIComponent(entry.subscriptionId)}`, relay), {
          method: "DELETE", headers: { authorization: `Bearer ${entry.senderToken}` },
        });
      }));
      return removed.length;
    },
    async send(input) {
      let sent = 0;
      for (const entry of state.subscriptions.filter((row) => row.userId === input.userId && row.spaceId === input.spaceId)) {
        const hostEndpointId = await verify(entry);
        if (!hostEndpointId || hostEndpointId !== entry.hostEndpointId || !relay || entry.relayId !== relay.origin) continue;
        const deliver = (sealed?: string) => relayFetch(fetchFn, new URL("/v1/deliver", relay), {
          method: "POST", headers: { authorization: `Bearer ${entry.senderToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            version: 1, subscriptionId: entry.subscriptionId, notificationId: input.notificationId, kind: input.kind, tag: nativePushTag(input.transitionKey),
            ...(sealed ? { sealed } : {}),
          }),
        });
        try {
          let sealed: string | undefined;
          if (entry.contentKey && typeof input.title === "string" && typeof input.body === "string") {
            try { sealed = sealNativeContent(entry.contentKey, input.title, input.body); } catch { /* generic text */ }
          }
          let response = await deliver(sealed);
          // A relay that predates `sealed` rejects the unknown key: retry once without it.
          if (sealed && response.status === 400) response = await deliver();
          if (response.ok) sent++;
        } catch { /* best effort; never replays canonical transition */ }
      }
      return { sent };
    },
  };
}

export function nativePushRoutes(service: NativePushService): RouteHandler {
  return async (rc) => {
    if (!rc.path.startsWith("/api/native-push")) return false;
    if (rc.principal.kind !== "paired-device") throw Object.assign(new Error("not allowed"), { code: "forbidden" });
    const account = { userId: rc.space.userId, spaceId: rc.space.spaceId, deviceId: rc.principal.deviceId, deviceEndpointId: rc.principal.deviceEndpointId };
    if (rc.path === "/api/native-push" && rc.method === "GET") { rc.json(200, await service.status(account)); return true; }
    if (rc.path === "/api/native-push" && rc.method === "POST") {
      const body = await rc.body();
      rc.json(200, await service.claim({ ...account, claimToken: typeof body.claimToken === "string" ? body.claimToken : "", ...(body.contentKey !== undefined ? { contentKey: body.contentKey } : {}) }));
      return true;
    }
    if (rc.path === "/api/native-push" && rc.method === "DELETE") { rc.json(200, { ok: await service.unregister(account) }); return true; }
    return false;
  };
}
