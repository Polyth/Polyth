/** DOM-free validation for the only native-push routing data that reaches JS. */
export interface NativePushOpen {
  connectionId: string;
  accountId: string;
  notificationId: string;
}

export const OPAQUE_NATIVE_PUSH_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseNativePushOpen(value: Partial<NativePushOpen>): NativePushOpen | undefined {
  if (!value || !OPAQUE_NATIVE_PUSH_ID.test(value.connectionId ?? "") || !OPAQUE_NATIVE_PUSH_ID.test(value.accountId ?? "")
    || !UUID.test(value.notificationId ?? "")) return undefined;
  return {
    connectionId: value.connectionId!,
    accountId: value.accountId!,
    notificationId: value.notificationId!.toLowerCase(),
  };
}
