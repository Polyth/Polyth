import type { ChatProfileDto, ChatProviderDto, ChatTabDto } from "@polyth/contracts";
import type { MenuEntry } from "../../../../apps/web/src/components/ui/index.ts";
import { providerGlyph } from "./providerGlyph.ts";

export function buildTabContextMenuEntries(input: {
  tab: ChatTabDto;
  hasMultipleProfiles: boolean;
  onAction(action: string): void;
}): MenuEntry[] {
  const { tab, hasMultipleProfiles, onAction } = input;
  const act = (action: string) => () => onAction(action);
  return [
    { id: "reload", label: "Reload", onSelect: act("reload") },
    { id: "duplicate", label: "Duplicate", onSelect: act("duplicate") },
    { id: "move-left", label: "Move left", onSelect: act("move-left") },
    { id: "move-right", label: "Move right", onSelect: act("move-right") },
    ...(hasMultipleProfiles
      ? [{ id: "change-profile", label: "Change profile", onSelect: act("change-profile") }]
      : []),
    "separator",
    { id: "external", label: "Open in system browser", onSelect: act("external") },
    { id: "copy", label: "Copy URL", onSelect: act("copy") },
    "separator",
    { id: "pin", label: tab.pinned ? "Unpin tab" : "Pin tab", onSelect: act("pin") },
    "separator",
    { id: "close", label: "Close", onSelect: act("close") },
    { id: "close-others", label: "Close others", onSelect: act("close-others") },
  ];
}

export function tabContextMenuLabels(entries: MenuEntry[]): string[] {
  const labels: string[] = [];
  for (const entry of entries) {
    if (entry === "separator") labels.push("separator");
    else if (typeof entry === "object" && "label" in entry) labels.push(entry.label);
  }
  return labels;
}

export function buildAddMenuEntries(input: {
  recentProfiles: ChatProfileDto[];
  providers: ChatProviderDto[];
  onOpenProvider(providerId: string, url?: string, profileId?: string): void;
  onCustomOpen(): void;
  close(): void;
}): MenuEntry[] {
  const pick = (providerId: string, url?: string, profileId?: string) => {
    input.close();
    void input.onOpenProvider(providerId, url, profileId);
  };
  const entries: MenuEntry[] = [{ heading: "Recent" }];
  for (const profile of input.recentProfiles) {
    const provider = input.providers.find((item) => item.id === profile.providerId);
    entries.push({
      id: `recent-${profile.id}`,
      label: `${provider?.name ?? profile.providerId} / ${profile.name}`,
      onSelect: () => pick(profile.providerId, profile.customUrl ?? provider?.homeUrl, profile.id),
    });
  }
  entries.push({ heading: "Chats" });
  for (const provider of input.providers.filter((p) => p.id !== "custom")) {
    entries.push({
      id: provider.id,
      label: provider.name,
      icon: () => providerGlyph(provider.id),
      onSelect: () => {
        input.close();
        void input.onOpenProvider(provider.id);
      },
    });
  }
  entries.push({
    id: "custom-chat",
    label: "+ Custom chat",
    onSelect: () => {
      input.close();
      input.onCustomOpen();
    },
  });
  return entries;
}

export function buildStripMenuEntries(input: {
  domainLabel: string;
  addressOpen: boolean;
  onBack(): void;
  onForward(): void;
  onReload(): void;
  onShowAddress(): void;
  onCopyUrl(): void;
  onOpenExternal(): void;
}): MenuEntry[] {
  const entries: MenuEntry[] = [
    { id: "back", label: "Back", onSelect: input.onBack },
    { id: "forward", label: "Forward", onSelect: input.onForward },
    { id: "reload", label: "Reload", onSelect: input.onReload },
    "separator",
  ];
  if (!input.addressOpen) {
    entries.push({
      id: "address",
      label: input.domainLabel,
      detail: "Navigate",
      onSelect: input.onShowAddress,
    });
  }
  entries.push(
    { id: "copy-url", label: "Copy URL", onSelect: input.onCopyUrl },
    { id: "external", label: "Open externally", onSelect: input.onOpenExternal },
  );
  return entries;
}
