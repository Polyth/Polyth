// The composer's attachment tray: one row of the card, between the model line
// and the editor, that holds the next message's files. Adding the first file
// opens the row and removing the last one closes it (composerAdaptive.css
// "Attachment tray"), so the card grows and shrinks with it instead of
// jumping. Nothing animates when the composer already has files as it mounts
// or switches scope (a restored draft, the hero → transcript remount, another
// chat), when a send takes the files, or when a file arrives on a resting
// phone row: that row engages, and useComposerMorph grows the card on the
// keyboard's curve; resting again after the last file, the morph shrinks it.
import { useCallback, useLayoutEffect, useRef, useState, type AnimationEvent } from "react";
import type { AttachmentRef } from "@polyth/contracts";

export type AttachmentTrayMotion = "open" | "close";

export interface AttachmentTray {
  /** The cards to draw: the draft's, or the removed last card while the tray closes over it. */
  shown: AttachmentRef[];
  motion: AttachmentTrayMotion | null;
  ref: (node: HTMLElement | null) => void;
  /** Call as the draft's last attachment is removed, so the tray closes over it. */
  closeOver: (attachment: AttachmentRef) => void;
  /** The tray's own animation ended (its cards' do not count). */
  settle: (event: AnimationEvent<HTMLElement>) => void;
}

const EMPTY: AttachmentRef[] = [];

export function useAttachmentTray(attachments: AttachmentRef[], scope: string, engaged: boolean): AttachmentTray {
  const [motion, setMotion] = useState<AttachmentTrayMotion | null>(null);
  const [leaving, setLeaving] = useState<AttachmentRef[] | null>(null);
  const node = useRef<HTMLElement | null>(null);
  const previous = useRef<{ scope: string; count: number; engaged: boolean } | null>(null);
  const count = attachments.length;

  const finish = useCallback(() => {
    setMotion(null);
    setLeaving(null);
  }, []);

  // A layout effect: its update re-renders before the browser paints, so an
  // opening row's first frame is already the closed one.
  useLayoutEffect(() => {
    const last = previous.current;
    previous.current = { scope, count, engaged };
    if (!last || last.scope !== scope) {
      finish();
      return;
    }
    if (count > 0 && last.count === 0) {
      setLeaving(null);
      setMotion(last.engaged && engaged ? "open" : null);
    } else if (count === 0 && !engaged) {
      finish();
    }
  }, [count, scope, engaged, finish]);

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

  const closeOver = useCallback((attachment: AttachmentRef) => {
    setLeaving([attachment]);
    setMotion("close");
  }, []);

  const settle = useCallback((event: AnimationEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) finish();
  }, [finish]);

  const ref = useCallback((element: HTMLElement | null) => { node.current = element; }, []);

  return {
    shown: count > 0 ? attachments : leaving ?? EMPTY,
    motion,
    ref,
    closeOver,
    settle,
  };
}
