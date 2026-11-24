// Wire types of the "move a chat between checkouts" routes
// (`POST /api/git/session-checkout/preview` and `POST /api/git/session-checkout`).
// Types only and free of runtime imports, so browser code can import them
// type-only through `@polyth/git/checkout-move`.
import type { SessionProjection } from "@polyth/contracts";

/** A checkout of the project: a linked worktree, or the main checkout. */
export type SessionCheckoutTarget = { worktreePath: string } | { main: true };

export type SessionCheckoutBlockReason =
  | "busy" | "queued" | "archived" | "isolated" | "delegated"
  | "missing-target" | "same-checkout" | "unsupported" | "other-machine";

export interface SessionCheckoutBlock {
  reason: SessionCheckoutBlockReason;
  message: string;
}

export interface SessionCheckoutPlace {
  path: string;
  /** `null` when HEAD is detached or the checkout cannot be read. */
  branch: string | null;
  isMain: boolean;
  label: string;
}

export interface SessionCheckoutPreview {
  from: SessionCheckoutPlace;
  to: SessionCheckoutPlace & { dirtyCount: number; detached?: boolean };
  /** A native leg is warm and restarts in the new folder on the next message. */
  restartsAgent: boolean;
  /** The source is a linked worktree and this is its only non-archived chat. */
  lastSessionInSource: boolean;
  sourceDirtyCount: number;
  /** Polyth created the source worktree's branch (`ownedBranchForWorktree`). */
  sourceBranchOwned: boolean;
  /** That branch is already contained in the target's HEAD. */
  sourceBranchMerged: boolean;
  /** Branches of the target checkout; `inUseBy` is the worktree label that has it checked out. */
  branches: Array<{ name: string; remote?: boolean; inUseBy?: string }>;
  expectedWorkspaceRevision: number;
  blocked?: SessionCheckoutBlock;
}

export type SessionCheckoutBranchChoice =
  | { kind: "keep" }
  | { kind: "switch"; name: string }
  | { kind: "create"; name: string; from?: string };

export interface SessionCheckoutPreviewInput {
  sessionId: string;
  target: SessionCheckoutTarget;
}

export interface SessionCheckoutInput extends SessionCheckoutPreviewInput {
  expectedWorkspaceRevision: number;
  branch?: SessionCheckoutBranchChoice;
  removeSource?: { deleteBranch: boolean };
}

export interface SessionCheckoutResult {
  session: SessionProjection;
  removed?: { path: string; branchDeleted: boolean };
  /** The chat moved but the branch change was refused (typed Git refusal code). */
  branchError?: { code: string; message: string };
  /** The chat moved but the source worktree could not be removed. */
  removeError?: { code: string; message: string };
}
