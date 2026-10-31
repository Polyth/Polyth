export interface PickerItem {
  id: string;
  label: string;
  group: string;
  detail?: string;
  keywords?: readonly string[];
}

export function filterPickerItems<T extends PickerItem>(items: readonly T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...items];

  return items.filter((item) =>
    [item.id, item.label, item.group, item.detail ?? "", ...(item.keywords ?? [])]
      .some((value) => value.toLowerCase().includes(normalized)),
  );
}
