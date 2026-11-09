// Skill search, shared by the settings page and the agent tool. Browser-safe.

/** Every word must appear; a hit in the name ranks above one in the description. */
export function rankSkillMatches<T extends { name: string; title: string; description: string; collection?: string }>(
  rows: readonly T[],
  query: string,
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...rows];
  const scored: Array<{ row: T; score: number }> = [];
  for (const row of rows) {
    const name = `${row.name} ${row.title}`.toLowerCase();
    const rest = `${row.description} ${row.collection ?? ""}`.toLowerCase();
    let score = 0;
    let every = true;
    for (const word of words) {
      if (name.includes(word)) score += name.split(/[\s-]+/).includes(word) ? 4 : 2;
      else if (rest.includes(word)) score += 1;
      else { every = false; break; }
    }
    if (every) scored.push({ row, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name)).map((item) => item.row);
}
