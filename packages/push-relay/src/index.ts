import {
  ACTIVITY_STATES, PUSH_KINDS, type ActivityInput, type DeliveryInput, type Destination, type ProviderAdapter, type ProviderClass,
  type RelayLogger, RelayFault,
} from "./types.ts";

export * from "./types.ts";
export * from "./providers.ts";
export { createRelayHttpServer, startRelayHttpServer } from "./http.ts";

const SUBSCRIPTION = /^sub_[A-Za-z0-9_-]{22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG = /^[A-Za-z0-9_-]{1,128}$/;
const SEALED = /^[A-Za-z0-9_-]{1,3072}$/;
/** An APNs device or Live Activity token as iOS hands it out (hex). */
const APNS_TOKEN = /^[0-9a-f]{64,512}$/;
/** FCM documents an opaque token: printable ASCII keeps control characters out of provider serialization. */
const FCM_TOKEN = /^[!-~]{10,4096}$/;
const KINDS: ReadonlySet<string> = new Set(PUSH_KINDS);
const STATES: ReadonlySet<string> = new Set(ACTIVITY_STATES);
const MINUTE = 60_000;
/** Rate-window keys kept at most; past it new senders wait for the sweep. */
const MAX_WINDOWS = 50_000;

export interface RelayOptions {
  /** Read on every send, so a key placed later needs no restart. */
  providers?: { ios?: () => ProviderAdapter | undefined; android?: () => ProviderAdapter | undefined };
  now?: () => number;
  logger?: RelayLogger;
  limits?: Partial<{ perToken: number; perSource: number; inFlight: number }>;
}

/** One push: a device address and either an alert or a Live Activity update. */
export interface SendRequest {
  to: Destination;
  alert?: DeliveryInput;
  activity?: ActivityInput;
}

class RateWindow {
  private readonly values = new Map<string, { startedAt: number; count: number }>();

  take(key: string, limit: number, now: number): boolean {
    if (this.values.size >= MAX_WINDOWS) {
      for (const [candidate, value] of this.values) if (now - value.startedAt >= MINUTE) this.values.delete(candidate);
    }
    const prior = this.values.get(key);
    if (!prior || now - prior.startedAt >= MINUTE) {
      if (!prior && this.values.size >= MAX_WINDOWS) return false;
      this.values.set(key, { startedAt: now, count: 1 });
      return true;
    }
    if (prior.count >= limit) return false;
    prior.count++;
    return true;
  }
}

/** Stateless forwarder: a Polyth server hands it a device token and a payload
 *  made only of enums, counts, times and device-sealed text; it signs with the
 *  app's APNs key or Firebase account and keeps nothing. */
export class PushRelay {
  private readonly now: () => number;
  private readonly providers: NonNullable<RelayOptions["providers"]>;
  private readonly logger: RelayLogger;
  private readonly limits: { perToken: number; perSource: number; inFlight: number };
  private readonly rate = new RateWindow();
  private inFlight = 0;

  constructor(options: RelayOptions = {}) {
    this.now = options.now ?? Date.now;
    this.providers = options.providers ?? {};
    this.logger = options.logger ?? (() => {});
    this.limits = {
      perToken: positiveLimit(options.limits?.perToken, 60),
      perSource: positiveLimit(options.limits?.perSource, 1_200),
      inFlight: positiveLimit(options.limits?.inFlight, 64),
    };
  }

  close(): void {
    for (const provider of Object.values(this.providers)) provider?.()?.close?.();
  }

  async send(input: unknown, sourceIp = "unknown", signal?: AbortSignal): Promise<{ result: ProviderClass }> {
    const request = validateSend(input, Math.floor(this.now() / 1_000));
    const now = this.now();
    if (!this.rate.take(`source:${sourceIp}`, this.limits.perSource, now)
      || !this.rate.take(`token:${request.to.providerToken.slice(0, 96)}`, this.limits.perToken, now)) throw new RelayFault("rate");
    if (this.inFlight >= this.limits.inFlight) throw new RelayFault("unavailable");
    const provider = this.providers[request.to.platform]?.();
    const startedAt = this.now();
    this.inFlight++;
    let result: ProviderClass;
    try {
      result = !provider ? "config"
        : request.alert ? await provider.deliver(request.to, request.alert, signal)
          : provider.deliverActivity ? await provider.deliverActivity(request.to, request.activity!, signal) : "invalid";
    } catch { result = "transient"; }
    finally { this.inFlight--; }
    this.logger({
      provider: request.to.platform,
      status: boundedStatus(result),
      code: request.alert ? "alert" : "activity",
      latencyMs: Math.min(Math.max(0, this.now() - startedAt), 60_000),
    });
    return { result };
  }
}

export const createPushRelay = (options: RelayOptions = {}): PushRelay => new PushRelay(options);

const positiveLimit = (value: number | undefined, fallback: number): number =>
  Number.isInteger(value) && value! > 0 && value! <= 100_000 ? value! : fallback;

function plainObject(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new RelayFault("invalid");
  const object = value as Record<string, unknown>;
  if (required.some((key) => !(key in object)) || Object.keys(object).some((key) => !required.includes(key) && !optional.includes(key))) throw new RelayFault("invalid");
  return object;
}

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 99;
/** Unix seconds within a day of now: nothing a device would draw as nonsense. */
const nearTime = (value: unknown, now: number): value is number =>
  Number.isSafeInteger(value) && Math.abs((value as number) - now) <= 86_400;

function validateSend(value: unknown, nowSeconds: number): SendRequest {
  const body = plainObject(value, ["to"], ["alert", "activity"]);
  if (("alert" in body) === ("activity" in body)) throw new RelayFault("invalid");
  const to = plainObject(body.to, ["platform", "token"], ["environment"]);
  if (typeof to.token !== "string") throw new RelayFault("invalid");
  let destination: Destination;
  if (to.platform === "ios") {
    if (!APNS_TOKEN.test(to.token) || (to.environment !== "sandbox" && to.environment !== "production")) throw new RelayFault("invalid");
    destination = { subscriptionId: "relay", version: 1, platform: "ios", environment: to.environment, providerToken: to.token };
  } else if (to.platform === "android") {
    if (!FCM_TOKEN.test(to.token) || "environment" in to || "activity" in body) throw new RelayFault("invalid");
    destination = { subscriptionId: "relay", version: 1, platform: "android", providerToken: to.token };
  } else throw new RelayFault("invalid");
  if ("activity" in body) return { to: { ...destination, channel: "liveactivity" }, activity: validateActivity(body.activity, nowSeconds) };
  return { to: destination, alert: validateAlert(body.alert) };
}

function validateAlert(value: unknown): DeliveryInput {
  const object = plainObject(value, ["version", "subscriptionId", "notificationId", "kind", "tag"], ["sealed"]);
  // Opaque to the relay: shape and size only, never decoded.
  if ("sealed" in object && (typeof object.sealed !== "string" || !SEALED.test(object.sealed))) throw new RelayFault("invalid");
  if (object.version !== 1 || typeof object.subscriptionId !== "string" || !SUBSCRIPTION.test(object.subscriptionId)
    || typeof object.notificationId !== "string" || !UUID.test(object.notificationId)
    || typeof object.kind !== "string" || !KINDS.has(object.kind) || typeof object.tag !== "string" || !TAG.test(object.tag)) throw new RelayFault("invalid");
  return {
    version: 1,
    subscriptionId: object.subscriptionId,
    notificationId: object.notificationId,
    kind: object.kind as DeliveryInput["kind"],
    tag: object.tag,
    ...(typeof object.sealed === "string" ? { sealed: object.sealed } : {}),
  };
}

function validateActivity(value: unknown, now: number): ActivityInput {
  const object = plainObject(value, ["event", "state", "waiting", "working", "staleAt", "urgent"], ["startedAt", "dismissAt"]);
  if ((object.event !== "update" && object.event !== "end") || typeof object.state !== "string" || !STATES.has(object.state)
    || !count(object.waiting) || !count(object.working) || !nearTime(object.staleAt, now) || typeof object.urgent !== "boolean"
    || ("startedAt" in object && !(Number.isSafeInteger(object.startedAt) && (object.startedAt as number) > 0 && (object.startedAt as number) <= now + 60))
    || ("dismissAt" in object && !nearTime(object.dismissAt, now))) throw new RelayFault("invalid");
  return {
    event: object.event,
    state: object.state as ActivityInput["state"],
    waiting: object.waiting,
    working: object.working,
    staleAt: object.staleAt,
    urgent: object.urgent,
    ...("startedAt" in object ? { startedAt: object.startedAt as number } : {}),
    ...("dismissAt" in object ? { dismissAt: object.dismissAt as number } : {}),
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
