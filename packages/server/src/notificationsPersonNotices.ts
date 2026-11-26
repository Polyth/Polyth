// Delivery of a person's notices from Spaces joined on other Polyth servers
// (`server.person-notices`). The inbox keeps one row for the person, seen from
// whichever of their Spaces here is open; the live frame and the push legs go
// to that one person only. Nothing here touches session history.
import type { NotificationRecord } from "@polyth/contracts";
import type { ServerPersonNotices } from "@polyth/plugins";
import { createDeferredAlerts } from "./deferredAlerts.ts";
import type { DevicePresence } from "./devicePresence.ts";
import type { NativePushService } from "./nativePush.ts";
import type { NotificationAccount, NotificationStore } from "./notifications.ts";
import type { PushPayload, PushService } from "./push.ts";

export function createPersonNotices(opts: {
  store: NotificationStore;
  /** Ids of the person's own Spaces on this server; none for no such person. */
  spacesOf(userId: string): string[];
  broadcast(record: NotificationRecord, recipient: NotificationAccount): void;
  push: Pick<PushService, "send">;
  nativePush: Pick<NativePushService, "send">;
  presence: Pick<DevicePresence, "activeUse" | "subscribe">;
}): ServerPersonNotices & { settled(): Promise<void> } {
  const accountsOf = (userId: string): NotificationAccount[] =>
    opts.spacesOf(userId).map((spaceId) => ({ userId, spaceId }));
  const send = async (accounts: NotificationAccount[], record: NotificationRecord, exceptDevice?: string): Promise<void> => {
    const source = [record.joinedSpace?.name, record.joinedSpace?.serverLabel].filter(Boolean).join(" · ");
    const payload: PushPayload = {
      kind: record.kind, sessionId: record.sessionId, projectId: record.projectId, key: record.key,
      title: record.title, body: source ? `${source} — ${record.body}` : record.body,
      tag: `polyth-joined-${record.key}`,
      // Where the alert leads, for a client that reads it.
      ...(record.joinedSpace ? { joinedSpace: record.joinedSpace } : {}),
    };
    // Push subscriptions are kept per Space, so each Space's are asked once; a
    // phone registered in several collapses them by the transition key.
    await Promise.allSettled(accounts.flatMap((account) => [
      opts.push.send(account, payload, exceptDevice === undefined ? undefined : { exceptDevice }),
      opts.nativePush.send({
        userId: account.userId, spaceId: account.spaceId,
        notificationId: record.id, kind: record.kind, transitionKey: record.key,
        title: payload.title, body: payload.body,
        ...(exceptDevice === undefined ? {} : { exceptDevice }),
      }),
    ]));
  };
  const deferred = createDeferredAlerts<NotificationRecord>({
    activeUse: opts.presence.activeUse,
    unread: async (account, id) => (await opts.store.list(account)).items.some((item) => item.id === id && !item.read),
    deliver: (account, record, exceptDevice) => send(accountsOf(account.userId), record, exceptDevice),
  });
  opts.presence.subscribe(deferred.presenceChanged);

  // In arrival order, so a withdrawal never overtakes its own delivery.
  let chain: Promise<unknown> = Promise.resolve();
  const sends = new Set<Promise<void>>();
  const queue = (step: () => Promise<void>): void => {
    chain = chain.then(step).catch((error: unknown) => {
      console.error("[polyth] joined Space notification failed", error);
    });
  };

  return {
    deliver(userId, input) {
      queue(async () => {
        const accounts = accountsOf(userId);
        if (!accounts.length) return;
        const record = await opts.store.deliverPerson(userId, input);
        if (!record) return;
        for (const account of accounts) opts.broadcast(record, account);
        // While the person works on one device only that one is alerted.
        const used = accounts.find((account) => opts.presence.activeUse(account));
        const use = used && opts.presence.activeUse(used);
        if (used && use) deferred.hold(used, record.id, record, use.device);
        const sending = send(used ? [used] : accounts, record);
        sends.add(sending);
        void sending.finally(() => { sends.delete(sending); });
      });
    },
    withdraw(userId, key) {
      queue(async () => { await opts.store.withdrawPerson(userId, key); });
    },
    /** Everything handed over so far is filed and sent (tests). */
    async settled() {
      await chain;
      await Promise.all([...sends]);
    },
  };
}
