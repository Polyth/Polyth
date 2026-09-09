import { Capacitor, registerPlugin } from "@capacitor/core";

interface PolythNavigationPlugin {
  consumePendingUrl(): Promise<{ url?: string }>;
}

const NativeNavigation = registerPlugin<PolythNavigationPlugin>("PolythNavigation");

export function nativeNavigationAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("PolythNavigation");
}

export async function consumeNativePendingUrl(): Promise<string | undefined> {
  if (!nativeNavigationAvailable()) return undefined;
  const { url } = await NativeNavigation.consumePendingUrl();
  return typeof url === "string" && url ? url : undefined;
}
