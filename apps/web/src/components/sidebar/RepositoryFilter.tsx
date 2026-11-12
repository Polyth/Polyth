// Repository chips and the per-row repository mark of a multi-repository
// Project, shared by the desktop session list and the phone navigator. The
// rules (which chips, which rows match, which repositories a row shows) live in
// repositoryFilter.ts; this file only draws them.
import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { tr } from "../../i18n/index.ts";
import { repositoryMarkParts, type FilterRepository } from "../../repositoryFilter.ts";
import { setRepositoryFilter } from "../../sidebarPrefs.ts";

/** Dots drawn in a mark before the rest fold into "+n". */
const MARK_DOTS_MAX = 3;

/** One horizontal, never-wrapping row: All, then each repository in project
 *  order. Single select; arrow keys move between chips (one tab stop). */
export function RepositoryFilterChips({ projectId, repositories, active, variant = "sidebar" }: {
  projectId: string;
  repositories: readonly FilterRepository[];
  /** The active repository id; undefined is All. */
  active: string | undefined;
  variant?: "sidebar" | "phone";
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const items: Array<{ id: string | undefined; label: string; title: string; tone?: number }> = [
    // The tooltips carry what the project header's repository count used to:
    // All lists every alias and path, a chip names its own path.
    {
      id: undefined,
      label: tr("sidebar.repositoryFilter.all"),
      title: [tr("sidebar.repositoryFilter.allTitle"), ...repositories.map((repository) => `${repository.alias} · ${repository.path}`)].join("\n"),
    },
    ...repositories.map((repository) => ({
      id: repository.id,
      label: repository.alias,
      title: `${tr("sidebar.repositoryFilter.chipTitle", { alias: repository.alias })}\n${repository.path}`,
      tone: repository.tone,
    })),
  ];
  const activeIndex = Math.max(0, items.findIndex((item) => item.id === active));

  // Keep the chosen chip inside the scroller without moving the list around it.
  useLayoutEffect(() => {
    const row = rowRef.current;
    const chip = row?.children[activeIndex] as HTMLElement | undefined;
    if (!row || !chip || typeof chip.getBoundingClientRect !== "function") return;
    const bounds = row.getBoundingClientRect();
    const box = chip.getBoundingClientRect();
    if (box.left < bounds.left) row.scrollLeft -= bounds.left - box.left;
    else if (box.right > bounds.right) row.scrollLeft += box.right - bounds.right;
  }, [activeIndex]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const step = event.key === "ArrowRight" ? (rtl ? -1 : 1) : event.key === "ArrowLeft" ? (rtl ? 1 : -1) : 0;
    let next = -1;
    if (step !== 0) next = (index + step + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next < 0) return;
    event.preventDefault();
    (rowRef.current?.children[next] as HTMLElement | undefined)?.focus();
  };

  return (
    <div
      ref={rowRef}
      className="repository-filter"
      data-variant={variant}
      role="toolbar"
      aria-label={tr("sidebar.repositoryFilter.label")}
      aria-orientation="horizontal"
    >
      {items.map((item, index) => {
        const pressed = item.id === active;
        return (
          <button
            key={item.id ?? ""}
            type="button"
            className="repository-filter-chip"
            aria-pressed={pressed}
            tabIndex={index === activeIndex ? 0 : -1}
            title={item.title}
            data-repository-tone={item.tone}
            onKeyDown={(event) => onKeyDown(event, index)}
            onClick={() => setRepositoryFilter(projectId, item.id)}
          >
            {item.tone !== undefined && <span className="repository-dot" aria-hidden="true" />}
            <span className="repository-filter-chip-label" dir="auto">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Accessible name of a row's mark: "Repository: api", "Repositories: api, web". */
export function repositoryMarkLabel(repositories: readonly FilterRepository[]): string {
  return repositories.length === 1
    ? tr("sidebar.repositoryMark.one", { alias: repositories[0]!.alias })
    : tr("sidebar.repositoryMark.many", { aliases: repositories.map((repository) => repository.alias).join(", ") });
}

/** A subset session's repositories: whole dots side by side (at most three,
 *  then "+n") and their aliases, joined by "+" under All. Under a chip
 *  (`active`) the list is already narrowed to that repository, so the mark
 *  draws only the scope's other repositories after a plus ("+ • api",
 *  "+ •• api, infra"), or nothing; see `repositoryMarkParts`. The
 *  accessible name and tooltip always list the full scope. With nothing drawn, an `id` keeps a hidden description so a row's
 *  `aria-describedby` still names the scope. */
export function RepositoryMark({ repositories, active, id, className = "session-repository-mark" }: {
  repositories: readonly FilterRepository[];
  /** The list's active chip; undefined is All. */
  active?: string;
  id?: string;
  className?: string;
}) {
  const label = repositoryMarkLabel(repositories);
  const { shown, plus } = repositoryMarkParts(repositories, active);
  if (shown.length === 0) return id ? <span id={id} hidden>{label}</span> : null;
  const dots = shown.slice(0, MARK_DOTS_MAX);
  const extra = shown.length - dots.length;
  return (
    <span
      id={id}
      className={className}
      role="img"
      aria-label={label}
      title={label}
      data-plus={plus ? "true" : undefined}
    >
      {plus && <span className="repository-mark-plus" aria-hidden="true">+</span>}
      <span className="repository-dots" aria-hidden="true">
        {dots.map((repository) => (
          <span key={repository.id} className="repository-dot" data-repository-tone={repository.tone} />
        ))}
      </span>
      {extra > 0 && <span className="repository-mark-more" aria-hidden="true">+{extra}</span>}
      {/* Under All the scope reads as one unit ("api+web"); after a chip's
          plus it is a list of the others ("api, infra"). Narrow lists drop
          the text first (styles.css), leaving "+ •". */}
      <span className="repository-mark-text" aria-hidden="true" dir="auto">
        {shown.map((repository) => repository.alias).join(plus ? ", " : "+")}
      </span>
    </span>
  );
}
