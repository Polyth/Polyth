import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";

export const NATIVE_HAPTIC_EVENT = "polyth:native-haptic";
export type NativeHapticKind = "selection" | "tap" | "success" | "warning" | "error";

/** Native backend for the shared semantic haptic event. Unsupported hardware
 * resolves silently in Capacitor; feedback never controls the UI action. */
export async function nativeHapticFeedback(kind: NativeHapticKind): Promise<void> {
  const action = kind === "selection"
    ? Haptics.selectionChanged()
    : kind === "tap"
      ? Haptics.impact({ style: ImpactStyle.Light })
      : Haptics.notification({
          type: kind === "success"
            ? NotificationType.Success
            : kind === "warning"
              ? NotificationType.Warning
              : NotificationType.Error,
        });
  await action.catch(() => undefined);
}

/** Invoke only after a completed, local user choice. Native bridge events and
 * streamed/replayed state must not produce haptic feedback. */
export async function nativeTapFeedback(): Promise<void> {
  await nativeHapticFeedback("tap");
}
