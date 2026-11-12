// The composer's attachment tray: one row of the card, between the model line
// and the editor, that holds the next message's files. Adding the first file
// opens the row and the row closes once it holds nothing (composerAdaptive.css
// "Attachment tray"), so the card grows and shrinks with it instead of
// jumping. Nothing animates when the composer already has files as it mounts
// or switches scope (a restored draft, the hero → transcript remount, another
// chat), when a send takes the files, or when a file arrives on a resting
// phone row: that row engages, and useComposerMorph grows the card on the
// keyboard's curve; resting again after the last file, the morph shrinks it.
//
// A file the person removes keeps its place for a moment as a restore slot of
// the card's width, so nothing shifts under the pointer and a slip is one
// click to take back. The slot leaves on its own unless the pointer or the
// keyboard is on the row; a row left with only slots closes over them.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type AnimationEvent } from "react";
import type { AttachmentRef } from "@polyth/contracts";
import { discardBrowserArtifacts } from "../attachments.ts";

export type AttachmentTrayMotion = "open" | "close";

/** How long a removed file's slot offers to put it back. */
export const ATTACHMENT_RESTORE_MS = 8000;
/** A slot that stopped offering collapses, then is dropped: longer than any
 *  theme's --motion-normal, which times the collapse. */
const SLOT_LEAVE_MS = 280;
/** The pointer or the keyboard is on the row: look again this much later. */
const SLOT_HELD_RETRY_MS = 1000;

/** A file the person removed that can still be put back. */
export interface RemovedAttachment {
  attachment: AttachmentRef;
  /** Its place among the row's slots, kept slots included. */
  index: number;
  /** The card's width, kept so the row does not shift. */
  width: number;
  /** When the slot stops offering (epoch ms). */
  until: number;
  /** No longer offered: collapsing before it is dropped. */
  leaving: boolean;
}

export interface AttachmentTraySlot {
  attachment: AttachmentRef;
  /** Present on a removed file's restore slot. */
  removed?: RemovedAttachment;
}

export interface AttachmentTray {
  /** What the row draws, in order: the draft's files and the removed ones' restore slots. */
  slots: AttachmentTraySlot[];
  motion: AttachmentTrayMotion | null;
  ref: (node: HTMLElement | null) => void;
  /** Call as the person removes a file, before the draft drops it: its slot stays to put it back. */
  remove: (attachment: AttachmentRef, width: number) => void;
  /** Put a removed file back: `put` gets the place it had among the draft's files and answers whether it took it. */
  restore: (id: string, put: (attachment: AttachmentRef, index: number) => boolean) => void;
  /** The tray's own animation ended (its cards' do not count). */
  settle: (event: AnimationEvent<HTMLElement>) => void;
}

const NONE: RemovedAttachment[] = [];

/** The row's slots: the draft's files with each removed one back at the place it had. */
export function attachmentTraySlots(attachments: readonly AttachmentRef[], removed: readonly RemovedAttachment[]): AttachmentTraySlot[] {
  const slots: AttachmentTraySlot[] = attachments.map((attachment) => ({ attachment }));
  for (const entry of removed) slots.splice(Math.min(entry.index, slots.length), 0, { attachment: entry.attachment, removed: entry });
  return slots;
}

/** `removed` without `gone`: the slots after one that left each move up a place. */
export function withoutRemovedAttachments(removed: readonly RemovedAttachment[], gone: readonly RemovedAttachment[]): RemovedAttachment[] {
  if (gone.length === 0) return removed as RemovedAttachment[];
  const kept = removed.filter((entry) => !gone.includes(entry));
  if (kept.length === 0) return NONE;
  return kept.map((entry) => {
    const before = gone.filter((other) => other.index < entry.index).length;
    return before ? { ...entry, index: entry.index - before } : entry;
  });
}

/** The pointer rests on the row, or the keyboard's focus is in it. A touch
 *  screen keeps :hover on what was last tapped, so only a real pointer counts. */
function rowHeld(row: HTMLElement | null): boolean {
  if (!row) return false;
  if (row.querySelector(":focus-visible")) return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(hover: hover)").matches && row.matches(":hover");
}

export function useAttachmentTray(attachments: AttachmentRef[], scope: string, engaged: boolean): AttachmentTray {
  const [motion, setMotion] = useState<AttachmentTrayMotion | null>(null);
  const [removed, setRemoved] = useState<RemovedAttachment[]>(NONE);
  const node = useRef<HTMLElement | null>(null);
  const previous = useRef<{ scope: string; ids: string[]; engaged: boolean; held: boolean } | null>(null);
  // What handlers and timers act on: the latest files, slots and engagement,
  // and whether the row is closing over its slots.
  const current = useRef({ attachments, removed, engaged });
  current.current.attachments = attachments;
  current.current.engaged = engaged;
  const closing = useRef(false);
  const count = attachments.length;

  const keep = useCallback((next: RemovedAttachment[]) => {
    current.current.removed = next;
    setRemoved(next);
  }, []);

  /** Slots dropped for good take what their files pointed at with them. */
  const drop = useCallback((gone: RemovedAttachment[]) => {
    if (gone.length === 0) return;
    for (const entry of gone) discardBrowserArtifacts(entry.attachment);
    keep(withoutRemovedAttachments(current.current.removed, gone));
  }, [keep]);

  const finish = useCallback(() => {
    if (closing.current) {
      closing.current = false;
      drop(current.current.removed);
    }
    setMotion(null);
  }, [drop]);

  // A layout effect: its update re-renders before the browser paints, so an
  // opening row's first frame is already the closed one.
  useLayoutEffect(() => {
    const last = previous.current;
    const ids = attachments.map((attachment) => attachment.id);
    previous.current = { scope, ids, engaged, held: removed.length > 0 };
    if (!last || last.scope !== scope) {
      closing.current = false;
      drop(current.current.removed);
      setMotion(null);
      return;
    }
    // A file that left without being removed here (a send, a recalled prompt,
    // a seeded draft) takes the row's restore slots with it.
    const here = new Set(ids);
    const offered = new Set(removed.map((entry) => entry.attachment.id));
    if (last.ids.some((id) => !here.has(id) && !offered.has(id))) {
      drop(current.current.removed);
      if (closing.current) {
        closing.current = false;
        setMotion(null);
      }
      return;
    }
    if (count === 0 || last.ids.length > 0) return;
    if (closing.current) {
      // A file arrived while the row was closing over its slots: it opens anew.
      closing.current = false;
      drop(current.current.removed);
      setMotion(last.engaged && engaged ? "open" : null);
    } else if (!last.held) {
      setMotion(last.engaged && engaged ? "open" : null);
    }
  }, [attachments, count, scope, engaged, removed, drop]);

  // No animation to wait for (reduced motion, a hidden row): settle now. One
  // cancelled on the way (the row hidden mid-way) settles too, so a closing
  // tray never lingers to reappear with the next engaged card.
  useLayoutEffect(() => {
    if (!motion) return;
    const tray = node.current;
    if (!tray || typeof tray.getAnimations !== "function" || tray.getAnimations().length === 0) {
      finish();
      return;
    }
    const cancelled = (event: Event) => { if (event.target === tray) finish(); };
    tray.addEventListener("animationcancel", cancelled);
    return () => tray.removeEventListener("animationcancel", cancelled);
  }, [motion, finish]);

  // Restore slots leave on their own. Beside files, each collapses when its
  // time is up; a row with no file left closes over all of them together, once
  // the newest has had its time. A row the pointer or the keyboard is on waits.
  useEffect(() => {
    if (motion === "close") return;
    const offering = removed.filter((entry) => !entry.leaving);
    if (offering.length === 0) return;
    const times = offering.map((entry) => entry.until);
    const due = count === 0 ? Math.max(...times) : Math.min(...times);
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      if (rowHeld(node.current)) {
        timer = setTimeout(expire, SLOT_HELD_RETRY_MS);
        return;
      }
      const state = current.current;
      if (state.attachments.length > 0) {
        const now = Date.now();
        keep(state.removed.map((entry) => (!entry.leaving && entry.until <= now ? { ...entry, leaving: true } : entry)));
      } else if (state.engaged) {
        closing.current = true;
        setMotion("close");
      } else {
        // A resting phone row has no tray to close: the morph shrinks the card.
        drop(state.removed);
      }
    };
    timer = setTimeout(expire, Math.max(0, due - Date.now()));
    return () => clearTimeout(timer);
  }, [removed, count, motion, keep, drop]);

  useEffect(() => {
    if (!removed.some((entry) => entry.leaving)) return;
    const timer = setTimeout(() => drop(current.current.removed.filter((entry) => entry.leaving)), SLOT_LEAVE_MS);
    return () => clearTimeout(timer);
  }, [removed, drop]);

  // A composer that goes away takes its slots' files with it.
  useEffect(() => () => {
    for (const entry of current.current.removed) discardBrowserArtifacts(entry.attachment);
  }, []);

  const remove = useCallback((attachment: AttachmentRef, width: number) => {
    const state = current.current;
    const index = attachmentTraySlots(state.attachments, state.removed).findIndex((slot) => slot.attachment.id === attachment.id && !slot.removed);
    if (index < 0) return;
    const entry: RemovedAttachment = { attachment, index, width, until: Date.now() + ATTACHMENT_RESTORE_MS, leaving: false };
    keep([...state.removed, entry].sort((left, right) => left.index - right.index));
  }, [keep]);

  const restore = useCallback((id: string, put: (attachment: AttachmentRef, index: number) => boolean) => {
    const state = current.current;
    const entry = state.removed.find((candidate) => candidate.attachment.id === id);
    if (!entry || entry.leaving || closing.current) return;
    const slotsBefore = state.removed.filter((other) => other.index < entry.index).length;
    if (!put(entry.attachment, entry.index - slotsBefore)) return;
    keep(state.removed.filter((other) => other !== entry));
  }, [keep]);

  const settle = useCallback((event: AnimationEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) finish();
  }, [finish]);

  const ref = useCallback((element: HTMLElement | null) => { node.current = element; }, []);

  const slots = useMemo(() => attachmentTraySlots(attachments, removed), [attachments, removed]);

  return { slots, motion, ref, remove, restore, settle };
}
