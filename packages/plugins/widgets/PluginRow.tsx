import type { InstalledPluginDto } from "@polyth/contracts";
import { ItemRow } from "../../../apps/web/src/components/settings/parts.tsx";
import { Badge, Button, Spinner, Switch } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { PluginMark } from "./PluginGallery.tsx";
import { availableUpdate } from "./pluginTaxonomy.ts";
import { needsReviewToEnable } from "./usePluginLibrary.ts";

/** The one state worth a badge in a list row; on/off is the switch's job. */
function rowBadge(plugin: InstalledPluginDto) {
  if (plugin.enabled && plugin.status === "error") return <Badge tone="danger" dot>{tr("common.error")}</Badge>;
  if (needsReviewToEnable(plugin) || (plugin.update && plugin.permissions.review)) {
    return <Badge tone="warning" dot>{tr("packages.plugins.needsReview")}</Badge>;
  }
  const update = availableUpdate(plugin);
  if (update) return <Badge tone="info">{tr("packages.plugins.updateBadge", { version: update })}</Badge>;
  if (plugin.enabled && plugin.status === "loading") return <Badge tone="warning" dot>{tr("common.loading")}</Badge>;
  return null;
}

/** One added package in the library list. The row opens the package's
 *  detail; its trailing control is the switch, or "Review & enable" while
 *  required access still waits for approval. */
export function PluginRow({
  plugin,
  query,
  busy,
  onOpen,
  onReview,
  onToggle,
}: {
  plugin: InstalledPluginDto;
  query: string;
  busy: boolean;
  onOpen: () => void;
  onReview: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const review = needsReviewToEnable(plugin);
  return (
    <ItemRow
      className="plugin-row"
      data-plugin-id={plugin.id}
      aria-busy={busy || undefined}
      icon={<PluginMark plugin={plugin} />}
      title={plugin.name}
      meta={(
        <>
          <span className="plugin-row-version">{plugin.version}</span>
          {rowBadge(plugin)}
        </>
      )}
      {...(plugin.description ? { description: plugin.description } : {})}
      highlight={query}
      inactive={!plugin.enabled}
      {...(plugin.enabled && plugin.lastError ? { error: plugin.lastError } : {})}
      onOpen={onOpen}
      openLabel={tr("packages.plugins.openDetails", { name: plugin.name })}
      trailing={review ? (
        <Button size="sm" variant="quiet" disabled={busy} onClick={onReview}>{tr("packages.plugins.reviewAndEnable")}</Button>
      ) : (
        <>
          {busy && <Spinner size="sm" label={tr("settings.packagespage.applying")} />}
          <Switch
            checked={plugin.enabled}
            disabled={busy}
            label={plugin.enabled
              ? tr("settings.packagespage.disableValue", { value: plugin.name })
              : tr("settings.packagespage.enableValue", { value: plugin.name })}
            onChange={onToggle}
          />
        </>
      )}
    />
  );
}
