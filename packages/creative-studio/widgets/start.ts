// Starting a video without a chat. The studio covers its lane's chat, so the
// brief is seeded into that chat and sent through the composer (the canonical
// path: the person's harness, model and isolation choice). The song can only
// be uploaded once the chat — and with it the checkout — exists, so the
// choices wait here until the studio sees the new chat and adopts it.
import { CREATIVE_STUDIO_PURPOSE } from "../src/index.ts";
import type { MediaSpec } from "../src/brief.ts";

export interface PendingStart {
  projectId: string;
  /** When the brief was seeded; a chat created before it is not ours. */
  at: number;
  spec: MediaSpec;
  song: File | null;
  lyricsFile: File | null;
  lyricsText: string;
  /** seeding → the composer was asked to send; manual → the person sends it. */
  phase: "seeding" | "submitted" | "manual";
}

/** How long a seeded start waits for its chat. */
export const PENDING_START_TTL_MS = 10 * 60_000;
/** When a submitted brief has produced no chat, hand over to the conversation. */
export const START_SEND_TIMEOUT_MS = 45_000;

let pending: PendingStart | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of [...listeners]) listener(); };

export const pendingStarts = {
  get(projectId: string | null | undefined, now = Date.now()): PendingStart | null {
    if (!pending || !projectId || pending.projectId !== projectId) return null;
    if (now - pending.at > PENDING_START_TTL_MS) { pending = null; return null; }
    return pending;
  },
  set(next: PendingStart): void { pending = next; emit(); },
  update(patch: Partial<PendingStart>): void { if (pending) { pending = { ...pending, ...patch }; emit(); } },
  clear(): void { if (pending) { pending = null; emit(); } },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

/** A chat the studio may adopt for a pending start: a studio-lane chat created
 * after the brief was seeded that has no studio of its own yet. */
export function adoptable(start: PendingStart | null, session: { createdAt?: number; purpose?: string } | undefined, hasStudio: boolean, now = Date.now()): boolean {
  if (!start || !session || hasStudio) return false;
  if (session.purpose !== CREATIVE_STUDIO_PURPOSE) return false;
  if (now - start.at > PENDING_START_TTL_MS) return false;
  return (session.createdAt ?? 0) >= start.at - 2_000;
}

/** Resolve after the shell has rendered a navigation (the composer adopts a
 * seeded draft in an effect after its commit). */
export function afterPaint(frames = 2): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") { setTimeout(resolve, 32); return; }
    let left = frames;
    const tick = () => { if (--left <= 0) setTimeout(resolve, 30); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
}
