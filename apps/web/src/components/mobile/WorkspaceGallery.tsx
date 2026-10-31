// The Workspace's Add page: a full-height page pushed over the editor (same
// stack grammar as every phone layer — in from the inline-end edge, Back or an
// edge swipe pops it). Everything a Workspace can hold is one tap away:
//   * a large search field that matches every word, ranks title hits first and
//     marks them;
//   * All / Widgets / Apps / Layout filters with live counts;
//   * "Suggested for this project" (the project kind's summary widgets that are
//     not placed yet), then one section per package, A–Z, apps before widgets,
//     layout elements last;
//   * cards drawn from metadata only (never a live widget), with an explicit
//     added state: a tap adds, a tap on an added single-use item takes it off,
//     repeatable items (headings, dividers, duplicable widgets) add another.
// The page owns no layout: adding and removing go through the panel's commit.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { tr } from "../../i18n/index.ts";
import { railIconFor, widgetIconFor } from "../../railIcons.ts";
import { getWidget } from "../../widgets/catalog.ts";
import {
  panelGallerySections,
  panelItemKind,
  searchPanelItems,
  type PanelGallerySection,
  type PanelItemDefinition,
  type PanelItemKind,
  type PanelItemSize,
  type WorkspacePanelLayout,
} from "../../workspacePanel.ts";
import {
  AssistIcon,
  BackIcon,
  CheckIcon,
  CloseIcon,
  DividerIcon,
  HeadingIcon,
  Icon,
  PlusIcon,
  SearchIcon,
  TagIcon,
} from "../ui/index.ts";

export type GalleryFilter = "all" | PanelItemKind;

const FILTERS: readonly GalleryFilter[] = ["all", "widget", "app", "layout"];

const FILTER_LABELS = {
  all: "workspace.panel.kindAll",
  widget: "workspace.panel.kindWidgets",
  app: "workspace.panel.kindApps",
  layout: "workspace.panel.kindLayout",
} as const;

const KIND_LABELS = {
  widget: "workspace.panel.typeWidget",
  app: "workspace.panel.typeApp",
  layout: "workspace.panel.typeLayout",
} as const;

export const PANEL_SIZE_LABELS = {
  compact: "workspace.panel.sizeCompact",
  standard: "workspace.panel.sizeStandard",
  wide: "workspace.panel.sizeWide",
  large: "workspace.panel.sizeLarge",
} as const satisfies Record<PanelItemSize, string>;

/** The item's mark: its launcher or widget glyph, or a layout element's own. */
export function PanelItemGlyph({ definition }: { definition: PanelItemDefinition }) {
  if (definition.type === "launcher") {
    const Glyph = railIconFor(definition.capabilityId ?? definition.sourcePackage);
    return <Glyph />;
  }
  if (definition.type === "widget") {
    const Glyph = widgetIconFor(getWidget(definition.widgetId ?? "") ?? { id: definition.widgetId ?? definition.id, pluginId: definition.sourcePackage });
    return <Glyph />;
  }
  return <Icon icon={definition.type === "header" ? HeadingIcon : definition.type === "labeled-divider" ? TagIcon : DividerIcon} />;
}

/** `text` with each query word's first occurrence marked. */
function Marked({ text, query }: { text: string; query: string }) {
  const lower = text.toLocaleLowerCase();
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  // Case folding that changes the length (rare scripts) would misalign the marks.
  if (words.length === 0 || lower.length !== text.length) return <>{text}</>;
  const ranges = words
    .map((word) => [lower.indexOf(word), word.length] as const)
    .filter(([at]) => at >= 0)
    .map(([at, length]) => [at, at + length] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    const from = Math.max(start, cursor);
    if (from > cursor) parts.push(text.slice(cursor, from));
    parts.push(<mark key={from}>{text.slice(from, end)}</mark>);
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function GalleryCard({ definition, count, query, showPackage, onAdd, onRemove }: {
  definition: PanelItemDefinition;
  /** Instances already on the Workspace. */
  count: number;
  query: string;
  showPackage: boolean;
  onAdd: (definition: PanelItemDefinition) => void;
  onRemove: (definition: PanelItemDefinition) => void;
}) {
  const descriptionId = useId();
  // Only a tap animates the mark; the page opens with every mark at rest.
  const [changed, setChanged] = useState(false);
  const kind = panelItemKind(definition);
  const toggles = definition.singleton;
  const added = count > 0;
  const sizes = kind === "widget" && definition.supportedSizes.length > 1
    ? definition.supportedSizes.map((size) => tr(PANEL_SIZE_LABELS[size])).join(" · ")
    : null;
  const meta = [showPackage ? definition.packageLabel : null, tr(KIND_LABELS[kind]), sizes].filter(Boolean).join(" · ");
  return (
    <li className="workspace-gallery-item">
      <button
        type="button"
        className={`workspace-gallery-card${added ? " is-added" : ""}`}
        aria-pressed={toggles ? added : undefined}
        aria-label={toggles ? definition.title : tr(added ? "workspace.panel.addAnotherValue" : "workspace.panel.addItemValue", { value: definition.title })}
        aria-describedby={descriptionId}
        data-changed={changed ? "" : undefined}
        onClick={() => {
          setChanged(true);
          if (toggles && added) onRemove(definition);
          else onAdd(definition);
        }}
      >
        <span className={`workspace-gallery-card-icon workspace-gallery-card-icon--${kind}`} aria-hidden="true">
          <PanelItemGlyph definition={definition} />
        </span>
        <span className="workspace-gallery-card-copy">
          <span className="workspace-gallery-card-title">
            <strong><Marked text={definition.title} query={query} /></strong>
            {added && (
              <span className="workspace-gallery-card-badge">
                {toggles ? tr("workspace.panel.added") : tr("workspace.panel.addedTimesValue", { count })}
              </span>
            )}
          </span>
          <span className="workspace-gallery-card-description" id={descriptionId}>{definition.description}</span>
          <span className="workspace-gallery-card-meta">{meta}</span>
        </span>
        <span className="workspace-gallery-card-toggle" data-state={toggles && added ? "added" : "add"} aria-hidden="true">
          <Icon key={toggles && added ? "added" : "add"} icon={toggles && added ? CheckIcon : PlusIcon} size="sm" />
        </span>
      </button>
    </li>
  );
}

/** An app as it will sit on the Workspace: a tile, with its add/added mark. */
function GalleryAppTile({ definition, added, onAdd, onRemove }: {
  definition: PanelItemDefinition;
  added: boolean;
  onAdd: (definition: PanelItemDefinition) => void;
  onRemove: (definition: PanelItemDefinition) => void;
}) {
  const [changed, setChanged] = useState(false);
  return (
    <li className="workspace-gallery-item">
      <button
        type="button"
        className={`workspace-gallery-tile${added ? " is-added" : ""}`}
        aria-pressed={added}
        aria-label={definition.title}
        aria-description={definition.description}
        title={definition.description}
        data-changed={changed ? "" : undefined}
        onClick={() => {
          setChanged(true);
          if (added) onRemove(definition);
          else onAdd(definition);
        }}
      >
        <span className="workspace-gallery-tile-icon" aria-hidden="true"><PanelItemGlyph definition={definition} /></span>
        <span className="workspace-gallery-tile-label">{definition.title}</span>
        <span className="workspace-gallery-tile-mark" data-state={added ? "added" : "add"} aria-hidden="true">
          <Icon key={added ? "added" : "add"} icon={added ? CheckIcon : PlusIcon} size="sm" />
        </span>
      </button>
    </li>
  );
}

/** Large sections open with a preview; the rest is one tap away. */
const SECTION_PREVIEW = { app: 8, widget: 4, layout: 3 } as const;

function GallerySection({ section, icon, counts, query, showPackage, collapsible, onAdd, onRemove }: {
  section: PanelGallerySection;
  icon?: ReactNode;
  counts: ReadonlyMap<string, number>;
  query: string;
  showPackage: boolean;
  collapsible: boolean;
  onAdd: (definition: PanelItemDefinition) => void;
  onRemove: (definition: PanelItemDefinition) => void;
}) {
  const headingId = useId();
  const [expanded, setExpanded] = useState(false);
  const preview = SECTION_PREVIEW[section.kind];
  // A preview that would hide only one item shows that item instead.
  const folds = collapsible && section.items.length > preview + 1;
  const items = folds && !expanded ? section.items.slice(0, preview) : section.items;
  const tiles = section.kind === "app" && query === "";
  return (
    <section className="workspace-gallery-section" aria-labelledby={headingId}>
      <h3 className="workspace-gallery-section-head" id={headingId}>
        {icon}
        <span>{section.label}</span>
        <small>{section.items.length}</small>
      </h3>
      <ul className={tiles ? "workspace-gallery-tiles" : "workspace-gallery-list"}>
        {items.map((definition) => tiles ? (
          <GalleryAppTile
            key={definition.id}
            definition={definition}
            added={counts.has(definition.id)}
            onAdd={onAdd}
            onRemove={onRemove}
          />
        ) : (
          <GalleryCard
            key={definition.id}
            definition={definition}
            count={counts.get(definition.id) ?? 0}
            query={query}
            showPackage={showPackage}
            onAdd={onAdd}
            onRemove={onRemove}
          />
        ))}
      </ul>
      {folds && (
        <button
          type="button"
          className="workspace-gallery-more"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? tr("workspace.panel.showLess") : tr("workspace.panel.showAllValue", { count: section.items.length })}
        </button>
      )}
    </section>
  );
}

export interface WorkspaceGalleryProps {
  /** The sheet this page covers; it is drawn as that sheet's own layer. */
  host: HTMLElement;
  catalog: readonly PanelItemDefinition[];
  layout: WorkspacePanelLayout;
  /** Definition ids worth suggesting first (the project kind's widgets). */
  suggested: readonly string[];
  /** Items added during this visit (the subtitle counts them). */
  addedCount: number;
  closing: boolean;
  onAdd: (definition: PanelItemDefinition) => void;
  onRemove: (definition: PanelItemDefinition) => void;
  onClose: () => void;
  /** The page element, for the edge-swipe Back. */
  pageRef?: (element: HTMLElement | null) => void;
}

export default function WorkspaceGallery({
  host,
  catalog,
  layout,
  suggested,
  addedCount,
  closing,
  onAdd,
  onRemove,
  onClose,
  pageRef,
}: WorkspaceGalleryProps) {
  const titleId = useId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<GalleryFilter>("all");
  const scrollRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of layout.items) map.set(item.definitionId, (map.get(item.definitionId) ?? 0) + 1);
    return map;
  }, [layout]);
  // What was already there when the page opened sorts after what is not:
  // fixed for the visit, so a tile never jumps away from the finger that added it.
  const [placedOnOpen] = useState(() => new Set(counts.keys()));
  const ordered = useMemo(
    () => [...catalog].sort((a, b) => Number(placedOnOpen.has(a.id)) - Number(placedOnOpen.has(b.id))),
    [catalog, placedOnOpen],
  );
  const matches = useMemo(() => searchPanelItems(ordered, query), [ordered, query]);
  const kindCounts = useMemo(() => {
    const map = new Map<GalleryFilter, number>([["all", matches.length]]);
    for (const item of matches) {
      const kind = panelItemKind(item);
      map.set(kind, (map.get(kind) ?? 0) + 1);
    }
    return map;
  }, [matches]);
  const shown = useMemo(
    () => filter === "all" ? matches : matches.filter((item) => panelItemKind(item) === filter),
    [filter, matches],
  );
  const searching = query.trim() !== "";
  const sections = useMemo<PanelGallerySection[]>(
    () => searching
      ? shown.length > 0 ? [{ id: "results", kind: "widget", label: tr("workspace.panel.results"), items: shown }] : []
      : panelGallerySections(shown),
    [searching, shown],
  );
  const suggestion = useMemo<PanelGallerySection | null>(() => {
    if (searching || (filter !== "all" && filter !== "widget")) return null;
    const byId = new Map(catalog.map((item) => [item.id, item]));
    const items = suggested.flatMap((id) => {
      const definition = byId.get(id);
      return definition && !placedOnOpen.has(definition.id) ? [definition] : [];
    });
    return items.length > 0 ? { id: "suggested", kind: "widget", label: tr("workspace.panel.suggested"), items } : null;
  }, [catalog, filter, placedOnOpen, searching, suggested]);

  // The page takes focus as a landmark (never the search field: no keyboard on open).
  useEffect(() => { titleRef.current?.focus({ preventScroll: true }); }, []);
  // A new search or filter starts at the top of its results.
  useEffect(() => { scrollRef.current?.scrollTo?.({ top: 0 }); }, [query, filter]);

  const showEverything = () => {
    setQuery("");
    setFilter("all");
  };

  const page = (
    <div
      ref={pageRef}
      className={`workspace-gallery${closing ? " is-closing" : ""}`}
      role="region"
      aria-labelledby={titleId}
      inert={closing || undefined}
    >
      <header className="workspace-gallery-head">
        <button type="button" className="workspace-gallery-back" aria-label={tr("workspace.panel.backToEditor")} onClick={onClose}>
          <Icon icon={BackIcon} size="lg" />
        </button>
        <div className="workspace-gallery-heading">
          <h2 className="workspace-gallery-title" id={titleId} ref={titleRef} tabIndex={-1}>{tr("workspace.panel.galleryTitle")}</h2>
          <p className={`workspace-gallery-subtitle${addedCount > 0 ? " is-added" : ""}`} aria-live="polite">
            {addedCount > 0
              ? tr("workspace.panel.addedCountValue", { count: addedCount })
              : tr("workspace.panel.availableValue", { count: catalog.length })}
          </p>
        </div>
        <button type="button" className="workspace-gallery-done" onClick={onClose}>{tr("common.done")}</button>
      </header>
      <div className="workspace-gallery-tools">
        <div className="workspace-gallery-search">
          <Icon icon={SearchIcon} />
          <input
            type="search"
            value={query}
            placeholder={tr("workspace.panel.searchPlaceholder")}
            aria-label={tr("workspace.panel.searchLabel")}
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query !== "" && (
            <button type="button" className="workspace-gallery-search-clear" aria-label={tr("mobile.sheet.clearSearch")} onClick={() => setQuery("")}>
              <Icon icon={CloseIcon} size="sm" />
            </button>
          )}
        </div>
        <div className="workspace-gallery-filters" role="group" aria-label={tr("workspace.panel.filterLabel")} data-owns-swipe="">
          {FILTERS.map((id) => (
            <button
              key={id}
              type="button"
              className="workspace-gallery-filter"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              <span>{tr(FILTER_LABELS[id])}</span>
              <small>{kindCounts.get(id) ?? 0}</small>
            </button>
          ))}
        </div>
      </div>
      <div className="workspace-gallery-scroll" ref={scrollRef}>
        {suggestion && (
          <GallerySection
            section={suggestion}
            icon={<Icon icon={AssistIcon} size="sm" />}
            counts={counts}
            query=""
            showPackage
            collapsible={false}
            onAdd={onAdd}
            onRemove={onRemove}
          />
        )}
        {sections.map((section) => (
          <GallerySection
            key={`${filter}:${section.id}`}
            section={section}
            counts={counts}
            query={query}
            showPackage={searching}
            collapsible={!searching && filter === "all"}
            onAdd={onAdd}
            onRemove={onRemove}
          />
        ))}
        {sections.length === 0 && (
          <div className="workspace-gallery-empty">
            <span className="workspace-gallery-empty-icon" aria-hidden="true"><Icon icon={SearchIcon} size="xl" /></span>
            <strong>{searching ? tr("workspace.panel.noMatchesValue", { query: query.trim() }) : tr("workspace.panel.noItems")}</strong>
            <p>{tr("workspace.panel.noMatchesDetail")}</p>
            {(searching || filter !== "all") && (
              <button type="button" className="workspace-gallery-empty-action" onClick={showEverything}>
                {tr("workspace.panel.showEverything")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
  return createPortal(page, host);
}
