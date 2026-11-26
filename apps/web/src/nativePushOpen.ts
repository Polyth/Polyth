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

/** How long boot restoration waits for the chat of a tapped notification
 *  before it restores the remembered one. The inbox read starts before boot
 *  does, on a connection that has just answered; past this the remembered
 *  chat shows first and the tap moves to its own once the answer arrives. */
export const NATIVE_PUSH_BOOT_WAIT_MS = 1_200;

let bootTarget: Promise<string | undefined> | undefined;

/** The chat a tapped notification names, for boot restoration to land on.
 *  Restoring the remembered chat first showed one chat and then opened
 *  another over it; when both were the same chat it was loaded twice. */
export function offerNativePushBootTarget(sessionId: Promise<string | undefined>): void {
  bootTarget = sessionId.catch(() => undefined);
}

/** Taken once, by boot restoration. `undefined` when no tap is waiting or its
 *  chat is not known within `NATIVE_PUSH_BOOT_WAIT_MS`. */
export async function takeNativePushBootTarget(
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<string | undefined> {
  const target = bootTarget;
  bootTarget = undefined;
  if (!target) return undefined;
  return await Promise.race([target, wait(NATIVE_PUSH_BOOT_WAIT_MS).then(() => undefined)]);
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

export interface NativePushTapDeps {
  /** The tap the native app holds for this page's server and account, if any.
   *  Claiming does not remove it: `settle` does. */
  claim(): Promise<string | undefined>;
  /** Opens the tap's chat; resolves when the attempt is over either way. */
  open(notificationId: string): Promise<unknown>;
  settle(notificationId: string): Promise<void>;
}

/** Taps reaching a page that is already running, one at a time.
 *
 *  The native app keeps a tap until the page settles it, so a page that is
 *  loaded again mid-open claims it once more; within one page a tap is opened
 *  once, however many times it is announced. The claim itself is not queued
 *  behind an open in flight: the native side sends an unclaimed tap through
 *  the hub after a few seconds, and that reloads the page. */
export function nativePushTaps(deps: NativePushTapDeps): {
  /** A tap already in hand: the landing address, or a claim made during boot. */
  open(notificationId: string): Promise<void>;
  /** The native app announced a tap, or one may have arrived unannounced. */
  take(): Promise<void>;
} {
  const handled = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  const run = (id: Promise<string | undefined>): Promise<void> => {
    chain = chain.then(async () => {
      const notificationId = await id.catch(() => undefined);
      if (!notificationId) return;
      if (!handled.has(notificationId)) {
        handled.add(notificationId);
        await deps.open(notificationId).catch(() => undefined);
      }
      await deps.settle(notificationId).catch(() => undefined);
    });
    return chain;
  };
  return {
    open: (notificationId) => run(Promise.resolve(notificationId)),
    take: () => run(deps.claim()),
  };
}
