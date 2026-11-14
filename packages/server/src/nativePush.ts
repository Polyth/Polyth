// Native push to the phone app. The phone registers its tokens with this
// server over Polyth Link (the paired-device `/api/native-push` routes), and
// this server sends alerts and Live Activity updates through the hosted push
// service (`packages/push-relay`, `POLYTH_NATIVE_PUSH_RELAY_ORIGIN`), which
// holds the app's APNs key and Firebase account and keeps nothing. A server
// whose owner placed the app's own APNs key (`<dataDir>/native-push/apns.*`)
// talks to APNs itself instead. Session/project/request/action data never
// leaves this process, title/body only leave it sealed for one device key
// (docs/mobile/native-push-content.md), and a Live Activity push carries no
// words at all.
import { createECDH, createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";
import type { NotificationKind, SessionProjection } from "@polyth/contracts";
import type { ActivityInput, DeliveryInput, Destination, Environment, Platform, ProviderClass } from "@polyth/push-relay";
import type { RouteHandler } from "./http.ts";
import { b64u, encryptWebPush } from "./push.ts";
import { pairedDeviceKey } from "./devicePresence.ts";

import { pushTtlSeconds } from "@polyth/push-relay/providers";

export { apnsFromDir, apnsKeyPem } from "@polyth/push-relay/providers";

const TIMEOUT_MS = 5_000;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_-]{22}$/;
/** An APNs device or Live Activity token, hex as iOS hands it out. */
const PROVIDER_TOKEN = /^[0-9a-f]{64,512}$/;
/** An FCM registration token: opaque printable ASCII. */
const FCM_TOKEN = /^[!-~]{10,4096}$/;
const PROVIDER_CLASSES: ReadonlySet<string> = new Set(["success", "permanent", "auth", "rate", "transient", "config", "invalid"]);
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Sealed content ceiling in base64url characters (docs/mobile/native-push-content.md). */
const MAX_SEALED_CHARS = 3072;

export interface NativePushAuthority {
  /** Stable pinned host identity, never a transport connection id. */
  hostEndpointId(): Promise<string | undefined>;
  /** Durable account/member/device/revocation/grant verification. */
  validate(input: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string }): Promise<boolean>;
}

/** A provider class, or `unsent`: the push service provably never received
 *  the request (DNS, refused connection, its own 503), so sending it again
 *  cannot show the phone a second notification. */
export type SendResult = ProviderClass | "unsent";

/** Sends to APNs/FCM: the hosted push service (`relaySender`) or this
 *  server's own APNs key (`ApnsProvider` from @polyth/push-relay). */
export interface PushSender {
  deliver(destination: Destination, input: DeliveryInput): Promise<SendResult>;
  deliverActivity(destination: Destination, input: ActivityInput): Promise<SendResult>;
  /** Reachability without sending anything (the push service's `/v1/health`):
   *  whether it answers and, when it says so, which platforms it holds a usable
   *  provider credential for. */
  probe?(): Promise<PushProbe>;
  close?(): void;
}

export interface PushProbe { reach: "ok" | "unsent" | "transient"; credentials?: Partial<Record<Platform, boolean>> }

/** Why native push is not reaching phones, as Settings names it. */
export type DeliveryProblem = "unreachable" | "rate-limited" | "no-credential" | "credential-rejected" | "error";
/** How native push reaches this person's phones (`GET /api/native-push/delivery`). */
export interface NativePushDelivery {
  /** This person's phones registered in this Space that may receive push. */
  phones: number;
  /** `direct`: this server's own APNs key; `service`: the push service; `none`: neither. */
  route: "direct" | "service" | "none";
  /** `unknown` until a send or a reachability check said otherwise. */
  state: "ok" | "failing" | "unknown";
  problem?: DeliveryProblem;
  /** When the state was last observed (ms). */
  checkedAt?: number;
  /** This person's alerts waiting for another try. */
  pending: number;
}

interface NativeSubscription {
  userId: string;
  spaceId: string;
  deviceId: string;
  deviceEndpointId: string;
  hostEndpointId: string;
  /** Absent means iOS (registrations from before Android). */
  platform?: "android";
  /** The device's APNs (with its environment) or FCM token. */
  providerToken: string;
  environment?: Environment;
  subscriptionId: string;
  createdAt: number;
  updatedAt: number;
  /** Public half of the device content key; absent means generic text. */
  contentKey?: NativeContentKey;
}

export interface NativeContentKey { p256dh: string; auth: string }

/** The iOS Live Activity's states (`PolythActivityAttributes.ContentState`). */
export type LiveActivityState = "needs-approval" | "needs-reply" | "working" | "failed" | "done";
/** What a pushed Live Activity says: no words, only the state, the work's
 *  start and how many other chats wait or work. The device draws the chat's
 *  title and question from its own copy (docs/mobile/platform-behavior.md). */
export interface LiveActivityContent { state: LiveActivityState; startedAt?: number; waiting: number; working: number }
/** The fields of a chat its island state derives from, as this reader sees it. */
export type LiveActivityView = Pick<SessionProjection, "status" | "backgroundWork" | "resume" | "lastTurnAt" | "updatedAt">
  & { attention?: { questions: number; permissions: number } };

/** Which chat a device's island shows and the other chats its line counts. */
interface ActivityTrack {
  sessionId: string;
  others: string[];
  /** Last content the device showed or this server pushed. */
  sent: LiveActivityContent;
  trackedAt: number;
  pushedAt: number;
}

/** A device's Live Activity push token. */
interface NativeActivity {
  userId: string;
  spaceId: string;
  deviceId: string;
  deviceEndpointId: string;
  hostEndpointId: string;
  providerToken: string;
  environment: Environment;
  createdAt: number;
  updatedAt: number;
  track?: ActivityTrack;
}

interface NativeFile { version: 1; subscriptions: NativeSubscription[]; activities?: NativeActivity[] }

const LIVE_STATES: ReadonlySet<string> = new Set(["needs-approval", "needs-reply", "working"]);
const ACTIVITY_STATES: ReadonlySet<string> = new Set([...LIVE_STATES, "failed", "done"]);
const SESSION_ID = /^[A-Za-z0-9._:-]{1,160}$/;
/** The device trusts a pushed activity this long (`LIVE_ACTIVITY_PUSH_TRUST_MS`). */
export const LIVE_ACTIVITY_PUSH_TRUST_MS = 10 * 60_000;
/** Unchanged live content is re-sent this often (APNs priority 5) to move the stale date. */
export const LIVE_ACTIVITY_HEARTBEAT_MS = 4 * 60_000;
/** iOS ends a Live Activity after 8 hours; tracking ends with it. */
const LIVE_ACTIVITY_MAX_MS = 8 * 3600_000;
/** How long a finished chat's final state stays on the Lock Screen. */
const LIVE_ACTIVITY_DISMISS_MS = 10 * 60_000;
/** Coalesces a burst of events of one chat into one evaluation. */
const LIVE_ACTIVITY_SETTLE_MS = 1_500;
const MAX_OTHERS = 20;

const backgroundRuns = (view: LiveActivityView): number =>
  (view.backgroundWork?.multirun ?? 0) + (view.backgroundWork?.fusion ?? 0) + (view.backgroundWork?.workflow ?? 0);

/** Mirrors `resolveSessionStatus` and `liveActivityFinal` (apps/web/src/
 *  sessionStatus.ts, liveActivity.ts) for the five states the island draws:
 *  not live means failed or done; a missing or unreadable chat is done. */
export function liveActivityState(view: LiveActivityView | undefined): LiveActivityState {
  if (!view || view.status === "archived") return "done";
  if ((view.attention?.permissions ?? 0) > 0) return "needs-approval";
  if ((view.attention?.questions ?? 0) > 0 || view.status === "waiting") return "needs-reply";
  if (view.status === "working" || backgroundRuns(view) > 0) return "working";
  return view.status === "failed" && !view.resume ? "failed" : "done";
}

export function liveActivityContent(focus: LiveActivityView | undefined, others: ReadonlyArray<LiveActivityView | undefined>): LiveActivityContent {
  const state = liveActivityState(focus);
  let waiting = 0;
  let working = 0;
  for (const other of others) {
    const kind = liveActivityState(other);
    if (kind === "working") working++;
    else if (LIVE_STATES.has(kind)) waiting++;
  }
  // The same start the web shell draws the timer from (`workStartedAt`).
  const start = state === "working" && focus
    ? backgroundRuns(focus) > 0 ? focus.backgroundWork?.startedAt ?? focus.lastTurnAt ?? focus.updatedAt : focus.lastTurnAt ?? focus.updatedAt
    : undefined;
  return { state, waiting, working, ...(typeof start === "number" && start > 0 ? { startedAt: start } : {}) };
}

const countIn = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 99;
const parseContent = (value: unknown): LiveActivityContent | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { state, startedAt, waiting, working } = value as Record<string, unknown>;
  if (typeof state !== "string" || !ACTIVITY_STATES.has(state) || !countIn(waiting) || !countIn(working)) return undefined;
  if (startedAt !== undefined && !(Number.isSafeInteger(startedAt) && (startedAt as number) > 0)) return undefined;
  return { state: state as LiveActivityState, waiting, working, ...(typeof startedAt === "number" ? { startedAt } : {}) };
};
/** `{sessionId, others, shown}` from a device: bounded ids and a content the island shows. */
const parseTrackRequest = (value: unknown): { sessionId: string; others: string[]; shown: LiveActivityContent } | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { sessionId, others, shown } = value as Record<string, unknown>;
  const content = parseContent(shown);
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId) || !content || !Array.isArray(others) || others.length > MAX_OTHERS
    || others.some((id) => typeof id !== "string" || !SESSION_ID.test(id) || id === sessionId) || new Set(others).size !== others.length) return undefined;
  return { sessionId, others: others as string[], shown: content };
};
const parseTrack = (value: unknown): ActivityTrack | undefined => {
  const request = parseTrackRequest(value ? { ...(value as object), shown: (value as { sent?: unknown }).sent } : value);
  const { trackedAt, pushedAt } = (value ?? {}) as Record<string, unknown>;
  if (!request || !Number.isSafeInteger(trackedAt) || !Number.isSafeInteger(pushedAt)) return undefined;
  return { sessionId: request.sessionId, others: request.others, sent: request.shown, trackedAt: trackedAt as number, pushedAt: pushedAt as number };
};
const sameContent = (a: LiveActivityContent, b: LiveActivityContent): boolean =>
  a.state === b.state && a.waiting === b.waiting && a.working === b.working && a.startedAt === b.startedAt;

const isText = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const isEnvironment = (value: unknown): value is Environment => value === "sandbox" || value === "production";
const isDirect = (value: { providerToken?: unknown; environment?: unknown }): boolean =>
  typeof value.providerToken === "string" && PROVIDER_TOKEN.test(value.providerToken) && isEnvironment(value.environment);
const isAndroid = (value: { platform?: unknown; providerToken?: unknown; environment?: unknown }): boolean =>
  value.platform === "android" && typeof value.providerToken === "string" && FCM_TOKEN.test(value.providerToken) && value.environment === undefined;
const destinationOf = (entry: NativeSubscription): Destination => entry.platform === "android"
  ? { subscriptionId: entry.subscriptionId, version: 1, platform: "android", providerToken: entry.providerToken }
  : { subscriptionId: entry.subscriptionId, version: 1, platform: "ios", environment: entry.environment!, providerToken: entry.providerToken };
const accountDeviceKey = (input: { userId: string; spaceId: string; deviceEndpointId: string }): string =>
  `${input.userId}\0${input.spaceId}\0${input.deviceEndpointId}`;
/** One provider token is one app install. Registered again under another
 *  person or another device identity, the older row is what that install used
 *  before it re-paired or changed account: its alerts would reach a phone that
 *  no longer speaks for that account. The same person and device in another
 *  Space keeps its own row. */
const supersedes = (current: NativeSubscription, row: NativeSubscription): boolean =>
  row !== current && row.providerToken === current.providerToken
  && (row.userId !== current.userId || row.deviceEndpointId !== current.deviceEndpointId);
/** Rows left by an install's earlier identities: for each token, everything
 *  not owned by the person and device of its most recent registration. */
const staleDuplicates = (rows: readonly NativeSubscription[]): Set<NativeSubscription> => {
  const latest = new Map<string, NativeSubscription>();
  for (const row of rows) {
    const seen = latest.get(row.providerToken);
    if (!seen || row.updatedAt > seen.updatedAt) latest.set(row.providerToken, row);
  }
  return new Set(rows.filter((row) => supersedes(latest.get(row.providerToken)!, row)));
};
const unavailable = () => Object.assign(new Error("native push unavailable"), { code: "unavailable" });
const invalid = (what: string) => Object.assign(new Error(`${what} is invalid`), { code: "invalid-input" });

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

/** The push service receives only a bounded opaque transition fingerprint. */
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

/** Polyth's hosted push service, the default for every server. */
export const PUSH_SERVICE_ORIGIN = "https://push.polyth.app";

/** Connection failures that prove the request never reached the push service,
 *  so sending it again cannot show the phone a second notification. A reset or
 *  a timeout may come after the service accepted it and is never retried. */
const UNSENT_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
const RETRY_DELAY_MS = 1_000;

const errorCode = (error: unknown): string | undefined => {
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z_]{2,40}$/.test(code)) return code;
  }
  return undefined;
};

export interface RelaySenderOptions {
  /** One line when the service's health changes; never a token or payload. */
  log?: (line: string) => void;
  /** Pause before the single retry of a send that provably never arrived. */
  retryDelayMs?: number;
}

/** The hosted push service (`packages/push-relay`): it receives the device
 *  token and a payload of enums, counts, times and device-sealed text. Unset
 *  means Polyth's own; `off` (or any value that is not an https origin) sends
 *  no push through a service. */
export function relaySender(origin: string | undefined, fetchFn: typeof fetch = fetch, options: RelaySenderOptions = {}): PushSender | undefined {
  const url = relayOrigin(origin || PUSH_SERVICE_ORIGIN);
  if (!url) return undefined;
  const log = options.log ?? ((line: string) => console.warn(line));
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  // A failing push service is otherwise silent: every alert just vanishes.
  // Report each change of its health once, not every send.
  let health = "ok";
  const report = (next: string) => {
    if (next === health) return;
    const previous = health;
    health = next;
    log(next === "ok"
      ? `[native-push] push service ${url.host} delivers again (was: ${previous})`
      : `[native-push] push service ${url.host} is not delivering: ${next}`);
  };
  type Attempt = { result: ProviderClass; unsent: boolean; problem?: string };
  const attempt = async (body: string, platform: Platform): Promise<Attempt> => {
    let response: Response;
    try {
      response = await fetchFn(new URL("/v1/send", url), {
        method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error",
        headers: { accept: "application/json", "content-type": "application/json" }, body,
      });
    } catch (error) {
      const code = errorCode(error);
      return { result: "transient", unsent: Boolean(code && UNSENT_CODES.has(code)), problem: code ? `network ${code}` : "network error" };
    }
    if (response.status === 429) return { result: "rate", unsent: false, problem: "rate limited" };
    if (response.status === 400) return { result: "invalid", unsent: false };
    // The service answers 503 only when it refused before calling a provider.
    if (response.status === 503) return { result: "transient", unsent: true, problem: "overloaded (503)" };
    let result: unknown;
    try { result = response.ok ? (await response.json() as { result?: unknown }).result : undefined; } catch { result = undefined; }
    if (typeof result !== "string" || !PROVIDER_CLASSES.has(result)) return { result: "transient", unsent: false, problem: `answer ${response.status}` };
    const classified = result as ProviderClass;
    if (classified === "config") return { result: classified, unsent: false, problem: `no ${platform === "ios" ? "APNs" : "FCM"} credential` };
    if (classified === "auth") return { result: classified, unsent: false, problem: `${platform === "ios" ? "APNs" : "FCM"} rejected its credential` };
    return { result: classified, unsent: false };
  };
  const post = async (payload: unknown, platform: Platform): Promise<SendResult> => {
    const body = JSON.stringify(payload);
    let outcome = await attempt(body, platform);
    if (outcome.unsent) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      outcome = await attempt(body, platform);
    }
    // A dead token or a bad request is about that one phone, not the service.
    if (outcome.problem) report(outcome.problem);
    else if (outcome.result === "success" || outcome.result === "permanent") report("ok");
    // Still unsent: the caller may queue it for later without risking a duplicate.
    return outcome.unsent ? "unsent" : outcome.result;
  };
  const probe = async (): Promise<PushProbe> => {
    try {
      const response = await fetchFn(new URL("/v1/health", url), {
        method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error", headers: { accept: "application/json" },
      });
      const answer = response.ok ? await response.json().catch(() => undefined) as Record<string, unknown> | undefined : undefined;
      if (answer?.ok !== true) { report(`answer ${response.status}`); return { reach: response.status === 503 ? "unsent" : "transient" }; }
      // An older service answers only `{ok: true}`: reachable, credentials untold.
      const credentials: Partial<Record<Platform, boolean>> = {};
      for (const platform of ["ios", "android"] as const) if (typeof answer[platform] === "boolean") credentials[platform] = answer[platform] as boolean;
      return { reach: "ok", credentials };
    } catch (error) {
      const code = errorCode(error);
      report(code ? `network ${code}` : "network error");
      return { reach: code && UNSENT_CODES.has(code) ? "unsent" : "transient" };
    }
  };
  const to = (destination: Destination) => ({
    platform: destination.platform, token: destination.providerToken,
    ...(destination.platform === "ios" ? { environment: destination.environment } : {}),
  });
  return {
    deliver: (destination, alert) => post({ to: to(destination), alert }, destination.platform),
    deliverActivity: (destination, activity) => post({ to: to(destination), activity }, destination.platform),
    probe,
  };
}

export interface NativePushService {
  status(account: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string }): Promise<{ enabled: boolean; subscribed: boolean; subscriptionId?: string }>;
  /** Registration over Polyth Link: the device's APNs token (with its
   *  environment) or FCM token (`platform: "android"`), the id it files the
   *  registration under and the public half of its content key. */
  register(input: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string; subscriptionId: unknown; providerToken: unknown; environment: unknown; platform?: unknown; contentKey?: unknown }): Promise<{ subscriptionId: string }>;
  unregister(input: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string }): Promise<boolean>;
  /** Internal account-deletion hook: its devices stop receiving at once. */
  removeAccount(userId: string): Promise<number>;
  send(input: { userId: string; spaceId: string; notificationId: string; kind: NotificationKind; transitionKey: string; title?: string; body?: string }): Promise<{ sent: number }>;
  /** Live Activity push (docs/mobile/platform-behavior.md): the activity's
   *  push token, the chat it shows, and pushes of state changes while the app
   *  is suspended. */
  activityStatus(account: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string }): Promise<{ enabled: boolean; subscribed: boolean }>;
  registerActivity(input: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string; providerToken: unknown; environment: unknown }): Promise<{ ok: true }>;
  /** The device names the chat its island shows (and the ones its line counts)
   *  and what it shows; a later change of any of them is pushed. */
  trackActivity(input: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string; track: unknown }): Promise<{ tracked: boolean }>;
  /** The device ended the activity: nothing more to keep current. */
  untrackActivity(account: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string }): Promise<boolean>;
  /** A chat's events or row changed; tracked islands re-evaluate shortly. */
  sessionTouched(sessionId: string): void;
  /** The person started or stopped using a device: their tracked islands
   *  re-evaluate now (one on a phone not in use leaves). */
  presenceChanged(account: { userId: string; spaceId: string }): void;
  /** Evaluate every tracked island now (heartbeat tick; tests). */
  flushActivities(): Promise<void>;
  /** How native push reaches this person's phones and whether it works. */
  delivery(account: { userId: string; spaceId: string }): Promise<NativePushDelivery>;
  /** Send every queued alert that is due now (retry timer; tests). */
  flushRetries(): Promise<void>;
  close(): void;
}

/** Waits between tries of an alert the push service or provider refused
 *  before delivering; the last one repeats until the alert's lifetime ends. */
const RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
/** Alerts queued for another try at most, the oldest dropped first. */
const MAX_PENDING_ALERTS = 500;
/** A reachability check older than this is repeated when Settings asks. */
const PROBE_STALE_MS = 60_000;
/** Results that prove the phone was not shown the alert, so another try
 *  cannot duplicate it: never received (`unsent`), or refused by the service
 *  or the provider before delivery (a limit, a missing or rejected credential).
 *  `transient` may follow an accepted send and is never repeated. */
const RETRYABLE: ReadonlySet<SendResult> = new Set(["unsent", "rate", "config", "auth"]);
const PROBLEM_OF: Partial<Record<SendResult, DeliveryProblem>> = {
  unsent: "unreachable", rate: "rate-limited", config: "no-credential", auth: "credential-rejected", transient: "error",
};
type Route = "direct" | "service";

interface PendingAlert {
  key: string;
  deviceKey: string;
  platform: Platform;
  /** The registration it was sealed for; another one drops it. */
  subscriptionId: string;
  providerToken: string;
  contentKey?: string;
  input: DeliveryInput;
  attempts: number;
  nextAt: number;
  deadline: number;
}

export function createNativePushService(opts: {
  file: string;
  /** The hosted push service (`relaySender`). */
  relay?: PushSender;
  /** This server's own APNs sender (`apnsFromDir`), read on every use; it
   *  takes over iOS from the push service. */
  apns?: () => PushSender | undefined;
  /** Resolved lazily: package enable order is not dependency order. */
  authority?: () => NativePushAuthority | undefined;
  now?: () => number;
  /** The named chats as this person sees them; a chat they cannot open is absent. */
  activityViews?: (account: { userId: string; spaceId: string }, sessionIds: string[]) => Promise<Map<string, LiveActivityView>>;
  /** Health changes of this server's own APNs key (the push service's are
   *  logged by `relaySender`); never a token or payload. */
  log?: (line: string) => void;
  retryDelaysMs?: readonly number[];
  /** The device this person is using in that Space (devicePresence.ts). While
   *  there is one, a phone that is not it gets no alert and no island. */
  activeDevice?: (account: { userId: string; spaceId: string }) => string | undefined;
}): NativePushService {
  const pick = (platform: Platform): { route: Route; sender: PushSender } | undefined => {
    const apns = platform === "ios" ? opts.apns?.() : undefined;
    if (apns) return { route: "direct", sender: apns };
    return opts.relay ? { route: "service", sender: opts.relay } : undefined;
  };
  const senderFor = (platform: Platform): PushSender | undefined => pick(platform)?.sender;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.warn(line));
  const retryDelays = opts.retryDelaysMs?.length ? opts.retryDelaysMs : RETRY_DELAYS_MS;
  const base = (entry: Record<string, unknown>): boolean =>
    isText(entry.userId) && isText(entry.spaceId) && isText(entry.deviceId) && isText(entry.deviceEndpointId)
    && isText(entry.hostEndpointId) && Number.isSafeInteger(entry.createdAt) && Number.isSafeInteger(entry.updatedAt);
  let state: NativeFile = { version: 1, subscriptions: [] };
  try {
    const raw = JSON.parse(readFileSync(opts.file, "utf8")) as Partial<NativeFile>;
    if (raw.version === 1 && Array.isArray(raw.subscriptions)) {
      state.subscriptions = raw.subscriptions.filter((entry): entry is NativeSubscription =>
        !!entry && base(entry as unknown as Record<string, unknown>) && isText(entry.subscriptionId) && SUBSCRIPTION_ID.test(entry.subscriptionId)
        // Relay-claim entries (a sender capability, no token) are dropped: the phone registers again.
        && (isDirect(entry) || isAndroid(entry)))
        // A malformed stored key degrades to generic text; the subscription stays.
        .map((entry) => {
          const contentKey = parseContentKey(entry.contentKey);
          const { contentKey: _stored, ...rest } = entry;
          return contentKey ? { ...rest, contentKey } : rest;
        });
      if (Array.isArray(raw.activities)) {
        state.activities = raw.activities.filter((entry): entry is NativeActivity =>
          !!entry && base(entry as unknown as Record<string, unknown>) && isDirect(entry))
          .map((entry) => {
            const track = parseTrack(entry.track);
            const { track: _stored, ...rest } = entry;
            return track ? { ...rest, track } : rest;
          });
      }
    }
  } catch { /* missing/corrupt state is empty, never adopted */ }
  const save = () => {
    mkdirSync(dirname(opts.file), { recursive: true });
    atomicWriteSync(opts.file, `${JSON.stringify(state)}\n`, 0o600);
  };
  /** Drops an install's earlier registrations and the Live Activity rows of
   *  those identities (same person, Space and device); true when any went. */
  const forgetStale = (stale: ReadonlySet<NativeSubscription>): boolean => {
    if (!stale.size) return false;
    const keys = new Set([...stale].map(accountDeviceKey));
    state.subscriptions = state.subscriptions.filter((row) => !stale.has(row));
    if (state.activities) state.activities = state.activities.filter((row) => !keys.has(accountDeviceKey(row)));
    return true;
  };
  // Duplicates stored before registration removed them go on the first load.
  if (forgetStale(staleDuplicates(state.subscriptions))) {
    try { save(); } catch { /* the next write persists it */ }
  }
  /** The pinned host identity when this device may receive native push at all. */
  const verify = async (input: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string }): Promise<string | undefined> => {
    const authority = opts.authority?.();
    if ((!opts.relay && !opts.apns?.()) || !authority || !await authority.validate(input)) return undefined;
    const hostEndpointId = await authority.hostEndpointId();
    return isText(hostEndpointId) ? hostEndpointId : undefined;
  };
  const current = (input: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string }) =>
    state.subscriptions.find((entry) => accountDeviceKey(entry) === accountDeviceKey(input));
  /** The person works on another device right now: this phone stays quiet. */
  const elsewhere = (entry: { userId: string; spaceId: string; deviceEndpointId: string }): boolean => {
    const active = opts.activeDevice?.({ userId: entry.userId, spaceId: entry.spaceId });
    return active !== undefined && active !== pairedDeviceKey(entry.deviceEndpointId);
  };
  const activities = (): NativeActivity[] => state.activities ?? [];
  const currentActivity = (input: { userId: string; spaceId: string; deviceEndpointId: string }) =>
    activities().find((entry) => accountDeviceKey(entry) === accountDeviceKey(input));
  const contentKeyOf = (value: unknown): NativeContentKey | undefined => {
    if (value === undefined || value === null) return undefined;
    const key = parseContentKey(value);
    if (!key) throw invalid("contentKey");
    return key;
  };

  // --- Delivery health per route and platform, from real sends and the push
  // service's reachability check. Kept in memory: a restart starts `unknown`.
  const health = new Map<string, { problem?: DeliveryProblem; at: number }>();
  const healthKey = (route: Route, platform: Platform) => `${route}:${platform}`;
  const observe = (route: Route, platform: Platform, result: SendResult | "ok") => {
    if (result === "invalid") return;
    const problem = result === "ok" ? undefined : PROBLEM_OF[result];
    const key = healthKey(route, platform);
    const previous = health.get(key);
    health.set(key, { ...(problem ? { problem } : {}), at: now() });
    if (route === "direct" && previous?.problem !== problem && (previous?.problem || problem)) {
      log(problem ? `[native-push] own APNs key is not delivering: ${problem}` : `[native-push] own APNs key delivers again (was: ${previous?.problem})`);
    }
    // The route works again: what waits for it goes now, not after its backoff.
    if (!problem) wakeRetries(route, platform);
  };
  let probing: Promise<void> | undefined;
  const probeService = (): Promise<void> => {
    const relay = opts.relay;
    if (!relay?.probe) return Promise.resolve();
    probing ??= relay.probe().then((answer) => {
      for (const platform of ["ios", "android"] as const) {
        if (answer.reach !== "ok") { observe("service", platform, answer.reach); continue; }
        if (answer.credentials?.[platform] === false) { observe("service", platform, "config"); continue; }
        // Answering clears only network trouble, and holding a credential only
        // its absence: a rejected key or a limit stays until a send succeeds.
        const previous = health.get(healthKey("service", platform))?.problem;
        const cleared = !previous || previous === "unreachable" || previous === "error"
          || (previous === "no-credential" && answer.credentials?.[platform] === true);
        if (cleared) observe("service", platform, "ok");
        else health.set(healthKey("service", platform), { problem: previous, at: now() });
      }
    }).catch(() => undefined).finally(() => { probing = undefined; });
    return probing;
  };

  // --- Alerts the service or provider refused before delivery wait in memory
  // and go again with backoff until their provider lifetime ends.
  const pending = new Map<string, PendingAlert>();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retrying: Promise<void> | undefined;
  let closed = false;
  const scheduleRetries = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    if (closed || retrying || !pending.size) return;
    let next = Infinity;
    for (const item of pending.values()) next = Math.min(next, item.nextAt);
    retryTimer = setTimeout(() => { retryTimer = undefined; void flushRetries(); }, Math.max(0, Math.min(next - now(), 2_147_000_000)));
    retryTimer.unref?.();
  };
  const wakeRetries = (route: Route, platform: Platform) => {
    let woke = false;
    const at = now();
    for (const item of pending.values()) {
      if (item.platform !== platform || item.nextAt <= at || pick(platform)?.route !== route) continue;
      item.nextAt = at;
      woke = true;
    }
    if (woke) scheduleRetries();
  };
  const enqueue = (entry: NativeSubscription, input: DeliveryInput, kind: NotificationKind, firstAt: number) => {
    const deviceKey = accountDeviceKey(entry);
    const key = `${deviceKey}\0${input.tag}`;
    // A newer alert for the same transition replaces the waiting one.
    pending.delete(key);
    while (pending.size >= MAX_PENDING_ALERTS) pending.delete(pending.keys().next().value!);
    const deadline = firstAt + pushTtlSeconds(kind) * 1_000;
    const nextAt = now() + retryDelays[0]!;
    if (nextAt >= deadline) return;
    pending.set(key, {
      key, deviceKey, platform: destinationOf(entry).platform, subscriptionId: entry.subscriptionId, providerToken: entry.providerToken,
      ...(entry.contentKey ? { contentKey: entry.contentKey.p256dh } : {}),
      input, attempts: 0, nextAt, deadline,
    });
    scheduleRetries();
  };
  /** One send to one registration; `undefined` when it may not be sent at all. */
  const deliverTo = async (entry: NativeSubscription, input: DeliveryInput): Promise<SendResult | undefined> => {
    const hostEndpointId = await verify(entry);
    const destination = destinationOf(entry);
    const via = pick(destination.platform);
    if (!via || !hostEndpointId || hostEndpointId !== entry.hostEndpointId) return undefined;
    const result = await via.sender.deliver(destination, input).catch((): SendResult => "transient");
    observe(via.route, destination.platform, result);
    if (result === "permanent") {
      // The provider retired the token (app removed or token replaced): stop sending.
      state.subscriptions = state.subscriptions.filter((row) => row !== entry);
      save();
    }
    return result;
  };
  const runRetries = async () => {
    const at = now();
    const due = [...pending.values()].filter((item) => item.nextAt <= at);
    await Promise.all(due.map(async (item) => {
      if (pending.get(item.key) !== item) return;
      const entry = state.subscriptions.find((row) => accountDeviceKey(row) === item.deviceKey);
      // Unregistered, or registered anew (its sealed text was for the old key), or too old to show.
      // The person has since sat down at another device: that one was told.
      if (!entry || entry.subscriptionId !== item.subscriptionId || entry.providerToken !== item.providerToken
        || entry.contentKey?.p256dh !== item.contentKey || at >= item.deadline || elsewhere(entry)) { pending.delete(item.key); return; }
      const result = await deliverTo(entry, item.input);
      if (pending.get(item.key) !== item) return;
      if (!result || !RETRYABLE.has(result)) { pending.delete(item.key); return; }
      item.attempts++;
      item.nextAt = now() + retryDelays[Math.min(item.attempts, retryDelays.length - 1)]!;
      if (item.nextAt >= item.deadline) pending.delete(item.key);
    }));
  };
  const flushRetries = (): Promise<void> => {
    retrying ??= runRetries().catch(() => undefined).finally(() => { retrying = undefined; scheduleRetries(); });
    return retrying;
  };

  // --- Live Activity: one evaluation at a time per device, a short settle
  // after a burst of events, and a heartbeat tick that moves the stale date.
  const evaluating = new Map<string, Promise<void>>();
  const settling = new Map<string, ReturnType<typeof setTimeout>>();
  const dropTrack = (key: string, track: ActivityTrack) => {
    const entry = activities().find((row) => accountDeviceKey(row) === key);
    if (!entry || entry.track !== track) return;
    delete entry.track;
    save();
  };
  const evaluateActivity = async (key: string): Promise<void> => {
    const entry = activities().find((row) => accountDeviceKey(row) === key);
    const track = entry?.track;
    if (!entry || !track || !opts.activityViews) return;
    const at = now();
    if (at - track.trackedAt > LIVE_ACTIVITY_MAX_MS) { dropTrack(key, track); return; }
    const via = pick("ios");
    const hostEndpointId = await verify(entry);
    if (!via || !hostEndpointId || hostEndpointId !== entry.hostEndpointId) return;
    const views = await opts.activityViews({ userId: entry.userId, spaceId: entry.spaceId }, [track.sessionId, ...track.others]);
    const focus = views.get(track.sessionId);
    const content = liveActivityContent(focus, track.others.map((id) => views.get(id)));
    // The person works on another device: the island leaves this phone at once.
    const away = elsewhere(entry);
    const ended = away || (!LIVE_STATES.has(content.state) && content.waiting + content.working === 0);
    const changed = !sameContent(content, track.sent);
    if (!changed && !ended && at - track.pushedAt < LIVE_ACTIVITY_HEARTBEAT_MS) return;
    const seconds = Math.floor(at / 1_000);
    const startedAt = content.startedAt !== undefined ? Math.floor(content.startedAt / 1_000) : undefined;
    const result = await via.sender.deliverActivity(
      { subscriptionId: "live-activity", version: 1, platform: "ios", environment: entry.environment, channel: "liveactivity", providerToken: entry.providerToken },
      {
        event: ended ? "end" : "update",
        state: content.state,
        // A start older than a week is not drawn as a running timer.
        ...(startedAt !== undefined && startedAt > seconds - 7 * 24 * 3600 && startedAt <= seconds ? { startedAt } : {}),
        waiting: content.waiting,
        working: content.working,
        staleAt: seconds + LIVE_ACTIVITY_PUSH_TRUST_MS / 1_000,
        // A chat that is gone (or no longer readable) leaves at once, and so
        // does an island on a phone not in use; a finished one stays briefly.
        ...(ended ? { dismissAt: focus && !away ? seconds + LIVE_ACTIVITY_DISMISS_MS / 1_000 : seconds } : {}),
        urgent: changed || ended,
      },
    ).catch((): SendResult => "transient");
    observe(via.route, "ios", result);
    const latest = activities().find((row) => accountDeviceKey(row) === key);
    // The device registered another activity or named another chat meanwhile.
    if (latest !== entry || latest.track !== track) return;
    if (result === "permanent") {
      // The token is dead: that activity is over. The next one registers anew.
      state.activities = activities().filter((row) => row !== latest);
      save();
      return;
    }
    // Rate, network and APNs configuration trouble: the next touch or tick tries again.
    if (result !== "success") return;
    if (ended) delete latest.track;
    else latest.track = { ...track, sent: content, pushedAt: at };
    save();
  };
  const runActivity = (key: string): Promise<void> => {
    const previous = evaluating.get(key) ?? Promise.resolve();
    const next = previous.then(() => evaluateActivity(key)).catch(() => undefined);
    evaluating.set(key, next);
    void next.then(() => { if (evaluating.get(key) === next) evaluating.delete(key); });
    return next;
  };
  const flushActivities = async (): Promise<void> => {
    await Promise.all(activities().filter((entry) => entry.track).map((entry) => runActivity(accountDeviceKey(entry))));
  };
  const sessionTouched = (sessionId: string): void => {
    for (const entry of activities()) {
      const track = entry.track;
      if (!track || (track.sessionId !== sessionId && !track.others.includes(sessionId))) continue;
      const key = accountDeviceKey(entry);
      if (settling.has(key)) continue;
      const timer = setTimeout(() => { settling.delete(key); void runActivity(key); }, LIVE_ACTIVITY_SETTLE_MS);
      timer.unref?.();
      settling.set(key, timer);
    }
  };
  const presenceChanged = (account: { userId: string; spaceId: string }): void => {
    for (const entry of activities()) {
      if (!entry.track || entry.userId !== account.userId || entry.spaceId !== account.spaceId) continue;
      void runActivity(accountDeviceKey(entry));
    }
  };
  const heartbeat = opts.activityViews ? setInterval(() => { void flushActivities(); }, 60_000) : undefined;
  heartbeat?.unref?.();

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
    async register(input) {
      const platform: Platform = input.platform === "android" ? "android" : "ios";
      if (input.platform !== undefined && input.platform !== "ios" && input.platform !== "android") throw invalid("platform");
      if (typeof input.subscriptionId !== "string" || !SUBSCRIPTION_ID.test(input.subscriptionId)) throw invalid("subscriptionId");
      if (typeof input.providerToken !== "string" || !(platform === "ios" ? PROVIDER_TOKEN : FCM_TOKEN).test(input.providerToken)) throw invalid("providerToken");
      if (platform === "ios" ? !isEnvironment(input.environment) : input.environment !== undefined) throw invalid("environment");
      const contentKey = contentKeyOf(input.contentKey);
      const hostEndpointId = await verify(input);
      if (!hostEndpointId || !senderFor(platform)) throw unavailable();
      const previous = current(input);
      // The key belongs to the subscription id: the device mints both in
      // `enable`. A re-send of the same subscription without a key (a token
      // rotation, a foreground re-sync from a build whose status omits it)
      // keeps it; a new subscription without a key gets the generic text.
      const key = contentKey ?? (previous?.subscriptionId === input.subscriptionId ? previous.contentKey : undefined);
      const entry: NativeSubscription = {
        userId: input.userId, spaceId: input.spaceId, deviceId: input.deviceId, deviceEndpointId: input.deviceEndpointId, hostEndpointId,
        subscriptionId: input.subscriptionId, providerToken: input.providerToken,
        ...(platform === "android" ? { platform } : { environment: input.environment as Environment }),
        createdAt: previous?.createdAt ?? now(), updatedAt: now(),
        ...(key ? { contentKey: key } : {}),
      };
      // The same install under another person or device identity is stale.
      forgetStale(new Set(state.subscriptions.filter((row) => supersedes(entry, row))));
      state.subscriptions = [...state.subscriptions.filter((row) => accountDeviceKey(row) !== accountDeviceKey(input)), entry];
      save();
      return { subscriptionId: entry.subscriptionId };
    },
    async unregister(input) {
      const entry = current(input);
      if (!entry) return false;
      state.subscriptions = state.subscriptions.filter((row) => accountDeviceKey(row) !== accountDeviceKey(input));
      save();
      return true;
    },
    async removeAccount(userId) {
      if (!isText(userId)) return 0;
      const removed = state.subscriptions.filter((entry) => entry.userId === userId);
      const removedActivities = activities().filter((entry) => entry.userId === userId);
      if (!removed.length && !removedActivities.length) return 0;
      state.subscriptions = state.subscriptions.filter((entry) => entry.userId !== userId);
      state.activities = activities().filter((entry) => entry.userId !== userId);
      save();
      return removed.length;
    },
    async send(input) {
      let sent = 0;
      // Every device at once: a slow or unreachable phone must not delay the others.
      const firstAt = now();
      // While the person works on one device, only that one is told; the
      // inbox row reaches every device either way.
      const devices = state.subscriptions.filter((row) => row.userId === input.userId && row.spaceId === input.spaceId && !elsewhere(row));
      await Promise.all(devices.map(async (entry) => {
        let sealed: string | undefined;
        if (entry.contentKey && typeof input.title === "string" && typeof input.body === "string") {
          try { sealed = sealNativeContent(entry.contentKey, input.title, input.body); } catch { /* generic text */ }
        }
        const alert: DeliveryInput = {
          version: 1, subscriptionId: entry.subscriptionId, notificationId: input.notificationId, kind: input.kind, tag: nativePushTag(input.transitionKey),
          ...(sealed ? { sealed } : {}),
        };
        const result = await deliverTo(entry, alert);
        if (result === "success") sent++;
        // Provably not shown: it waits and goes again. An uncertain failure is
        // never repeated (it may already be on the phone); the inbox row stays.
        else if (result && RETRYABLE.has(result)) enqueue(entry, alert, input.kind, firstAt);
      }));
      return { sent };
    },
    async activityStatus(input) {
      const hostEndpointId = await verify(input);
      const entry = currentActivity(input);
      const enabled = Boolean(hostEndpointId && senderFor("ios"));
      return { enabled, subscribed: Boolean(enabled && entry?.hostEndpointId === hostEndpointId) };
    },
    async registerActivity(input) {
      if (typeof input.providerToken !== "string" || !PROVIDER_TOKEN.test(input.providerToken)) throw invalid("providerToken");
      if (!isEnvironment(input.environment)) throw invalid("environment");
      const hostEndpointId = await verify(input);
      if (!hostEndpointId || !senderFor("ios")) throw unavailable();
      const previous = currentActivity(input);
      // The same token is the same activity: keep what it shows.
      const same = previous?.providerToken === input.providerToken && previous.environment === input.environment;
      const entry: NativeActivity = {
        userId: input.userId, spaceId: input.spaceId, deviceId: input.deviceId, deviceEndpointId: input.deviceEndpointId, hostEndpointId,
        providerToken: input.providerToken, environment: input.environment,
        createdAt: previous?.createdAt ?? now(), updatedAt: now(),
        ...(same && previous?.track ? { track: previous.track } : {}),
      };
      state.activities = [...activities().filter((row) => accountDeviceKey(row) !== accountDeviceKey(input)), entry];
      save();
      return { ok: true };
    },
    async trackActivity(input) {
      const request = parseTrackRequest(input.track);
      if (!request) throw invalid("live activity track");
      const entry = currentActivity(input);
      const hostEndpointId = await verify(input);
      if (!entry || !hostEndpointId || entry.hostEndpointId !== hostEndpointId || !opts.activityViews) return { tracked: false };
      // Only a chat this person can open is ever evaluated for their island.
      const views = await opts.activityViews({ userId: input.userId, spaceId: input.spaceId }, [request.sessionId]);
      // A new registration may have replaced the entry while this was read.
      if (!views.has(request.sessionId) || currentActivity(input) !== entry) return { tracked: false };
      const at = now();
      entry.track = { sessionId: request.sessionId, others: request.others, sent: request.shown, trackedAt: at, pushedAt: at };
      save();
      // What the device shows may already be behind this server.
      sessionTouched(request.sessionId);
      return { tracked: true };
    },
    async untrackActivity(input) {
      const entry = currentActivity(input);
      if (!entry?.track) return false;
      delete entry.track;
      save();
      return true;
    },
    async delivery(account) {
      const rows = (await Promise.all(state.subscriptions
        .filter((row) => row.userId === account.userId && row.spaceId === account.spaceId)
        .map(async (row) => (await verify(row)) === row.hostEndpointId ? row : undefined)))
        .filter((row): row is NativeSubscription => Boolean(row));
      // With no phone yet, report what a new iPhone would use.
      const platforms = new Set<Platform>(rows.length ? rows.map((row) => destinationOf(row).platform) : ["ios"]);
      const used = [...platforms].flatMap((platform) => { const via = pick(platform); return via ? [{ route: via.route, platform }] : []; });
      const keys = new Set(rows.map(accountDeviceKey));
      const waiting = [...pending.values()].filter((item) => keys.has(item.deviceKey)).length;
      if (!used.length) return { phones: rows.length, route: "none", state: "failing", pending: waiting };
      const stale = (key: string) => { const seen = health.get(key); return !seen || now() - seen.at > PROBE_STALE_MS; };
      if (used.some((use) => use.route === "service" && stale(healthKey("service", use.platform)))) await probeService();
      const seen = used.map((use) => health.get(healthKey(use.route, use.platform)));
      const failing = seen.find((entry) => entry?.problem);
      const at = seen.reduce<number | undefined>((latest, entry) => entry && (latest === undefined || entry.at > latest) ? entry.at : latest, undefined);
      return {
        phones: rows.length,
        route: used.some((use) => use.route === "service") ? "service" : "direct",
        state: failing ? "failing" : seen.every(Boolean) ? "ok" : "unknown",
        ...(failing?.problem ? { problem: failing.problem } : {}),
        ...(at !== undefined ? { checkedAt: at } : {}),
        pending: waiting,
      };
    },
    sessionTouched,
    presenceChanged,
    flushActivities,
    flushRetries,
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      pending.clear();
      if (heartbeat) clearInterval(heartbeat);
      for (const timer of settling.values()) clearTimeout(timer);
      settling.clear();
    },
  };
}

export function nativePushRoutes(service: NativePushService): RouteHandler {
  return async (rc) => {
    if (!rc.path.startsWith("/api/native-push")) return false;
    // Whether this person's phones get pushes: also asked from a computer.
    if (rc.path === "/api/native-push/delivery" && rc.method === "GET") {
      rc.json(200, await service.delivery({ userId: rc.space.userId, spaceId: rc.space.spaceId }));
      return true;
    }
    if (rc.principal.kind !== "paired-device") throw Object.assign(new Error("not allowed"), { code: "forbidden" });
    const account = { userId: rc.space.userId, spaceId: rc.space.spaceId, deviceId: rc.principal.deviceId, deviceEndpointId: rc.principal.deviceEndpointId };
    if (rc.path === "/api/native-push" && rc.method === "GET") { rc.json(200, await service.status(account)); return true; }
    if (rc.path === "/api/native-push" && rc.method === "POST") {
      const body = await rc.body();
      rc.json(200, await service.register({
        ...account, subscriptionId: body.subscriptionId, providerToken: body.providerToken, environment: body.environment,
        ...(body.platform !== undefined ? { platform: body.platform } : {}),
        ...(body.contentKey !== undefined ? { contentKey: body.contentKey } : {}),
      }));
      return true;
    }
    if (rc.path === "/api/native-push" && rc.method === "DELETE") { rc.json(200, { ok: await service.unregister(account) }); return true; }
    if (rc.path === "/api/native-push/live-activity") {
      if (rc.method === "GET") { rc.json(200, await service.activityStatus(account)); return true; }
      if (rc.method === "POST") {
        const body = await rc.body();
        rc.json(200, await service.registerActivity({ ...account, providerToken: body.providerToken, environment: body.environment }));
        return true;
      }
      if (rc.method === "PUT") { rc.json(200, await service.trackActivity({ ...account, track: await rc.body() })); return true; }
      if (rc.method === "DELETE") { rc.json(200, { ok: await service.untrackActivity(account) }); return true; }
    }
    return false;
  };
}
