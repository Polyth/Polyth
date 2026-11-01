import { App } from "@capacitor/app";
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import {
  liveActivitySessionFromUrl,
  normalizeLiveActivitySnapshot,
  normalizeLiveActivityTexts,
  parseLiveActivityPushToken,
  type LiveActivityPushToken,
  type LiveActivitySnapshot,
  type LiveActivityTexts,
} from "./liveActivityPayload.ts";

export {
  LIVE_ACTIVITY_COUNTS,
  liveActivitySessionFromUrl,
  liveActivitySnapshotKey,
  normalizeLiveActivitySnapshot,
  type LiveActivityPushToken,
  type LiveActivitySnapshot,
  type LiveActivityState,
  type LiveActivityTexts,
} from "./liveActivityPayload.ts";

export interface NativeLiveActivityStatus {
  /** iOS 16.2+ with the widget extension embedded in this build. */
  supported: boolean;
  /** The person allows Live Activities for Polyth (iOS Settings). */
  enabled: boolean;
}

/** Whether the activity takes pushes for this page (an account was named and
 *  the build has an APNs environment). */
export interface NativeLiveActivityContext {
  push: boolean;
}

interface NativeLiveActivityPlugin {
  getStatus(): Promise<NativeLiveActivityStatus>;
  update(options: { snapshot: LiveActivitySnapshot; staleAt?: number }): Promise<{ active: boolean }>;
  end(options: { final?: LiveActivitySnapshot }): Promise<{ active: boolean }>;
  setContext(options: { accountId?: string; texts: LiveActivityTexts }): Promise<NativeLiveActivityContext>;
  addListener(event: "pushToken", listener: (token: unknown) => void): Promise<PluginListenerHandle>;
}

const NativeLiveActivity = registerPlugin<NativeLiveActivityPlugin>("PolythLiveActivity");

export function nativeLiveActivityAvailable(): boolean {
  return Capacitor.isNativePlatform()
    && Capacitor.getPlatform() === "ios"
    && Capacitor.isPluginAvailable("PolythLiveActivity");
}

export async function nativeLiveActivityStatus(): Promise<NativeLiveActivityStatus> {
  if (!nativeLiveActivityAvailable()) return { supported: false, enabled: false };
  const status = await NativeLiveActivity.getStatus();
  return { supported: status.supported === true, enabled: status.enabled === true };
}

/** Start or update the activity. `staleAt` (epoch ms, 0 = already stale) is
 * when iOS marks it stale; native caps it at 15 minutes and uses that cap when
 * it is absent. Resolves false when iOS declined it (not foreground, disabled
 * in Settings, budget) — never a reason to retry hot. */
export async function updateNativeLiveActivity(snapshot: LiveActivitySnapshot, staleAt?: number): Promise<boolean> {
  if (!nativeLiveActivityAvailable()) return false;
  const normalized = normalizeLiveActivitySnapshot(snapshot);
  if (!normalized) return false;
  const stale = typeof staleAt === "number" && Number.isFinite(staleAt) && staleAt >= 0 ? { staleAt: Math.floor(staleAt) } : {};
  return (await NativeLiveActivity.update({ snapshot: normalized, ...stale })).active === true;
}

/** End the activity; a `final` snapshot stays on the Lock Screen briefly. */
export async function endNativeLiveActivity(final?: LiveActivitySnapshot): Promise<void> {
  if (!nativeLiveActivityAvailable()) return;
  const normalized = final ? normalizeLiveActivitySnapshot(final) : undefined;
  await NativeLiveActivity.end(normalized ? { final: normalized } : {});
}

/** Hands native the words a push cannot carry and, with an account, lets the
 * activity take pushes for this page's connection/account. Call it before the
 * first update: an activity started without a push token never takes one. */
export async function setNativeLiveActivityContext(input: { accountId?: string; texts: LiveActivityTexts }): Promise<NativeLiveActivityContext> {
  if (!nativeLiveActivityAvailable()) return { push: false };
  const context = await NativeLiveActivity.setContext({ ...input, texts: normalizeLiveActivityTexts(input.texts) });
  return { push: context.push === true };
}

/** Each push token of the activity, for the page to register with its server. */
export function onNativeLiveActivityPushToken(listener: (token: LiveActivityPushToken) => void): () => void {
  if (!nativeLiveActivityAvailable()) return () => {};
  let removed = false;
  let handle: PluginListenerHandle | undefined;
  void NativeLiveActivity.addListener("pushToken", (raw) => {
    const token = parseLiveActivityPushToken(raw);
    if (token) listener(token);
  }).then((next) => {
    if (removed) void next.remove();
    else handle = next;
  }).catch(() => undefined);
  return () => {
    removed = true;
    void handle?.remove();
  };
}

/** Taps on the activity arrive as `polyth://live-activity/<id>`. The caller
 * decides whether that id belongs to the page it runs in. */
export function onNativeLiveActivityOpen(listener: (sessionId: string) => void): () => void {
  if (!nativeLiveActivityAvailable()) return () => {};
  let removed = false;
  let handle: PluginListenerHandle | undefined;
  void App.addListener("appUrlOpen", ({ url }) => {
    const sessionId = liveActivitySessionFromUrl(url);
    if (sessionId) listener(sessionId);
  }).then((next) => {
    if (removed) void next.remove();
    else handle = next;
  }).catch(() => undefined);
  return () => {
    removed = true;
    void handle?.remove();
  };
}
