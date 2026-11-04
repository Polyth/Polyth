import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Clipboard } from "@capacitor/clipboard";
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Keyboard } from "@capacitor/keyboard";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Share } from "@capacitor/share";
import { SafeArea, SystemBarsStyle } from "@capacitor-community/safe-area";
import { FilePicker } from "@capawesome/capacitor-file-picker";
import {
  isNativeMobile,
  isPairingDeepLink,
  mobileDeepLinkPath,
  returnToMobileConnectionHub,
} from "./runtime.ts";
import { installNativePolythLink } from "./nativePolythLink.ts";
import { normalizeKeyboardMotion, type KeyboardMotionEvent, type NativeKeyboardMotion } from "./keyboardMotion.ts";
import {
  NATIVE_HAPTIC_EVENT,
  nativeHapticFeedback,
  nativeTapFeedback,
  type NativeHapticKind,
} from "./haptics.ts";
import { refreshNativePushStatus } from "./nativePush.ts";

export {
  consumeNativePushOpen,
  disableNativePush,
  enableNativePush,
  nativePushAvailable,
  nativePushLocalProjectionEnabled,
  refreshNativePushStatus,
  setNativePushAuthoritativeProjection,
  setNativePushForeground,
  type NativePushClaim,
  type NativePushEnableInput,
  type NativePushOpen,
  type NativePushStatus,
} from "./nativePush.ts";
export { NativePushController, type NativePushBridge, type NativePushServer } from "./nativePushController.ts";
export {
  endNativeLiveActivity,
  LIVE_ACTIVITY_COUNTS,
  liveActivitySnapshotKey,
  nativeLiveActivityAvailable,
  nativeLiveActivityStatus,
  onNativeLiveActivityOpen,
  onNativeLiveActivityPushToken,
  setNativeLiveActivityContext,
  updateNativeLiveActivity,
  type LiveActivityPushToken,
  type LiveActivitySnapshot,
  type LiveActivityState,
  type LiveActivityTexts,
  type NativeLiveActivityContext,
  type NativeLiveActivityStatus,
} from "./nativeLiveActivity.ts";

export interface NativeMobileCallbacks {
  handleBack(): boolean;
  openDeepLink(path: string): void;
  openPairingLink?(url: string): void;
  setForeground(isActive: boolean): void;
  /** `followKeyboard`: the WebView is resized only after the keyboard has
   *  moved, so the page itself must travel with the keyboard (iOS). */
  setKeyboardInset(height: number, options?: { followKeyboard?: boolean }): void;
  /** The keyboard's real slide for the move being reported (iOS app only). */
  setKeyboardMotion?(motion: NativeKeyboardMotion): void;
}


export type NativeFilePickResult =
  | { status: "picked"; metadata: NativePickedFileMetadata[] }
  | { status: "cancelled" }
  | { status: "denied"; message: string }
  | { status: "failed"; message: string };

const disposers: Array<() => void> = [];
let installed = false;
let installationGeneration = 0;
let keyboardVisible = false;

interface NativeListenerHandle {
  remove(): Promise<void>;
}

const KeyboardMotion = registerPlugin<{
  addListener(eventName: "keyboardMotion", listener: (event: KeyboardMotionEvent) => void): Promise<PluginListenerHandle>;
}>("PolythKeyboardMotion");

/** A Capacitor listener can finish registering after its host has gone away.
 * Keep only handles from the current installation; late handles remove
 * themselves instead of escaping the disposer stack. */
function retainNativeListener(
  generation: number,
  listener: Promise<NativeListenerHandle>,
): void {
  void listener.then((handle) => {
    if (!installed || generation !== installationGeneration) {
      void handle.remove();
      return;
    }
    disposers.push(() => void handle.remove());
  }).catch(() => undefined);
}
/** The existing canonical web attachment contract accepts File objects. Keep its
 * unavoidable compatibility path below this cap until it consumes staged URIs. */
export const MAX_NATIVE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_NATIVE_SELECTION_BYTES = 16 * 1024 * 1024;
const NATIVE_STAGING_ROOT = "polyth-staging";
const MAX_NATIVE_STAGING_FILES = 64;
const MAX_NATIVE_STAGING_BYTES = 64 * 1024 * 1024;

export interface NativePickedFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  lastModified: number;
  stagingPath: string;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isCancelled = (error: unknown): boolean =>
  /cancel|dismiss|user.*closed/i.test(errorText(error));

const safeFilename = (value: string): string =>
  ((value || `polyth-${Date.now()}`).replace(/[^\w.-]+/g, "_").replace(/^\.+/, "").slice(0, 100) || "attachment");

const byteLength = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const boundedFileError = (name: string): Error =>
  new Error(`${safeFilename(name)} is larger than the ${MAX_NATIVE_FILE_BYTES / 1024 / 1024} MB mobile attachment limit.`);

const stagingPathValid = (value: string): boolean =>
  new RegExp(`^${NATIVE_STAGING_ROOT}/[a-f0-9-]{36}-[\\w.-]{1,100}$`, "u").test(value);

const stagingPath = (id: string, name: string): string => `${NATIVE_STAGING_ROOT}/${id}-${safeFilename(name)}`;

async function boundedBlobToBase64(blob: Blob): Promise<string> {
  if (blob.size > MAX_NATIVE_FILE_BYTES) throw boundedFileError("file");
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not stage the file."));
    reader.onload = () => {
      const value = reader.result;
      if (typeof value !== "string") {
        reject(new Error("Could not stage the file."));
        return;
      }
      const separator = value.indexOf(",");
      resolve(separator >= 0 ? value.slice(separator + 1) : value);
    };
    reader.readAsDataURL(blob);
  });
}

function base64Blob(base64: string, type: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function shareDownload(anchor: HTMLAnchorElement): Promise<void> {
  const response = await fetch(anchor.href, { credentials: "include" });
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
  const contentLength = response.headers.get("content-length");
  const length = contentLength === null ? undefined : byteLength(Number(contentLength));
  if (length === undefined || length > MAX_NATIVE_FILE_BYTES) {
    throw new Error(`This download is larger than the ${MAX_NATIVE_FILE_BYTES / 1024 / 1024} MB mobile sharing limit.`);
  }
  const blob = await response.blob();
  if (blob.size > MAX_NATIVE_FILE_BYTES) throw boundedFileError(anchor.download || "download");
  const path = `shared/${Date.now()}-${safeFilename(anchor.download)}`;
  try {
    // Capacitor's installed native filesystem only accepts base64. This bounded
    // fallback avoids the former ArrayBuffer + binary-string multiplication.
    await Filesystem.writeFile({
      path,
      data: await boundedBlobToBase64(blob),
      directory: Directory.Cache,
      recursive: true,
    });
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
    await Share.share({ title: safeFilename(anchor.download || "Polyth file"), files: [uri] });
  } finally {
    void Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined);
  }
}

/** Reopen app-owned staging after a process restart. Never accepts a caller path. */
export async function readNativeStagedFile(metadata: NativePickedFileMetadata): Promise<File> {
  if (!isNativeMobile() || !stagingPathValid(metadata.stagingPath)) {
    throw new Error("The staged attachment is unavailable.");
  }
  const info = await Filesystem.stat({ path: metadata.stagingPath, directory: Directory.Data });
  if (info.type !== "file" || info.size !== metadata.size || info.size > MAX_NATIVE_FILE_BYTES) {
    throw new Error("The staged attachment is unavailable.");
  }
  // Read through the bridge, never fetch(convertFileSrc(...)): the app's pages
  // run on the Link loopback origin, and Capacitor serves `_capacitor_file_`
  // without CORS headers, so WebKit rejects that fetch as "Load failed".
  let data: string | Blob;
  try {
    ({ data } = await Filesystem.readFile({ path: metadata.stagingPath, directory: Directory.Data }));
  } catch {
    throw new Error("The staged attachment is unavailable.");
  }
  const blob = typeof data === "string" ? base64Blob(data, metadata.mimeType) : data;
  if (blob.size !== metadata.size || blob.size > MAX_NATIVE_FILE_BYTES) {
    throw new Error("The staged attachment changed or is too large.");
  }
  return new File([blob], metadata.name, { type: metadata.mimeType, lastModified: metadata.lastModified });
}

export async function removeNativeStagedFile(metadata: Pick<NativePickedFileMetadata, "stagingPath">): Promise<void> {
  if (!stagingPathValid(metadata.stagingPath)) return;
  await Filesystem.deleteFile({ path: metadata.stagingPath, directory: Directory.Data }).catch(() => undefined);
}

async function assertNativeStagingCapacity(additionalFiles: number, additionalBytes: number): Promise<void> {
  const result = await Filesystem.readdir({ path: NATIVE_STAGING_ROOT, directory: Directory.Data });
  let files = 0;
  let bytes = 0;
  for (const file of result?.files ?? []) {
    if (file.type !== "file" || !stagingPathValid(`${NATIVE_STAGING_ROOT}/${file.name}`)) continue;
    files += 1;
    bytes += byteLength(file.size) ?? MAX_NATIVE_FILE_BYTES;
  }
  if (files + additionalFiles > MAX_NATIVE_STAGING_FILES
    || bytes + additionalBytes > MAX_NATIVE_STAGING_BYTES) {
    throw new Error("Mobile attachment staging is full. Reopen pending drafts to finish or remove their files before attaching more.");
  }
}

/** `photos` opens the system photo library; `files` the document picker. */
export async function pickNativeFiles(source: "files" | "photos" = "files"): Promise<NativeFilePickResult> {
  if (!isNativeMobile()) return { status: "failed", message: "Native file picking is unavailable." };
  try {
    // Ask the native picker for URI metadata, not eager file data. Retain it in
    // app-owned staging before the capped compatibility read below. Library
    // photos are transcoded (HEIC to JPEG on iOS) so every model can read them.
    const result = source === "photos"
      ? await FilePicker.pickImages({ readData: false, skipTranscoding: false })
      : await FilePicker.pickFiles({ readData: false });
    if (result.files.length === 0) return { status: "cancelled" };
    if (result.files.length > 16) throw new Error("Choose at most 16 files at a time.");
    let selectedBytes = 0;
    for (const picked of result.files) {
      const size = byteLength(picked.size);
      if (size === undefined) throw new Error(`Could not determine the size of ${picked.name || "attachment"}.`);
      if (size > MAX_NATIVE_FILE_BYTES || selectedBytes + size > MAX_NATIVE_SELECTION_BYTES) {
        throw boundedFileError(picked.name || "attachment");
      }
      selectedBytes += size;
    }
    await Filesystem.mkdir({ path: NATIVE_STAGING_ROOT, directory: Directory.Data, recursive: true })
      .catch(() => undefined);
    await assertNativeStagingCapacity(result.files.length, selectedBytes);
    const metadata: NativePickedFileMetadata[] = [];
    try {
      for (const picked of result.files) {
        const size = byteLength(picked.size)!;
        if (!picked.path) throw new Error(`Could not stage ${picked.name || "attachment"}.`);
        const id = crypto.randomUUID();
        const next: NativePickedFileMetadata = {
          id,
          name: safeFilename(picked.name || "attachment"),
          mimeType: picked.mimeType || "application/octet-stream",
          size,
          lastModified: picked.modifiedAt ?? Date.now(),
          stagingPath: stagingPath(id, picked.name || "attachment"),
        };
        // `getUri` is a path resolver, not file creation. Ensure the app-owned
        // parent exists; the UUID destination itself must not exist yet.
        const destination = await Filesystem.getUri({ path: next.stagingPath, directory: Directory.Data });
        metadata.push(next);
        // capawesome 8.0.4's Android existence branch is reversed for
        // overwrite:false. UUID paths are app-owned, so overwrite:true is safe.
        await FilePicker.copyFile({ from: picked.path, to: destination.uri, overwrite: true });
      }
    } catch (error) {
      await Promise.all(metadata.map((item) => removeNativeStagedFile(item)));
      throw error;
    }
    await nativeTapFeedback();
    return { status: "picked", metadata };
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
  const generation = ++installationGeneration;
  installNativePolythLink();
  document.body.dataset.nativePlatform = Capacitor.getPlatform();

  void SafeArea.setSystemBarsStyle({ style: SystemBarsStyle.Default });
  // The launch screen is not lifted here: the page hands it over to its own
  // launch veil (apps/web main.tsx), which lifts once the workspace settled.
  // This only reads a semantic status. Native push keeps provider and relay
  // credentials in platform secure storage; a failed status remains local
  // notifications/browser fallback rather than disabling delivery.
  void refreshNativePushStatus().catch(() => undefined);

  retainNativeListener(generation, App.addListener("appStateChange", ({ isActive }) => {
    callbacks.setForeground(isActive);
  }));

  retainNativeListener(generation, App.addListener("appUrlOpen", ({ url }) => {
    if (isPairingDeepLink(url) || mobileDeepLinkPath(url)) {
      // The native layer has already captured the raw OS URL in process memory.
      // Never apply an ambiguous external link to whichever server happens to
      // be active; reload the bundled Connection Hub and resolve the server there.
      void returnToMobileConnectionHub();
    }
  }));

  retainNativeListener(generation, App.addListener("backButton", () => {
    if (keyboardVisible) {
      void Keyboard.hide().catch(() => {
        keyboardVisible = false;
        callbacks.setKeyboardInset(0);
      });
      return;
    }
    if (!callbacks.handleBack()) void App.minimizeApp();
  }));

  // The iOS plugin (KeyboardResize.Native) resizes the WebView only after the
  // keyboard's slide plus 0.2 s, so the page follows the keyboard from these
  // will-show/will-hide events. Android's WebView is resized by the window
  // insets themselves and keeps measuring its own geometry.
  const followKeyboard = Capacitor.getPlatform() === "ios";
  retainNativeListener(generation, Keyboard.addListener("keyboardWillShow", ({ keyboardHeight }) => {
    keyboardVisible = true;
    callbacks.setKeyboardInset(keyboardHeight, { followKeyboard });
  }));
  retainNativeListener(generation, Keyboard.addListener("keyboardWillHide", () => {
    keyboardVisible = false;
    callbacks.setKeyboardInset(0, { followKeyboard });
  }));
  // The keyboard's real curve, so whatever rides it moves as one with it.
  if (followKeyboard && callbacks.setKeyboardMotion && Capacitor.isPluginAvailable("PolythKeyboardMotion")) {
    const setKeyboardMotion = callbacks.setKeyboardMotion;
    retainNativeListener(generation, KeyboardMotion.addListener("keyboardMotion", (event) => {
      const motion = normalizeKeyboardMotion(event);
      if (motion) setKeyboardMotion(motion);
    }));
  }

  retainNativeListener(generation, LocalNotifications.addListener("localNotificationActionPerformed", ({ notification }) => {
    const sessionId = (notification.extra as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof sessionId === "string" && sessionId) {
      void returnToMobileConnectionHub(`/?session=${encodeURIComponent(sessionId)}`);
    }
  }));

  const onHaptic = (event: Event) => {
    const kind = (event as CustomEvent<NativeHapticKind>).detail;
    if (kind === "selection" || kind === "tap" || kind === "success" || kind === "warning" || kind === "error") {
      void nativeHapticFeedback(kind);
    }
  };
  window.addEventListener(NATIVE_HAPTIC_EVENT, onHaptic);
  disposers.push(() => window.removeEventListener(NATIVE_HAPTIC_EVENT, onHaptic));

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
      void returnToMobileConnectionHub(deepLink);
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
  // Invalidate first: asynchronous `addListener` completions can arrive while
  // the existing handles are being removed or after a later re-installation.
  installationGeneration += 1;
  keyboardVisible = false;
  installed = false;
  while (disposers.length > 0) disposers.pop()?.();
}
