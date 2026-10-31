import { App } from "@capacitor/app";
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import {
  liveActivitySessionFromUrl,
  normalizeLiveActivitySnapshot,
  type LiveActivitySnapshot,
} from "./liveActivityPayload.ts";

export {
  liveActivitySessionFromUrl,
  liveActivitySnapshotKey,
  normalizeLiveActivitySnapshot,
  type LiveActivitySnapshot,
  type LiveActivityState,
} from "./liveActivityPayload.ts";

export interface NativeLiveActivityStatus {
  /** iOS 16.2+ with the widget extension embedded in this build. */
  supported: boolean;
  /** The person allows Live Activities for Polyth (iOS Settings). */
  enabled: boolean;
}

interface NativeLiveActivityPlugin {
  getStatus(): Promise<NativeLiveActivityStatus>;
  update(options: { snapshot: LiveActivitySnapshot }): Promise<{ active: boolean }>;
  end(options: { final?: LiveActivitySnapshot }): Promise<{ active: boolean }>;
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

/** Start or update the activity. Resolves false when iOS declined it (not
 * foreground, disabled in Settings, budget) — never a reason to retry hot. */
export async function updateNativeLiveActivity(snapshot: LiveActivitySnapshot): Promise<boolean> {
  if (!nativeLiveActivityAvailable()) return false;
  const normalized = normalizeLiveActivitySnapshot(snapshot);
  if (!normalized) return false;
  return (await NativeLiveActivity.update({ snapshot: normalized })).active === true;
}

/** End the activity; a `final` snapshot stays on the Lock Screen briefly. */
export async function endNativeLiveActivity(final?: LiveActivitySnapshot): Promise<void> {
  if (!nativeLiveActivityAvailable()) return;
  const normalized = final ? normalizeLiveActivitySnapshot(final) : undefined;
  await NativeLiveActivity.end(normalized ? { final: normalized } : {});
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
