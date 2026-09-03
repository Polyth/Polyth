import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Clipboard } from "@capacitor/clipboard";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { Keyboard } from "@capacitor/keyboard";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Share } from "@capacitor/share";
import { SplashScreen } from "@capacitor/splash-screen";
import { SafeArea, SystemBarsStyle } from "@capacitor-community/safe-area";
import { FilePicker } from "@capawesome/capacitor-file-picker";
import { mobileDeepLinkPath, isNativeMobile } from "./runtime.ts";
import { rememberPendingPairingLink } from "./pendingPair.ts";

export interface NativeMobileCallbacks {
  handleBack(): boolean;
  openDeepLink(path: string): void;
  openPairingLink?(url: string): void;
  reconnect(): void;
  setKeyboardInset(height: number): void;
}

export type NativeFilePickResult =
  | { status: "picked"; files: File[] }
  | { status: "cancelled" }
  | { status: "denied"; message: string }
  | { status: "failed"; message: string };

const disposers: Array<() => void> = [];
let installed = false;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isCancelled = (error: unknown): boolean =>
  /cancel|dismiss|user.*closed/i.test(errorText(error));

const safeFilename = (value: string): string =>
  (value || `polyth-${Date.now()}`).replace(/[^\w.-]+/g, "_").slice(0, 100);

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

async function shareDownload(anchor: HTMLAnchorElement): Promise<void> {
  const response = await fetch(anchor.href, { credentials: "include" });
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
  const blob = await response.blob();
  const path = `shared/${Date.now()}-${safeFilename(anchor.download)}`;
  await Filesystem.writeFile({
    path,
    data: await blobToBase64(blob),
    directory: Directory.Cache,
    recursive: true,
  });
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
  await Share.share({ title: anchor.download || "Polyth file", files: [uri] });
}

export async function pickNativeFiles(): Promise<NativeFilePickResult> {
  if (!isNativeMobile()) return { status: "failed", message: "Native file picking is unavailable." };
  try {
    // The system document picker grants scoped access to the chosen files; no
    // broad photo-library or storage permission is requested.
    const result = await FilePicker.pickFiles();
    if (result.files.length === 0) return { status: "cancelled" };
    const files = await Promise.all(result.files.map(async (picked) => {
      let blob: Blob;
      if (picked.blob) {
        blob = picked.blob;
      } else {
        if (!picked.path) throw new Error(`Could not read ${picked.name}`);
        const response = await fetch(Capacitor.convertFileSrc(picked.path));
        if (!response.ok) throw new Error(`Could not read ${picked.name}`);
        blob = await response.blob();
      }
      return new File([blob], picked.name || "attachment", {
        type: picked.mimeType || blob.type || "application/octet-stream",
        lastModified: picked.modifiedAt ?? Date.now(),
      });
    }));
    await Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
    return { status: "picked", files };
  } catch (error) {
    if (isCancelled(error)) return { status: "cancelled" };
    if (/denied|permission|not authorized/i.test(errorText(error))) {
      return { status: "denied", message: "File access was denied. Choose a file and allow access to attach it." };
    }
    return { status: "failed", message: `Could not open the file: ${errorText(error)}` };
  }
}

export async function writeNativeClipboard(text: string): Promise<boolean> {
  if (!isNativeMobile()) return false;
  try {
    await Clipboard.write({ string: text });
    return true;
  } catch {
    return false;
  }
}

export async function requestNativeNotificationPermission(): Promise<void> {
  if (!isNativeMobile()) return;
  const current = await LocalNotifications.checkPermissions();
  if (current.display === "prompt" || current.display === "prompt-with-rationale") {
    await LocalNotifications.requestPermissions();
  }
}

export async function showNativeLocalNotification(options: {
  id: number;
  title: string;
  body: string;
  extra?: Record<string, string>;
}): Promise<void> {
  if (!isNativeMobile()) return;
  const permission = await LocalNotifications.checkPermissions();
  if (permission.display !== "granted") return;
  await LocalNotifications.schedule({
    notifications: [{
      id: Math.max(1, options.id),
      title: options.title,
      body: options.body,
      schedule: { at: new Date(Date.now() + 100) },
      ...(options.extra ? { extra: options.extra } : {}),
    }],
  });
}

export function installNativeMobileIntegration(callbacks: NativeMobileCallbacks): void {
  if (!isNativeMobile() || installed) return;
  installed = true;
  document.body.dataset.nativePlatform = Capacitor.getPlatform();

  void SafeArea.setSystemBarsStyle({ style: SystemBarsStyle.Default });
  void SplashScreen.hide();

  void App.addListener("appStateChange", ({ isActive }) => {
    if (isActive) callbacks.reconnect();
  }).then((handle) => disposers.push(() => void handle.remove()));

  void App.addListener("appUrlOpen", ({ url }) => {
    if (url.trim().startsWith("polyth://pair")) {
      rememberPendingPairingLink(url);
      callbacks.openPairingLink?.(url);
      return;
    }
    const path = mobileDeepLinkPath(url);
    if (path) callbacks.openDeepLink(path);
  }).then((handle) => disposers.push(() => void handle.remove()));

  void App.addListener("backButton", () => {
    if (!callbacks.handleBack()) void App.minimizeApp();
  }).then((handle) => disposers.push(() => void handle.remove()));

  void Keyboard.addListener("keyboardWillShow", ({ keyboardHeight }) => {
    callbacks.setKeyboardInset(keyboardHeight);
  }).then((handle) => disposers.push(() => void handle.remove()));
  void Keyboard.addListener("keyboardWillHide", () => {
    callbacks.setKeyboardInset(0);
  }).then((handle) => disposers.push(() => void handle.remove()));

  void LocalNotifications.addListener("localNotificationActionPerformed", ({ notification }) => {
    const sessionId = (notification.extra as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof sessionId === "string" && sessionId) {
      callbacks.openDeepLink(`/?session=${encodeURIComponent(sessionId)}`);
    }
  }).then((handle) => disposers.push(() => void handle.remove()));

  const onClick = (event: MouseEvent) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>("a[href]")
      : null;
    if (!target) return;
    if (target.download) {
      event.preventDefault();
      void shareDownload(target).catch(() => undefined);
      return;
    }
    let url: URL;
    try {
      url = new URL(target.href, location.href);
    } catch {
      return;
    }
    if (url.origin === location.origin) return;
    const deepLink = mobileDeepLinkPath(url.href);
    if (url.protocol === "polyth:" && deepLink) {
      event.preventDefault();
      callbacks.openDeepLink(deepLink);
      return;
    }
    if (url.protocol === "http:" || url.protocol === "https:") {
      event.preventDefault();
      void Browser.open({ url: url.href });
    }
  };
  document.addEventListener("click", onClick, true);
  disposers.push(() => document.removeEventListener("click", onClick, true));
}

export function disposeNativeMobileIntegration(): void {
  while (disposers.length > 0) disposers.pop()?.();
  installed = false;
}
