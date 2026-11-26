// The list filters (sidebar, phone navigator) and the one chat search share a
// text rule and a server lookup: a filter narrows the list it shows, and the
// same query asks the chat search what the list cannot show — chats that
// match only in their messages, or that this client has not paged in yet.
import { useEffect, useState } from "react";
import type { Project, SessionProjection } from "@polyth/contracts";
import { api, type SessionSearchResult } from "@polyth/session/web-api";
import { matchesSearchTerms, searchTerms } from "@polyth/session/search-text";

/** Chats the lookup asks for; the "in messages" count shows `N+` at the cap. */
export const CHAT_SEARCH_HIT_LIMIT = 40;
const DEBOUNCE_MS = 220;

/** The list filter's rule for a chat: every word in its title, branch or worktree. */
export function sessionMatchesSearch(session: Pick<SessionProjection, "title" | "branch" | "worktreePath">, terms: readonly string[]): boolean {
  return matchesSearchTerms([session.title, session.branch, session.worktreePath], terms);
}

/** The list filter's rule for a project: every word in its name or path. */
export function projectMatchesSearch(project: Pick<Project, "name" | "path">, terms: readonly string[]): boolean {
  return matchesSearchTerms([project.name, project.path], terms);
}

export interface ChatSearchHits {
  /** The query these results answer (they lag the typed one by the debounce). */
  query: string;
  results: SessionSearchResult[];
  failed: boolean;
}

/** Debounced, abortable chat-search lookup behind a list filter. */
export function useChatSearchHits(query: string): ChatSearchHits {
  const text = query.trim();
  const [hits, setHits] = useState<ChatSearchHits>({ query: "", results: [], failed: false });
  useEffect(() => {
    if (searchTerms(text).length === 0) {
      setHits({ query: "", results: [], failed: false });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api.searchSessions(text, { limit: CHAT_SEARCH_HIT_LIMIT }, controller.signal).then(
        (results) => { if (!controller.signal.aborted) setHits({ query: text, results, failed: false }); },
        () => { if (!controller.signal.aborted) setHits({ query: text, results: [], failed: true }); },
      );
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [text]);
  return hits.query === text ? hits : { query: text, results: [], failed: false };
}

/** Chats found only through their messages — the ones a list filter hides. */
export function messageOnlyHits(results: readonly SessionSearchResult[]): SessionSearchResult[] {
  return results.filter((r) => r.matches.some((m) => m.field === "message")
    && !r.matches.some((m) => m.field === "title" || m.field === "branch"));
}

/** Projects holding a chat whose title or branch matched on the server. */
export function metadataHitProjectIds(results: readonly SessionSearchResult[]): Set<string> {
  return new Set(results
    .filter((r) => r.matches.some((m) => m.field === "title" || m.field === "branch"))
    .map((r) => r.projectId));
}
