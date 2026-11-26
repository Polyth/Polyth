// Pure helpers the Accounts section and the timeline need of a Relay's rows.
import type { RelayMemberView, RelayView } from "@polyth/harness-runtime/relay";

export type { RelayMemberView, RelayView };
export type RelayTranslate = (key: string, values?: Record<string, string | number>) => string;

/** How the unified account list is ordered: with My order the Relay members
 *  come first in their order (the rows a person drags), then everything else
 *  in server order; otherwise rows keep the server order so nothing jumps
 *  when an account joins or leaves Relay. */
export function relayRowOrder<T extends { harnessId: string }>(accounts: readonly T[], rows: readonly RelayMemberView[], manual: boolean): T[] {
  if (!manual) return [...accounts];
  const position = new Map(rows.filter((row) => row.included).map((row) => [row.harnessId, row.position ?? 0] as const));
  const members = accounts.filter((account) => position.has(account.harnessId))
    .toSorted((a, b) => position.get(a.harnessId)! - position.get(b.harnessId)!);
  return [...members, ...accounts.filter((account) => !position.has(account.harnessId))];
}

/** What a row's two switches add up to, when it is not the plain default
 *  (in Relay or not, and shown in the picker). */
export const accountRole = (included: boolean, inPicker: boolean): "relay-only" | "off" | undefined =>
  inPicker ? undefined : included ? "relay-only" : "off";

/** "19:00" today, "Thu 19:00" on another day. */
export function refillTime(at: number, now: number, locale: string): string {
  const date = new Date(at);
  const clock = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === new Date(now).toDateString() ? clock : `${date.toLocaleDateString(locale, { weekday: "short" })} ${clock}`;
}
