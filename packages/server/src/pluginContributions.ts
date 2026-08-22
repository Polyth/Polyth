import type { Disposable, UiSlotItem } from "@polyth/contracts";

export interface PluginContributionHub {
  slots: {
    add(item: UiSlotItem): Disposable;
  };
  getActiveContributions(): UiSlotItem[];
  onChange(callback: () => void): Disposable;
}

export function createPluginContributionHub(): PluginContributionHub {
  const active = new Map<string, UiSlotItem>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  return {
    slots: {
      add(item) {
        const pluginId = typeof item.props?.pluginId === "string"
          ? item.props.pluginId
          : "__anonymous__";
        const key = `${pluginId}:${item.id}`;
        active.set(key, item);
        notify();
        return {
          dispose() {
            if (active.get(key) !== item) return;
            active.delete(key);
            notify();
          },
        };
      },
    },
    getActiveContributions: () => [...active.values()],
    onChange(callback) {
      listeners.add(callback);
      return { dispose: () => { listeners.delete(callback); } };
    },
  };
}
