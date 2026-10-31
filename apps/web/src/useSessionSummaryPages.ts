import { useEffect, useMemo, useState } from "react";
import type { SessionSummaryQuery } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { createSummaryPager, type SummaryPageState } from "./sessionSummaryPages.ts";
import { setUiError, upsertSessions } from "./store.ts";
import { friendlyError } from "./settings.ts";
import { tr } from "./i18n/index.ts";

export function useSessionSummaryPages(query: SessionSummaryQuery, enabled = true) {
  const [state, setState] = useState<SummaryPageState>({ busy: false, hasMore: false });
  const pager = useMemo(() => createSummaryPager(api.listSessionSummaries, upsertSessions, setState), []);
  const key = JSON.stringify(query);
  /** Resolves false when the page failed, so automatic paging can stop. */
  const more = (): Promise<boolean> => pager.more().then(() => true, (error) => {
    setUiError(friendlyError(tr("sidebar.searchSessions"), error));
    return false;
  });
  useEffect(() => {
    if (!enabled) { setState({ busy: false, hasMore: false }); return; }
    pager.reset(JSON.parse(key) as SessionSummaryQuery);
    void more();
    return () => pager.cancel();
  }, [key, enabled, pager]);
  return { ...state, more };
}
