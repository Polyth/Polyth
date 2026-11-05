// The permission card of one chosen session, for a page that shows its requests
// outside the session's timeline (`session.permission.requests`). It is the card
// every chat shows, read from the session's canonical events, so a decision and
// what it offers cannot differ from the chat's.
import { useEffect, useRef, useState } from "react";
import { loadOlderEvents, refreshBackgroundSession } from "../../../apps/web/src/init.ts";
import { useSessionModel, useStore } from "../../../apps/web/src/store.ts";
import PermissionBanner, { type PermissionNotesSlot } from "./PermissionBanner.tsx";

/** The socket streams only the active chat, so this page reads the rest. Short:
 *  it runs only while a request waits, and a decision must leave the screen
 *  before the card's policy grace (`POLICY_SETTLE_MS`) brings it back. */
export const REQUESTS_REFRESH_MS = 1_000;
/** How far back an open request is looked for when newer events pushed it out
 *  of the first window. */
const OLDER_PAGES = 5;

export default function SessionPermissions({ sessionId, requestIds = [], Slot }: {
  sessionId: string;
  requestIds?: readonly string[];
  Slot?: PermissionNotesSlot;
}) {
  const model = useSessionModel(sessionId);
  const active = useStore((state) => state.activeSessionId === sessionId);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (document.visibilityState !== "hidden") {
        try {
          await refreshBackgroundSession(sessionId);
          if (!stopped) setLoaded(true);
        } catch {
          // The next read retries; the page keeps its way into the session.
        }
      }
      if (!stopped) timer = setTimeout(() => void read(), REQUESTS_REFRESH_MS);
    };
    void read();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, active]);

  // A request the page knows of but the window does not hold is older than it.
  const missing = requestIds.some((id) => !model.permissions.some((request) => request.requestId === id));
  const pagesLeft = useRef(OLDER_PAGES);
  const [paged, setPaged] = useState(0);
  useEffect(() => {
    if (!loaded || !missing || pagesLeft.current === 0) return;
    pagesLeft.current -= 1;
    let stopped = false;
    void loadOlderEvents(sessionId).catch(() => false).then((added) => {
      if (!added) pagesLeft.current = 0;
      else if (!stopped) setPaged((count) => count + 1);
    });
    return () => { stopped = true; };
  }, [sessionId, loaded, missing, paged]);

  const pending = model.permissions.filter((request) => request.status === "pending");
  return <PermissionBanner permissions={pending} {...(Slot ? { Slot } : {})} />;
}
