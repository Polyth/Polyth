// The row above a filtered chat list: how many more chats mention the
// query only in their messages, opening the one chat search with it typed.
import { openSessionSearch } from "../store.ts";
import { tr } from "../i18n/index.ts";
import { CHAT_SEARCH_HIT_LIMIT, messageOnlyHits, type ChatSearchHits } from "../chatSearchHits.ts";
import { ChevronRightIcon, Icon, SearchIcon } from "./ui/index.ts";

export function ChatSearchMessagesRow({ hits, className = "" }: { hits: ChatSearchHits; className?: string }) {
  if (!hits.query) return null;
  const count = messageOnlyHits(hits.results).length;
  // Nothing more to find: the row would only promise an empty search.
  if (!hits.failed && count === 0) return null;
  const label = hits.failed
    ? tr("sidebar.searchInMessages", { query: hits.query })
    : tr("sidebar.foundInMessages", { count: hits.results.length >= CHAT_SEARCH_HIT_LIMIT ? `${count}+` : String(count) });
  return (
    <button
      type="button"
      className={`chat-search-messages-row ${className}`.trim()}
      onClick={() => openSessionSearch({ query: hits.query })}
    >
      <Icon icon={SearchIcon} size="sm" />
      <span className="chat-search-messages-label">{label}</span>
      <Icon icon={ChevronRightIcon} size="sm" className="chat-search-messages-go" />
    </button>
  );
}
