// A tapped phone notification, from the landing address to the opened chat
// (docs/mobile/platform-behavior.md "Notifications"). DOM-free: nativePush.ts
// supplies the page, the native bridge and the server.

const PARAM = "nativePushOpen";
const NOTIFICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** The tapped notification the landing address names, if it is a canonical id.
 *
 *  Read it when the page loads and keep it. Boot restoration rewrites the
 *  address to the chat it restored (init.ts `syncUrl`) before hydration ends,
 *  so a reader that waited for hydration found nothing and the tap opened
 *  whatever the app showed last. */
export function landedNativePushOpen(search: string): string | undefined {
  const id = new URLSearchParams(search).get(PARAM);
  return id && NOTIFICATION_ID.test(id) ? id.toLowerCase() : undefined;
}

/** `href` as a same-origin path without the tap's id, or `undefined` when it
 *  carries none (nothing to clean, so the address is left alone). */
export function withoutNativePushOpen(href: string): string | undefined {
  const url = new URL(href);
  if (!url.searchParams.has(PARAM)) return undefined;
  url.searchParams.delete(PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

export interface NativePushOpenDeps {
  /** Whether this device's registration is confirmed by the signed-in server. */
  registered(): Promise<boolean>;
  /** The account's own inbox row for the id: its chat, `"gone"` when the
   *  server refuses it (not this account's, deleted, malformed), or
   *  `"unreachable"` when no answer came. */
  record(notificationId: string): Promise<{ sessionId: string } | "gone" | "unreachable">;
  open(sessionId: string): Promise<void>;
  markRead(notificationId: string): Promise<void>;
  wait(ms: number): Promise<void>;
}

/** Waits before another try. The app has just reconnected when a tap lands,
 *  so the registration check or the inbox read can fail for a moment; the
 *  address no longer holds the id for a reload to retry with. */
export const NATIVE_PUSH_OPEN_RETRY_MS: readonly number[] = [1_000, 3_000, 6_000];

export type NativePushOpenOutcome = "opened" | "dropped";

/** Opens the chat of a tapped notification. The id selects only a row of the
 *  signed-in account's inbox, never a chat by itself; a row the server does
 *  not hand out ends the attempt. */
export async function openNativePushTarget(notificationId: string, deps: NativePushOpenDeps): Promise<NativePushOpenOutcome> {
  for (let attempt = 0; ; attempt++) {
    const record = await deps.registered().catch(() => false)
      ? await deps.record(notificationId).catch((): "unreachable" => "unreachable")
      : "unreachable";
    if (record === "gone") return "dropped";
    if (record !== "unreachable") {
      try {
        await deps.open(record.sessionId);
        await deps.markRead(notificationId);
      } catch {
        // A deleted, archived or no longer shared chat: the restored screen stays.
      }
      return "opened";
    }
    const delay = NATIVE_PUSH_OPEN_RETRY_MS[attempt];
    if (delay === undefined) return "dropped";
    await deps.wait(delay);
  }
}
