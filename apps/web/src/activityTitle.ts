import { effectiveToolCall, isPolythMcpCall } from "./toolCallView.ts";
import { executionPresentation, type ExecutionKind } from "./execution.ts";
import { getLocale, tr, type TranslationKey } from "./i18n/index.ts";
import type { ActivityGroup } from "./utils.ts";

type Category =
  | "edited" | "created" | "deleted" | "moved" | "tests" | "commands" | "delegated"
  | "read" | "searches" | "web" | "browser" | "tools" | "tasks";

/** Which actions win the title when a block holds more kinds than fit: changes
 *  and verification say more about the work than the reading around them. */
const SIGNIFICANCE: readonly Category[] = [
  "edited", "created", "deleted", "moved", "tests", "commands", "delegated",
  "read", "searches", "web", "browser", "tools", "tasks",
];

const CATEGORY_OF: Record<ExecutionKind, Category> = {
  edit: "edited",
  write: "edited",
  create: "created",
  delete: "deleted",
  move: "moved",
  test: "tests",
  shell: "commands",
  git: "commands",
  subagent: "delegated",
  read: "read",
  search: "searches",
  web: "web",
  browser: "browser",
  mcp: "tools",
  tool: "tools",
};

/** Counted categories name the thing counted; the rest read as one phrase. */
const PHRASE: Record<Category, readonly [one: TranslationKey, many: TranslationKey] | TranslationKey> = {
  edited: ["timeline.activityEditedFile", "timeline.activityEditedFiles"],
  created: ["timeline.activityCreatedFile", "timeline.activityCreatedFiles"],
  deleted: ["timeline.activityDeletedFile", "timeline.activityDeletedFiles"],
  moved: ["timeline.activityMovedFile", "timeline.activityMovedFiles"],
  tests: "timeline.activityRanTests",
  commands: ["timeline.activityRanCommand", "timeline.activityRanCommands"],
  delegated: ["timeline.activityDelegatedTask", "timeline.activityDelegatedTasks"],
  read: ["timeline.activityReadFile", "timeline.activityReadFiles"],
  searches: ["timeline.activityRanSearch", "timeline.activityRanSearches"],
  web: "timeline.activityBrowsedWeb",
  browser: "timeline.activityUsedBrowser",
  tools: ["timeline.activityCalledTool", "timeline.activityCalledTools"],
  tasks: ["timeline.activityUpdatedTask", "timeline.activityUpdatedTasks"],
};

const FILE_CATEGORIES = new Set<Category>(["edited", "created", "deleted", "moved", "read"]);
const MAX_PHRASES = 3;

interface Tally {
  first: number;
  /** Distinct targets (file paths, task ids) or one entry per call. */
  targets: Set<string>;
}

/** The activity block's header, named by the actions inside it: the most
 *  significant kinds (at most three), told in the order they first happened —
 *  "Read 4 files, edited 2 files, ran tests". A block with no actions is its
 *  reasoning; an empty one keeps the generic name. */
export function activityTitle(group: Pick<ActivityGroup, "items">): string {
  const tallies = new Map<Category, Tally>();
  const count = (category: Category, position: number, targets: readonly string[]) => {
    const tally = tallies.get(category) ?? { first: position, targets: new Set<string>() };
    for (const target of targets) tally.targets.add(target);
    tallies.set(category, tally);
  };
  group.items.forEach((item, position) => {
    if (item.kind === "task") {
      count("tasks", position, [item.taskId]);
      return;
    }
    if (item.kind !== "tool") return;
    const mcp = effectiveToolCall(item.tool, item.input).mcp;
    // A plan update is bookkeeping and already shows as task rows.
    if (mcp && isPolythMcpCall(mcp) && mcp.tool === "polyth_todo") return;
    const presentation = executionPresentation(item);
    const category = CATEGORY_OF[presentation.kind];
    if (!FILE_CATEGORIES.has(category)) {
      count(category, position, [item.id]);
      return;
    }
    const paths = [
      ...(category === "read" ? [] : item.changedFiles ?? []),
      ...(presentation.files?.map((file) => file.path) ?? []),
      ...(presentation.path ? [presentation.path] : []),
    ];
    count(category, position, paths.length > 0 ? paths : [item.id]);
  });

  const kept = [...tallies]
    .sort(([a], [b]) => SIGNIFICANCE.indexOf(a) - SIGNIFICANCE.indexOf(b))
    .slice(0, MAX_PHRASES)
    .sort(([, a], [, b]) => a.first - b.first);
  if (kept.length === 0) {
    const reasoned = group.items.some((item) => item.kind === "assistant" && item.reasoning.trim() !== "");
    return reasoned ? sentence(tr("timeline.activityReasoning")) : tr("timeline.activity");
  }
  const phrases = kept.map(([category, tally]) => {
    const phrase = PHRASE[category];
    if (typeof phrase === "string") return tr(phrase);
    const total = tally.targets.size;
    return tr(total === 1 ? phrase[0] : phrase[1], { count: total });
  });
  // A plain separator, not Intl.ListFormat: its unit lists run Chinese
  // fragments together and add "and" where a header wants a terse list.
  return sentence(phrases.join(tr("timeline.activityTitleSeparator")));
}

/** Fragments are written lower-case so they can follow one another; only the
 *  title's first letter becomes upper-case. */
function sentence(text: string): string {
  return text.charAt(0).toLocaleUpperCase(getLocale()) + text.slice(1);
}
