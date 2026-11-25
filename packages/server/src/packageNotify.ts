// A package's outcome notification (`SESSION_ATTENTION_SERVICE.notify`).
//
// Notifications go to a session's recorded owner. A person becomes one by
// creating the session over HTTP or by typing into it; a session that server
// work started for them (an agent's run, sent `via: "schedule"`) has none, so
// its outcome would reach nobody. The package names the person the run acts
// for and the host records them first — only while they are a member of the
// session's Space, and never in place of an owner already recorded.

import type { NotificationAccount } from "./notifications.ts";

export interface PackageNotifyInput {
  kind: "completed" | "failed";
  statusText: string;
  key: string;
  recipient?: { userId: string };
}

export interface PackageNotifyDeps {
  projection(sessionId: string): Promise<{ spaceId?: string; parentId?: string } | undefined>;
  /** Idempotent; refuses an account without access to the Space. */
  registerSessionRecipient(sessionId: string, recipient: NotificationAccount): Promise<boolean>;
  recipientForSession(sessionId: string, account: Pick<NotificationAccount, "spaceId">): Promise<NotificationAccount | undefined>;
  report(sessionId: string, kind: "completed" | "failed", statusText: string, key: string): void;
  warn?(message: string): void;
}

export function createPackageNotify(deps: PackageNotifyDeps): (sessionId: string, input: PackageNotifyInput) => Promise<void> {
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  return async (sessionId, input) => {
    const proj = await deps.projection(sessionId);
    if (!proj?.spaceId || proj.parentId) {
      deps.report(sessionId, input.kind, input.statusText, input.key);
      return;
    }
    const userId = input.recipient?.userId;
    if (typeof userId === "string" && userId && !userId.startsWith("system:")) {
      await deps.registerSessionRecipient(sessionId, { userId, spaceId: proj.spaceId });
    }
    // Said out loud: a dropped outcome notification is otherwise invisible.
    if (!await deps.recipientForSession(sessionId, { spaceId: proj.spaceId })) {
      warn(`[polyth] notification "${input.key}" for session ${sessionId} has no recipient; nobody is told`);
      return;
    }
    deps.report(sessionId, input.kind, input.statusText, input.key);
  };
}
