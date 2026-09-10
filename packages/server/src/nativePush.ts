// Native-push relay client. The relay is deliberately a blind delivery layer:
// title/body/session/project/request/action data never leaves this process.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";
import type { NotificationKind } from "@polyth/contracts";
import type { RouteHandler } from "./http.ts";

const TIMEOUT_MS = 5_000;
const CAPABILITY_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_-]{22}$/;

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
}

interface NativeFile { version: 1; subscriptions: NativeSubscription[] }

const isText = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const accountDeviceKey = (input: Pick<NativeSubscription, "userId" | "spaceId" | "deviceEndpointId">): string =>
  `${input.userId}\0${input.spaceId}\0${input.deviceEndpointId}`;

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
  claim(input: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string; claimToken: string }): Promise<{ subscriptionId: string }>;
  unregister(input: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string }): Promise<boolean>;
  /** Internal account-deletion hook; local sender authority is removed before
   * best-effort relay revocation, so an offline relay cannot retain delivery. */
  removeAccount(userId: string): Promise<number>;
  send(input: { userId: string; spaceId: string; notificationId: string; kind: NotificationKind; transitionKey: string }): Promise<{ sent: number }>;
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
        && isText(entry.senderToken) && CAPABILITY_TOKEN.test(entry.senderToken) && Number.isSafeInteger(entry.createdAt) && Number.isSafeInteger(entry.updatedAt));
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
        try {
          const response = await relayFetch(fetchFn, new URL("/v1/deliver", relay), {
            method: "POST", headers: { authorization: `Bearer ${entry.senderToken}`, "content-type": "application/json" },
            body: JSON.stringify({ version: 1, subscriptionId: entry.subscriptionId, notificationId: input.notificationId, kind: input.kind, tag: nativePushTag(input.transitionKey) }),
          });
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
      rc.json(200, await service.claim({ ...account, claimToken: typeof body.claimToken === "string" ? body.claimToken : "" }));
      return true;
    }
    if (rc.path === "/api/native-push" && rc.method === "DELETE") { rc.json(200, { ok: await service.unregister(account) }); return true; }
    return false;
  };
}
