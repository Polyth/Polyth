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

/** Sends to APNs/FCM: the hosted push service (`relaySender`) or this
 *  server's own APNs key (`ApnsProvider` from @polyth/push-relay). */
export interface PushSender {
  deliver(destination: Destination, input: DeliveryInput): Promise<ProviderClass>;
  deliverActivity(destination: Destination, input: ActivityInput): Promise<ProviderClass>;
  close?(): void;
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

/** The hosted push service (`packages/push-relay`): it receives the device
 *  token and a payload of enums, counts, times and device-sealed text. Unset
 *  means Polyth's own; `off` (or any value that is not an https origin) sends
 *  no push through a service. */
export function relaySender(origin: string | undefined, fetchFn: typeof fetch = fetch): PushSender | undefined {
  const url = relayOrigin(origin || PUSH_SERVICE_ORIGIN);
  if (!url) return undefined;
  const post = async (body: unknown): Promise<ProviderClass> => {
    try {
      const response = await fetchFn(new URL("/v1/send", url), {
        method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error",
        headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (response.status === 429) return "rate";
      if (response.status === 400) return "invalid";
      const result = response.ok ? (await response.json() as { result?: unknown }).result : undefined;
      return typeof result === "string" && PROVIDER_CLASSES.has(result) ? result as ProviderClass : "transient";
    } catch { return "transient"; }
  };
  const to = (destination: Destination) => ({
    platform: destination.platform, token: destination.providerToken,
    ...(destination.platform === "ios" ? { environment: destination.environment } : {}),
  });
  return {
    deliver: (destination, alert) => post({ to: to(destination), alert }),
    deliverActivity: (destination, activity) => post({ to: to(destination), activity }),
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
  /** Evaluate every tracked island now (heartbeat tick; tests). */
  flushActivities(): Promise<void>;
  close(): void;
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
}): NativePushService {
  const senderFor = (platform: Platform): PushSender | undefined => (platform === "ios" ? opts.apns?.() : undefined) ?? opts.relay;
  const now = opts.now ?? Date.now;
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
  /** The pinned host identity when this device may receive native push at all. */
  const verify = async (input: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string }): Promise<string | undefined> => {
    const authority = opts.authority?.();
    if ((!opts.relay && !opts.apns?.()) || !authority || !await authority.validate(input)) return undefined;
    const hostEndpointId = await authority.hostEndpointId();
    return isText(hostEndpointId) ? hostEndpointId : undefined;
  };
  const current = (input: { userId: string; spaceId: string; deviceId: string; deviceEndpointId: string }) =>
    state.subscriptions.find((entry) => accountDeviceKey(entry) === accountDeviceKey(input));
  const activities = (): NativeActivity[] => state.activities ?? [];
  const currentActivity = (input: { userId: string; spaceId: string; deviceEndpointId: string }) =>
    activities().find((entry) => accountDeviceKey(entry) === accountDeviceKey(input));
  const contentKeyOf = (value: unknown): NativeContentKey | undefined => {
    if (value === undefined || value === null) return undefined;
    const key = parseContentKey(value);
    if (!key) throw invalid("contentKey");
    return key;
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
    const sender = senderFor("ios");
    const hostEndpointId = await verify(entry);
    if (!sender || !hostEndpointId || hostEndpointId !== entry.hostEndpointId) return;
    const views = await opts.activityViews({ userId: entry.userId, spaceId: entry.spaceId }, [track.sessionId, ...track.others]);
    const focus = views.get(track.sessionId);
    const content = liveActivityContent(focus, track.others.map((id) => views.get(id)));
    const ended = !LIVE_STATES.has(content.state) && content.waiting + content.working === 0;
    const changed = !sameContent(content, track.sent);
    if (!changed && !ended && at - track.pushedAt < LIVE_ACTIVITY_HEARTBEAT_MS) return;
    const seconds = Math.floor(at / 1_000);
    const startedAt = content.startedAt !== undefined ? Math.floor(content.startedAt / 1_000) : undefined;
    const result = await sender.deliverActivity(
      { subscriptionId: "live-activity", version: 1, platform: "ios", environment: entry.environment, channel: "liveactivity", providerToken: entry.providerToken },
      {
        event: ended ? "end" : "update",
        state: content.state,
        // A start older than a week is not drawn as a running timer.
        ...(startedAt !== undefined && startedAt > seconds - 7 * 24 * 3600 && startedAt <= seconds ? { startedAt } : {}),
        waiting: content.waiting,
        working: content.working,
        staleAt: seconds + LIVE_ACTIVITY_PUSH_TRUST_MS / 1_000,
        // A chat that is gone (or no longer readable) leaves at once; a finished one stays briefly.
        ...(ended ? { dismissAt: focus ? seconds + LIVE_ACTIVITY_DISMISS_MS / 1_000 : seconds } : {}),
        urgent: changed || ended,
      },
    ).catch((): ProviderClass => "transient");
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
      const entry: NativeSubscription = {
        userId: input.userId, spaceId: input.spaceId, deviceId: input.deviceId, deviceEndpointId: input.deviceEndpointId, hostEndpointId,
        subscriptionId: input.subscriptionId, providerToken: input.providerToken,
        ...(platform === "android" ? { platform } : { environment: input.environment as Environment }),
        createdAt: previous?.createdAt ?? now(), updatedAt: now(),
        // A registration without a key clears the previous one.
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
      for (const entry of state.subscriptions.filter((row) => row.userId === input.userId && row.spaceId === input.spaceId)) {
        const hostEndpointId = await verify(entry);
        const destination = destinationOf(entry);
        const sender = senderFor(destination.platform);
        if (!sender || !hostEndpointId || hostEndpointId !== entry.hostEndpointId) continue;
        let sealed: string | undefined;
        if (entry.contentKey && typeof input.title === "string" && typeof input.body === "string") {
          try { sealed = sealNativeContent(entry.contentKey, input.title, input.body); } catch { /* generic text */ }
        }
        const result = await sender.deliver(destination, {
          version: 1, subscriptionId: entry.subscriptionId, notificationId: input.notificationId, kind: input.kind, tag: nativePushTag(input.transitionKey),
          ...(sealed ? { sealed } : {}),
        }).catch((): ProviderClass => "transient");
        // Best effort: a failed push is never replayed; the inbox row stays.
        if (result === "success") sent++;
        else if (result === "permanent") {
          // The provider retired the token (app removed or token replaced): stop sending.
          state.subscriptions = state.subscriptions.filter((row) => row !== entry);
          save();
        }
      }
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
    sessionTouched,
    flushActivities,
    close() {
      if (heartbeat) clearInterval(heartbeat);
      for (const timer of settling.values()) clearTimeout(timer);
      settling.clear();
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
