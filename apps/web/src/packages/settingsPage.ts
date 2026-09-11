import { createElement, type ComponentType } from "react";
import type { SettingsNavigationTarget, SettingsPageRedirect } from "@polyth/web-sdk";
import { registerSlot } from "../slots.ts";
import type { SettingsSearchItem } from "../settings/registry.ts";

export type SettingsPageGroup = "Workspace" | "Engineering" | "Customize" | "System";

interface PackageSettingsPage {
  id: string;
  packageId?: string;
  label: string;
  group: SettingsPageGroup;
  icon?: string;
  order?: number;
  nav?: boolean;
  redirect?: SettingsPageRedirect;
  component: ComponentType<{ settingsTarget?: SettingsNavigationTarget }>;
  settingsItems?: SettingsSearchItem[];
}

export function installSettingsPage(page: PackageSettingsPage): () => void {
  const ownerPackageId = page.packageId ?? "host";
  return registerSlot(
    "settings.pages",
    page.id,
    (props) => createElement(
      page.component,
      { settingsTarget: props.settingsTarget as SettingsNavigationTarget | undefined },
    ),
    page.order ?? 0,
    {
      label: page.label,
      group: page.group,
      ...(page.icon ? { icon: page.icon } : {}),
      ...(page.nav === false ? { nav: false } : {}),
      ...(page.redirect ? { redirect: page.redirect } : {}),
      packageId: ownerPackageId,
      pageId: page.id,
      ...(page.settingsItems ? { settingsItems: page.settingsItems } : {}),
    },
    ownerPackageId,
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
