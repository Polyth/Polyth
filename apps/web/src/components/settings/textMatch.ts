// Multi-word search for settings lists. Pure and DOM-free so list models and
// the shared row primitive (`ItemRow` in parts.tsx) agree on what a query
// matches and which characters a row highlights.

/** Whitespace-separated words, lowercased; every word must match (AND). */
export function queryTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
}

/** Split `text` around case-insensitive query-word matches for highlighting. */
export function highlightParts(text: string, query: string): Array<{ text: string; match: boolean }> {
  const tokens = queryTokens(query);
  if (tokens.length === 0 || !text) return [{ text, match: false }];
  const lower = text.toLowerCase();
  // Case folding that changes length (e.g. "İ") would misalign the marks.
  if (lower.length !== text.length) return [{ text, match: false }];
  const marked = new Array<boolean>(text.length).fill(false);
  for (const token of tokens) {
    for (let at = lower.indexOf(token); at >= 0; at = lower.indexOf(token, at + token.length)) {
      marked.fill(true, at, at + token.length);
    }
  }
  const parts: Array<{ text: string; match: boolean }> = [];
  for (let index = 0; index < text.length; index += 1) {
    const last = parts[parts.length - 1];
    if (last && last.match === marked[index]) last.text += text[index];
    else parts.push({ text: text[index]!, match: marked[index]! });
  }
  return parts;
}
