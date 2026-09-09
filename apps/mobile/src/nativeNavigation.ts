import { Capacitor, registerPlugin } from "@capacitor/core";

interface PolythNavigationPlugin {
  consumePendingUrl(): Promise<{ url?: string }>;
}

const NativeNavigation = registerPlugin<PolythNavigationPlugin>("PolythNavigation");

export async function consumeNativePendingUrl(): Promise<string | undefined> {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable("PolythNavigation")) return undefined;
  const { url } = await NativeNavigation.consumePendingUrl();
  return typeof url === "string" && url ? url : undefined;
}
