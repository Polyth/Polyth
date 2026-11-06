// What a new project starts with: a name, a colour and an icon that already look
// right, so a person can accept them with one press. Pure and browser-safe.
import type { ProjectDirection } from "@polyth/contracts/project-composition";

export const DEFAULT_PROJECT_COLOR = "#b4532a";
export const PROJECT_COLORS = ["#b4532a", "#f0a6ad", "#de5962", "#f28c38", "#eab83a", "#65b955", "#43b7a6", "#3f7de8", "#7253e8", "#d85cbe", "#858585", "#7b8495"] as const;

/** How many icons the new-project window offers before "All icons". */
export const PROJECT_ICON_STARTER_COUNT = 14;

const GENERAL_ICONS = ["sparkles", "folder-closed", "lightbulb", "notebook-pen", "heart", "plane", "house", "briefcase", "palette", "book-open", "camera-line", "users", "target", "rocket"];

const DIRECTION_ICONS: Record<ProjectDirection, readonly string[]> = {
  engineering: ["code-xml", "terminal", "server-line", "database-line", "git-branch", "globe", "box", "cpu", "layers", "rocket", "wrench", "bug", "cloud", "shield-check"],
  research: ["telescope", "flask-conical", "microscope", "search", "book-open", "library", "lightbulb", "notebook-pen", "binoculars", "compass", "globe", "quote", "languages", "graduation-cap"],
  wellbeing: ["heart", "sprout", "sun", "moon", "smile", "dumbbell", "activity", "apple", "bike", "leaf", "target", "stethoscope", "mountain", "paw-print"],
  finance: ["piggy-bank", "wallet", "coins", "banknote", "chart-line", "trending-up", "landmark", "receipt", "credit-card", "scale", "briefcase", "calculator-line", "percent", "shopping-cart"],
  home: ["house", "sofa", "lamp", "lightbulb", "thermometer", "plug", "key-round", "washing-machine", "bed", "utensils", "tree-pine", "shield-check", "camera-line", "wifi"],
  operations: ["workflow", "list-checks", "calendar-check", "timer", "repeat", "bell", "megaphone", "mail", "clipboard-list", "users", "briefcase", "truck", "activity", "inbox"],
};

const iconValue = (name: string): string => `/assets/project-icons/${name}.svg`;

/** Icons that fit the chosen directions, bundled so the window works offline.
 *  Several directions take turns, so each one's best icons come first. */
export function projectIconStarters(directions: readonly ProjectDirection[]): string[] {
  const lists = directions.length > 0 ? directions.map((direction) => DIRECTION_ICONS[direction]) : [GENERAL_ICONS];
  const names = new Set<string>();
  for (let position = 0; names.size < PROJECT_ICON_STARTER_COUNT && lists.some((list) => position < list.length); position += 1) {
    for (const list of lists) {
      const name = list[position];
      if (name && names.size < PROJECT_ICON_STARTER_COUNT) names.add(name);
    }
  }
  return [...names].map(iconValue);
}

/** The palette in the order Polyth offers it by itself: colours that read well in
 *  both light and dark first, the pale pink and the greys only when nothing else
 *  is left. A person can still pick any of them. */
const DEFAULT_COLOR_ORDER = ["#3f7de8", "#43b7a6", "#7253e8", "#f28c38", "#65b955", "#d85cbe", "#de5962", "#eab83a", "#b4532a", "#f0a6ad", "#7b8495", "#858585"] as const;

/** The first colour no project uses yet, so a Navigator of accepted defaults
 *  still tells projects apart. When all are taken, the least used. */
export function unusedProjectColor(used: readonly (string | undefined)[]): string {
  const counts = new Map<string, number>();
  for (const color of used) {
    if (color) counts.set(color.toLocaleLowerCase(), (counts.get(color.toLocaleLowerCase()) ?? 0) + 1);
  }
  let best: string = DEFAULT_COLOR_ORDER[0];
  let bestCount = Number.POSITIVE_INFINITY;
  for (const color of DEFAULT_COLOR_ORDER) {
    const count = counts.get(color) ?? 0;
    if (count < bestCount) { best = color; bestCount = count; }
  }
  return best;
}

/** `base`, or `base 2`, `base 3`… when a project already has that name. */
export function nextProjectName(base: string, taken: readonly string[]): string {
  const names = new Set(taken.map((name) => name.trim().toLocaleLowerCase()));
  if (!names.has(base.toLocaleLowerCase())) return base;
  for (let copy = 2; ; copy += 1) {
    const candidate = `${base} ${copy}`;
    if (!names.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

/** What the new-project window edits. `*Edited` keeps a person's own choice when
 *  they step back, change directions or pick a folder. */
export interface ProjectIdentityDraft {
  name: string;
  nameEdited: boolean;
  color: string;
  colorEdited: boolean;
  icon: string;
  iconEdited: boolean;
}

export function refreshProjectIdentityDraft(
  draft: ProjectIdentityDraft | null,
  defaults: { name: string; color: string; icon: string },
): ProjectIdentityDraft {
  return {
    name: draft?.nameEdited ? draft.name : defaults.name,
    nameEdited: draft?.nameEdited ?? false,
    color: draft?.colorEdited ? draft.color : defaults.color,
    colorEdited: draft?.colorEdited ?? false,
    icon: draft?.iconEdited ? draft.icon : defaults.icon,
    iconEdited: draft?.iconEdited ?? false,
  };
}
