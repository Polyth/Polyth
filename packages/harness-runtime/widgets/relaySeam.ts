// The seam a package that rotates a family's accounts (Relay) fills. The
// Accounts section draws the account rows; that package supplies the Relay
// state and the row parts. With none registered the section is a plain list.
// Harness-runtime names no such package: it registers itself here.
import { createElement, Fragment, useSyncExternalStore, type ComponentType, type HTMLAttributes, type ReactElement } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { RelayMemberView, RelayView } from "../src/relay.ts";
import type { RelayTranslate } from "./relayModel.ts";

export { RelayPolicyNotice } from "./RelayPolicyNotice.tsx";
export { refillTime, type RelayTranslate } from "./relayModel.ts";
export { replaceRelayPrefs, useRelayPrefs } from "./relayPrefs.ts";
export type { RelayMemberView, RelayView };

export interface Relay {
  /** Absent: no Relay for this server or device (older server, 403/404). */
  view?: RelayView;
  rows: RelayMemberView[];
  t: RelayTranslate;
  now: number;
  saving: boolean;
  /** The member whose Relay switch is being saved, if any. */
  pending: string;
  failure: string;
  /** Two or more accounts this person may use: Relay is offered at all. */
  available: boolean;
  /** Two or more members: the Relay harness is in this person's picker. */
  listed: boolean;
  manual: boolean;
  /** `<label> · Relay`, the harness name people pick. */
  name: string;
  member(harnessId: string): RelayMemberView | undefined;
  include(harnessId: string, included: boolean): void;
  /** With My order, whether a member can move one place up (-1) or down (1). */
  canMove(harnessId: string, delta: -1 | 1): boolean;
  /** Moves a member one place; the row menu's way, for touch and keyboards. */
  move(harnessId: string, delta: -1 | 1): void;
  options(patch: Partial<RelayView["settings"]>): void;
  /** Read the Relay again (an account was added, renamed or removed). */
  reload(): Promise<void>;
  /** Leading order cell of a row while the order is manual. */
  lead(harnessId: string, label: string, disabled: boolean): ReactElement;
  /** Drop target props for a member row while the order is manual. */
  dropTarget(harnessId: string): Pick<HTMLAttributes<HTMLElement>, "onDragOver" | "onDrop"> & { "data-dragging"?: "true" };
}

export interface RelayKit {
  /** Loads the person's Relay for `family`; `onChanged` after every save. */
  useRelay(args: { host: WebPackageHost; family: string; onChanged?(): void }): Relay;
  RelayCard: ComponentType<{ host: WebPackageHost; relay: Relay; accountName(harnessId: string): string }>;
  RelayBadge: ComponentType<{ relay: Relay; harnessId: string }>;
  RelayReading: ComponentType<{ relay: Relay; harnessId: string; locale: string }>;
}

let kit: RelayKit | undefined;
const listeners = new Set<() => void>();
const changed = (next: RelayKit | undefined) => {
  kit = next;
  for (const listener of [...listeners]) listener();
};
/** One kit at a time; the returned function takes it away again. */
export function registerRelayKit(next: RelayKit): () => void {
  changed(next);
  return () => { if (kit === next) changed(undefined); };
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const useRelayKit = (): RelayKit | undefined => useSyncExternalStore(subscribe, () => kit, () => kit);

/** The Relay of a server with no rotating package: nothing to rotate. */
export const NO_RELAY: Relay = {
  rows: [],
  t: (key) => key,
  now: 0,
  saving: false,
  pending: "",
  failure: "",
  available: false,
  listed: false,
  manual: false,
  name: "",
  member: () => undefined,
  include: () => {},
  canMove: () => false,
  move: () => {},
  options: () => {},
  reload: async () => {},
  lead: () => createElement(Fragment),
  dropTarget: () => ({}),
};
