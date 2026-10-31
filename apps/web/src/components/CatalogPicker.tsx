import { useMemo, useState, type ReactNode } from "react";
import { tr } from "../i18n/index.ts";
import { SearchIcon, Select, TextInput } from "./ui/index.ts";

export interface CatalogPickerItem {
  id: string;
  label: string;
  description?: string;
  /** Stable registry id used by the package filter. */
  packageId: string;
  /** Human package/group label shown in the group heading. */
  packageLabel: string;
  icon?: ReactNode;
  keywords?: readonly string[];
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  status?: string;
  meta?: string;
  tags?: readonly string[];
  action?: ReactNode;
  onSelect: () => void;
}

export interface CatalogPickerProps {
  items: readonly CatalogPickerItem[];
  className?: string;
  searchPlaceholder?: string;
  searchLabel?: string;
  emptyLabel?: string;
  allPackagesLabel?: string;
  sheet?: boolean;
}

export function filterCatalogItems(
  items: readonly CatalogPickerItem[],
  query: string,
  packageId: string,
): CatalogPickerItem[] {
  const normalized = query.trim().toLowerCase();
  return items.filter((item) => {
    if (packageId !== "all" && item.packageId !== packageId) return false;
    if (!normalized) return true;
    return [
      item.label,
      item.description ?? "",
      item.packageLabel,
      ...(item.keywords ?? []),
    ].join(" ").toLowerCase().includes(normalized);
  });
}

function packageLabels(items: readonly CatalogPickerItem[]): Map<string, string> {
  const labels = new Map<string, string>();
  const idsByLabel = new Map<string, Set<string>>();
  for (const item of items) {
    if (!labels.has(item.packageId)) labels.set(item.packageId, item.packageLabel);
    const ids = idsByLabel.get(item.packageLabel) ?? new Set<string>();
    ids.add(item.packageId);
    idsByLabel.set(item.packageLabel, ids);
  }
  return new Map([...labels].map(([id, label]) => [
    id,
    (idsByLabel.get(label)?.size ?? 0) > 1 ? `${label} — ${id}` : label,
  ]));
}

export default function CatalogPicker({
  items,
  className = "",
  searchPlaceholder = tr("common.search"),
  searchLabel = tr("common.search"),
  emptyLabel = tr("picker.noMatches"),
  allPackagesLabel = tr("settings.packagespage.packages"),
  sheet = false,
}: CatalogPickerProps) {
  const [query, setQuery] = useState("");
  const [packageId, setPackageId] = useState("all");
  const compact = items.length > 0 && items.length <= 4;
  const labels = useMemo(() => packageLabels(items), [items]);
  const packageOptions = useMemo(() => [...labels].map(([id, label]) => ({ id, label })), [labels]);
  const shown = useMemo(
    () => filterCatalogItems(items, compact ? "" : query, compact ? "all" : packageId),
    [compact, items, packageId, query],
  );
  const groups = useMemo(() => {
    const grouped = new Map<string, CatalogPickerItem[]>();
    for (const item of shown) {
      const key = item.packageId;
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
    return new Map([...grouped.entries()].sort(([a], [b]) =>
      (labels.get(a) ?? a).localeCompare(labels.get(b) ?? b) || a.localeCompare(b)));
  }, [labels, shown]);

  return (
    <div
      className={`catalog-picker catalog-picker-content${compact ? " catalog-picker-compact" : ""}${className ? ` ${className}` : ""}`}
      data-compact-count={compact ? items.length : undefined}
    >
      <div className="catalog-picker-controls">
        <div className="catalog-picker-search">
          <SearchIcon aria-hidden="true" />
          <TextInput
            value={query}
            placeholder={searchPlaceholder}
            aria-label={searchLabel}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="catalog-picker-filter">
          <span>{tr("settings.packagespage.packages")}</span>
          <Select
            label={tr("settings.packagespage.packages")}
            value={packageId}
            onChange={setPackageId}
            options={[
              { value: "all", label: allPackagesLabel },
              ...packageOptions.map(({ id, label }) => ({ value: id, label })),
            ]}
            mobileSheet
          />
        </div>
      </div>
      <div className="catalog-picker-list">
        {groups.size === 0 && <div className="catalog-picker-empty">{emptyLabel}</div>}
        {[...groups].map(([id, groupItems]) => (
          <section className="catalog-picker-group" key={id}>
            <header className="catalog-picker-group-head">
              <span>{labels.get(id) ?? id}</span>
              <small>{groupItems.length}</small>
            </header>
            <div className="catalog-picker-group-list">
              {groupItems.map((item) => {
                const role = item.checked === undefined ? "menuitem" : "menuitemcheckbox";
                return (
                  <button
                    key={item.id}
                    type="button"
                    role={sheet ? undefined : role}
                    aria-checked={!sheet && item.checked !== undefined ? item.checked : undefined}
                    aria-pressed={sheet && item.checked !== undefined ? item.checked : undefined}
                    disabled={item.disabled}
                    className={`catalog-picker-item${item.checked ? " is-active" : ""}${item.danger ? " catalog-picker-item--danger" : ""}${item.icon ? "" : " catalog-picker-item--no-icon"}`}
                    onClick={item.onSelect}
                  >
                    {item.icon && <span className="catalog-picker-item-icon" aria-hidden="true">{item.icon}</span>}
                    <span className="catalog-picker-item-copy">
                      <span className="catalog-picker-item-title-row">
                        <strong>{item.label}</strong>
                        {item.status && <span className="catalog-picker-item-status">{item.status}</span>}
                      </span>
                      {item.description && <small>{item.description}</small>}
                      {item.meta && <span className="catalog-picker-item-meta">{item.meta}</span>}
                      {item.tags && item.tags.length > 0 && (
                        <span className="catalog-picker-item-tags">
                          {item.tags.map((tag) => <span key={tag}>{tag}</span>)}
                        </span>
                      )}
                    </span>
                    {item.action && <span className="catalog-picker-item-action" aria-hidden="true">{item.action}</span>}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
