import { useEffect, useMemo, useState } from "react";
import type { HarnessSnapshot } from "@polyth/contracts";
import { peekHarnessSnapshots, useCatalogRevision } from "@polyth/models/runtime-catalog";
import type { WebPackageHost } from "@polyth/web-sdk";
import { Button, ComposerNoticeRow, KeyIcon, Notice } from "../../../apps/web/src/components/ui/index.ts";
import { hostTranslate, type Translate } from "./englishTranslate.ts";
import { useHarnessSignIn } from "./HarnessSignIn.tsx";
import { harnessProfileName, signInEndsSoon, signInExpiryNote, type SignInExpiryNote } from "./presentation.ts";
import { getSignInExpiryLedger, isSignInExpiryNews, markSignInExpiry, useSignInExpiryLedger, type SignInAlertLevel } from "./signInExpiryLedger.ts";

/** Often enough that "in 3 hours" and a crossed threshold stay current. */
const TICK_MS = 15 * 60 * 1000;

type Ending = { row: HarnessSnapshot; expiresAt: number; level: SignInAlertLevel; note: SignInExpiryNote; name: string };

/** Enabled logins whose CLI-reported sign-in ends within 10 days, or ended. */
export function endingSignIns(rows: readonly HarnessSnapshot[], t: Translate, locale: string | undefined, now: number): Ending[] {
  return rows.flatMap((row): Ending[] => {
    const expiresAt = row.availability.authExpiresAt;
    if (!row.policy.enabled || expiresAt === undefined || !signInEndsSoon(row, now)) return [];
    const note = signInExpiryNote(expiresAt, t, locale, now);
    if (!note || note.level === "none") return [];
    return [{ row, expiresAt, level: note.level, note, name: harnessProfileName(row.identity) }];
  });
}

const titleOf = (ending: Ending, t: Translate) =>
  t(ending.level === "ended" ? "signInExpiry.endedTitle" : "signInExpiry.soonTitle", { name: ending.name });
const bodyOf = (ending: Ending, t: Translate) => ending.level === "ended"
  ? t("signInExpiry.endedBody", { date: ending.note.date })
  : t("signInExpiry.soonBody", { when: ending.note.text, date: ending.note.date });

function useTick(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * Sign-in ends reported by harness CLIs, above the composer. Every ending
 * login gets one passing notification per level (10 days, 48 hours, ended);
 * the open chat's own login also gets a dismissible notice in its last
 * 48 hours. A signed-out login is HarnessAuthRecovery's, never this one's.
 */
export default function HarnessSignInExpiry({ host, projectId, spaceId, resolvedHarnessId }: {
  host: WebPackageHost;
  projectId?: string;
  spaceId?: string;
  resolvedHarnessId?: string;
}) {
  const t = useMemo(() => hostTranslate(host.ui.locale.translate), [host]);
  const locale = host.ui.locale.get();
  const revision = useCatalogRevision();
  const ledger = useSignInExpiryLedger();
  const now = useTick();
  const guide = useHarnessSignIn({ host, projectId: projectId ?? null });
  const rows = useMemo(() => projectId ? peekHarnessSnapshots({ projectId, ...(spaceId ? { spaceId } : {}) }) ?? [] : [], [projectId, spaceId, revision]);
  const ending = useMemo(() => endingSignIns(rows, t, locale, now), [rows, t, locale, now]);
  const endingKey = ending.map((item) => `${item.row.identity.id}:${item.expiresAt}:${item.level}`).join("|");

  useEffect(() => {
    const notifications = host.notifications;
    if (!notifications) return;
    for (const item of ending) {
      // Read the shared record, not this render's copy: another composer may
      // have announced the same login a moment ago.
      if (!isSignInExpiryNews(getSignInExpiryLedger(), item.row.identity.id, item.expiresAt, item.level, "notified")) continue;
      const harnessId = item.row.identity.id;
      notifications.show({
        id: `sign-in-expiry:${harnessId}`,
        kind: item.level === "ended" ? "error" : "warning",
        title: titleOf(item, t),
        body: bodyOf(item, t),
        actions: [{ label: t("signInExpiry.openSettings"), primary: true, run: () => host.navigation.openSettingsPage("harnesses", { itemId: harnessId }) }],
        data: { harness: harnessId, level: item.level },
      });
      markSignInExpiry(harnessId, item.expiresAt, item.level, "notified");
    }
    // `endingKey` names exactly what `ending` holds.
  }, [host, endingKey]);

  const own = resolvedHarnessId ? ending.find((item) => item.row.identity.id === resolvedHarnessId) : undefined;
  const shown = own && own.level !== "soon" && isSignInExpiryNews(ledger, own.row.identity.id, own.expiresAt, own.level, "dismissed") ? own : undefined;
  const command = shown?.row.setup?.signInCommand;
  return <>
    <ComposerNoticeRow open={Boolean(shown)}>
      {shown && <div className="pkg-harnesses pkg-harnesses-transition-status">
        <Notice
          tone={shown.level === "ended" ? "error" : "warning"}
          className="pkg-harnesses-expiry-notice"
          data-level={shown.level}
          role="status"
          heading={titleOf(shown, t)}
          actions={<>
            {/* A cached snapshot may not carry the sign-in command; its
                Settings page always does. */}
            {command
              ? <Button size="sm" variant="primary" iconStart={KeyIcon} onClick={() => guide.start({ harnessId: shown.row.identity.id, harnessName: shown.name, command, kind: "sign-in-again" })}>{t("signInExpiry.signInAgain")}</Button>
              : <Button size="sm" variant="primary" iconStart={KeyIcon} onClick={() => host.navigation.openSettingsPage("harnesses", { itemId: shown.row.identity.id })}>{t("signInExpiry.openSettings")}</Button>}
            <Button size="sm" variant="ghost" onClick={() => markSignInExpiry(shown.row.identity.id, shown.expiresAt, shown.level, "dismissed")}>{t("signInExpiry.dismiss")}</Button>
          </>}
        >{bodyOf(shown, t)}</Notice>
      </div>}
    </ComposerNoticeRow>
    {guide.dialog}
  </>;
}
