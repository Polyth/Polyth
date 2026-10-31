/** The preset harness colors a Space can choose from. */
export const HARNESS_COLORS = ["#de5962", "#f28c38", "#eab83a", "#65b955", "#43b7a6", "#3f7de8", "#7253e8", "#d85cbe", "#858585"] as const;

/** A stable color for an extra login of a harness, so several accounts of one
 *  CLI stay distinguishable without a badge on the shared logo. */
const accountColor = (label: string): string => {
  let hash = 0;
  for (const character of label) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return HARNESS_COLORS[hash % HARNESS_COLORS.length]!;
};

/** A harness profile's color: the Space-chosen one, else its account's own
 *  color, else none (the logo keeps the theme color). Every surface that
 *  shows a harness logo (the picker tabs, the composer's model chip, the
 *  agent's status line) tints it with this one value. */
export const harnessColor = (identity: { color?: string; accountLabel?: string }): string | undefined => {
  const label = identity.accountLabel?.trim();
  return identity.color ?? (label ? accountColor(label) : undefined);
};
