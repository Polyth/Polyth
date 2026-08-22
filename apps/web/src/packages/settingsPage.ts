import { createElement, type ComponentType } from "react";
import { registerSlot } from "../slots.ts";
import type { SettingsSearchItem } from "../settings/registry.ts";

export type SettingsPageGroup = "Workspace" | "Engineering" | "Customize" | "System";

interface PackageSettingsPage {
  id: string;
  packageId: string;
  label: string;
  group: SettingsPageGroup;
  icon?: string;
  order?: number;
  component: ComponentType;
  settingsItems?: SettingsSearchItem[];
}

export function installSettingsPage(page: PackageSettingsPage): () => void {
  return registerSlot(
    "settings.pages",
    page.id,
    () => createElement(page.component),
    page.order ?? 0,
    {
      label: page.label,
      group: page.group,
      ...(page.icon ? { icon: page.icon } : {}),
      packageId: page.packageId,
      pageId: page.id,
      ...(page.settingsItems ? { settingsItems: page.settingsItems } : {}),
    },
  );
}

export function combineUnregister(...unregister: Array<() => void>): () => void {
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (let index = unregister.length - 1; index >= 0; index--) unregister[index]!();
  };
}
