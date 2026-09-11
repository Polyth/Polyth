import { createHash, randomBytes as secureRandomBytes } from "node:crypto";

import { RelayStore } from "./store.ts";
import {
  PUSH_KINDS, type DeliveryInput, type Environment, type Platform, type ProviderAdapter, type ProviderClass,
  type RelayLogger, RelayFault,
} from "./types.ts";

export * from "./types.ts";
export * from "./providers.ts";
export { createRelayHttpServer, startRelayHttpServer } from "./http.ts";

// The host canonicalizes the base64url digest to lowercase before it reaches
// this blind relay; preserving that exact format avoids alternate encodings.
const BINDING = /^[a-z0-9_-]{43}$/;
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const SUBSCRIPTION = /^sub_[A-Za-z0-9_-]{22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG = /^[A-Za-z0-9_-]{1,128}$/;
const KINDS = new Set<string>(PUSH_KINDS);

export interface RelayOptions {
  file: string;
  masterKey: Buffer;
  providers?: Partial<Record<Platform, ProviderAdapter>>;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  logger?: RelayLogger;
  rateLimits?: Partial<{ registrations: number; claims: number; deliveries: number }>;
}

export interface RegistrationRequest {
  platform: Platform;
  providerToken: string;
  binding: string;
  environment?: Environment;
}

export interface RegistrationResponse {
  subscriptionId: string;
  claimToken: string;
  manageToken: string;
  claimExpiresAt: number;
}

export interface DeliverResponse {
  status: "accepted" | "not-delivered";
  classification: ProviderClass;
}

class KeyedGate {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const waiter = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => waiter);
    this.tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release?.();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

class RateWindow {
  private readonly values = new Map<string, { startedAt: number; count: number }>();

  take(key: string, limit: number, now: number): boolean {
    if (this.values.size > 2048) {
      for (const [candidate, value] of this.values) if (now - value.startedAt >= 60_000) this.values.delete(candidate);
    }
    const prior = this.values.get(key);
    if (!prior || now - prior.startedAt >= 60_000) {
      this.values.set(key, { startedAt: now, count: 1 });
      return true;
    }
    if (prior.count >= limit) return false;
    prior.count++;
    return true;
  }
}

/** Standalone authority for encrypted device destinations and bounded sender caps. */
export class PushRelay {
  private readonly now: () => number;
  private readonly random: (size: number) => Buffer;
  private readonly store: RelayStore;
  private readonly providers: Partial<Record<Platform, ProviderAdapter>>;
  private readonly logger: RelayLogger;
  private readonly limits: { registrations: number; claims: number; deliveries: number };
  private readonly rate = new RateWindow();
  private readonly gate = new KeyedGate();

  constructor(options: RelayOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.randomBytes ?? secureRandomBytes;
    this.providers = options.providers ?? {};
    this.logger = options.logger ?? (() => {});
    this.limits = {
      registrations: positiveLimit(options.rateLimits?.registrations, 20),
      claims: positiveLimit(options.rateLimits?.claims, 30),
      deliveries: positiveLimit(options.rateLimits?.deliveries, 120),
    };
    this.store = new RelayStore({ file: options.file, masterKey: options.masterKey, now: this.now, randomBytes: this.random });
  }

  close(): void {
    this.store.close();
    for (const provider of Object.values(this.providers)) provider?.close?.();
  }

  register(input: unknown, sourceIp = "unknown"): RegistrationResponse {
    this.take("register", sourceIp, this.limits.registrations);
    const request = validateRegistration(input);
    const subscriptionId = `sub_${this.bytes(16).toString("base64url")}`;
    const claimToken = this.credential();
    const manageToken = this.credential();
    try {
      const result = this.store.create({ ...request, subscriptionId, claimToken, manageToken });
      return { subscriptionId, claimToken, manageToken, claimExpiresAt: result.claimExpiresAt };
    } catch (error) {
      this.storageLog(subscriptionId, error);
      throw error;
    }
  }

  rotate(subscriptionId: string, manageToken: string, input: unknown): Promise<void> {
    if (!validSubscription(subscriptionId) || !validCredential(manageToken)) throw new RelayFault("unauthorized");
    const body = strictObject(input, ["providerToken"]);
    const providerToken = providerTokenForUnknownPlatform(body.providerToken);
    return this.gate.run(subscriptionId, () => {
      try { this.store.rotate(subscriptionId, manageToken, providerToken); }
      catch (error) { this.storageLog(subscriptionId, error); throw error; }
    });
  }

  revoke(subscriptionId: string, manageToken: string): Promise<void> {
    if (!validSubscription(subscriptionId) || !validCredential(manageToken)) return Promise.reject(new RelayFault("unauthorized"));
    return this.gate.run(subscriptionId, () => {
      try { this.store.revokeManaged(subscriptionId, manageToken); }
      catch (error) { this.storageLog(subscriptionId, error); throw error; }
    });
  }

  revokeSender(subscriptionId: string, senderToken: string): Promise<void> {
    if (!validSubscription(subscriptionId) || !validCredential(senderToken)) return Promise.reject(new RelayFault("unauthorized"));
    return this.gate.run(subscriptionId, () => {
      try { this.store.revokeSender(subscriptionId, senderToken); }
      catch (error) { this.storageLog(subscriptionId, error); throw error; }
    });
  }

  redeem(input: unknown, sourceIp = "unknown"): { subscriptionId: string; senderToken: string } {
    const body = strictObject(input, ["claimToken", "binding"]);
    if (!validCredential(body.claimToken) || !validBinding(body.binding)) throw new RelayFault("unauthorized");
    const claimKey = createHash("sha256").update(body.claimToken).digest("hex").slice(0, 20);
    this.take("claim-ip", sourceIp, this.limits.claims);
    this.take("claim-subscription", claimKey, this.limits.claims);
    const senderToken = this.credential();
    try {
      return { subscriptionId: this.store.redeem(body.claimToken, body.binding, senderToken), senderToken };
    } catch (error) {
      this.storageLog(undefined, error);
      throw error;
    }
  }

  async deliver(senderToken: string, input: unknown, sourceIp = "unknown", signal?: AbortSignal): Promise<DeliverResponse> {
    const body = validateDelivery(input);
    if (!validCredential(senderToken)) throw new RelayFault("unauthorized");
    const senderKey = createHash("sha256").update(senderToken).digest("hex").slice(0, 20);
    this.take("deliver-subscription", body.subscriptionId, this.limits.deliveries);
    this.take("deliver-sender", senderKey, this.limits.deliveries);
    return this.gate.run(body.subscriptionId, async () => {
      const startedAt = this.now();
      let destination;
      try { destination = this.store.reserveDelivery(body.subscriptionId, senderToken); }
      catch (error) { this.storageLog(body.subscriptionId, error); throw error; }
      const provider = this.providers[destination.platform];
      const classification = provider ? await provider.deliver(destination, body, signal) : "config";
      if (classification === "permanent") {
        try { this.store.markDead(destination.subscriptionId, destination.version); }
        catch (error) { this.storageLog(destination.subscriptionId, error); return { status: "not-delivered", classification: "transient" }; }
      }
      this.logger({
        subscriptionId: destination.subscriptionId,
        provider: destination.platform,
        status: boundedStatus(classification),
        code: "provider-result",
        latencyMs: Math.min(Math.max(0, this.now() - startedAt), 60_000),
      });
      return classification === "success" || classification === "permanent"
        ? { status: "accepted", classification }
        : { status: "not-delivered", classification };
    });
  }

  private bytes(size: number): Buffer {
    const bytes = this.random(size);
    if (!Buffer.isBuffer(bytes) || bytes.length !== size) throw new RelayFault("storage");
    return bytes;
  }

  private credential(): string { return this.bytes(32).toString("base64url"); }

  private take(operation: string, key: string, limit: number): void {
    if (!this.rate.take(`${operation}:${key}`, limit, this.now())) throw new RelayFault("rate");
  }

  private storageLog(subscriptionId: string | undefined, error: unknown): void {
    if (error instanceof RelayFault && (error.code === "storage" || error.code === "unavailable")) {
      this.logger({ ...(subscriptionId ? { subscriptionId } : {}), code: "storage-failure" });
    }
  }
}

export const createPushRelay = (options: RelayOptions): PushRelay => new PushRelay(options);

export function parseRelayMasterKey(value: string | undefined): Buffer {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("PUSH_RELAY_MASTER_KEY must be a 32-byte base64url value");
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32) throw new Error("PUSH_RELAY_MASTER_KEY must be a 32-byte base64url value");
  return key;
}

const positiveLimit = (value: number | undefined, fallback: number): number =>
  Number.isInteger(value) && value! > 0 && value! <= 10_000 ? value! : fallback;
const validBinding = (value: unknown): value is string => typeof value === "string" && BINDING.test(value);
const validCredential = (value: unknown): value is string => typeof value === "string" && CREDENTIAL.test(value);
const validSubscription = (value: unknown): value is string => typeof value === "string" && SUBSCRIPTION.test(value);

function strictObject(value: unknown, keys: readonly string[]): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new RelayFault("invalid");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some((key) => !(key in object)) || Object.keys(object).some((key) => !keys.includes(key))) throw new RelayFault("invalid");
  for (const key of keys) if (typeof object[key] !== "string") throw new RelayFault("invalid");
  return object as Record<string, string>;
}

function validateRegistration(value: unknown): RegistrationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new RelayFault("invalid");
  const object = value as Record<string, unknown>;
  const platform = object.platform;
  const base = ["platform", "providerToken", "binding"];
  const keys = Object.keys(object);
  if ((platform === "ios" && keys.length === 4 && keys.includes("environment")) || (platform === "android" && keys.length === 3)) {
    if (keys.some((key) => !(platform === "ios" ? [...base, "environment"] : base).includes(key))) throw new RelayFault("invalid");
  } else throw new RelayFault("invalid");
  if ((platform !== "ios" && platform !== "android") || !validBinding(object.binding)) throw new RelayFault("invalid");
  const token = providerTokenFor(platform, object.providerToken);
  if (platform === "ios") {
    if (object.environment !== "sandbox" && object.environment !== "production") throw new RelayFault("invalid");
    return { platform, providerToken: token, binding: object.binding, environment: object.environment };
  }
  return { platform, providerToken: token, binding: object.binding };
}

function providerTokenFor(platform: Platform, value: unknown): string {
  if (typeof value !== "string") throw new RelayFault("invalid");
  // FCM documents an opaque token: printable ASCII avoids corrupting legitimate
  // tokens without allowing control characters into provider serialization.
  const pattern = platform === "ios" ? /^[A-Za-z0-9+/=_:-]{16,512}$/ : /^[!-~]{10,4096}$/;
  if (!pattern.test(value)) throw new RelayFault("invalid");
  return value;
}

function providerTokenForUnknownPlatform(value: unknown): string {
  if (typeof value !== "string" || !/^[!-~]{10,4096}$/.test(value)) throw new RelayFault("invalid");
  return value;
}

function validateDelivery(value: unknown): DeliveryInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new RelayFault("invalid");
  const object = value as Record<string, unknown>;
  const keys = ["version", "subscriptionId", "notificationId", "kind", "tag"];
  if (Object.keys(object).length !== keys.length || keys.some((key) => !(key in object)) || Object.keys(object).some((key) => !keys.includes(key))) throw new RelayFault("invalid");
  if (object.version !== 1 || !validSubscription(object.subscriptionId) || typeof object.notificationId !== "string" || !UUID.test(object.notificationId)
    || typeof object.kind !== "string" || !KINDS.has(object.kind) || typeof object.tag !== "string" || !TAG.test(object.tag)) throw new RelayFault("invalid");
  return {
    version: 1,
    subscriptionId: object.subscriptionId,
    notificationId: object.notificationId,
    kind: object.kind as DeliveryInput["kind"],
    tag: object.tag,
  };
}

const boundedStatus = (classification: ProviderClass): number => {
  switch (classification) {
    case "success": return 200;
    case "permanent": return 410;
    case "auth": return 401;
    case "rate": return 429;
    case "transient": return 503;
    case "config": return 400;
    case "invalid": return 400;
  }
};
