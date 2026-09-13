// Runtime recovery instructions are model-only metadata. Older clients or
// handoff paths can still deliver the wrapper in visible text, so remove only
// a leading, complete internal recovery block at the browser display boundary.
// Persisted event data and runtime prompts remain unchanged.
const LEADING_RECOVERY_BLOCK = /^\s*<polyth-(?:runtime-epoch|compaction)-recovery\b[^>]*>[\s\S]*?<\/polyth-(?:runtime-epoch|compaction)-recovery>\s*/;

export function stripRecoveryContextBlocks(text: string): string {
  let visible = text;
  while (true) {
    const next = visible.replace(LEADING_RECOVERY_BLOCK, "");
    if (next === visible) return visible;
    visible = next;
  }
}
