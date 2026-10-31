// How a marker looks everywhere: one tinted glyph per marker (navigator row,
// menus, panel) and a labelled chip where there is room (chat header).
import { Icon } from "../../../apps/web/src/components/ui/index.ts";
import {
  BugIcon,
  CheckIcon,
  ClockIcon,
  FavoriteIcon,
  FlagIcon,
  HeartIcon,
  HelpIcon,
  ShowIcon,
  TagIcon,
  ZapIcon,
  type LucideIcon,
} from "../../../apps/web/src/components/ui/icons.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import type { MarkerColor, MarkerDefinition, MarkerIcon, SessionMarker } from "../src/markers.ts";

export const MARKER_ICON_GLYPHS: Readonly<Record<MarkerIcon, LucideIcon>> = {
  eye: ShowIcon,
  clock: ClockIcon,
  flag: FlagIcon,
  tag: TagIcon,
  star: FavoriteIcon,
  bolt: ZapIcon,
  bug: BugIcon,
  question: HelpIcon,
  check: CheckIcon,
  heart: HeartIcon,
};

const BUILT_IN_COPY: Readonly<Record<string, { label: () => string; description: () => string }>> = {
  "needs-review": {
    label: () => tr("sessionmarkers.marker.needsReview"),
    description: () => tr("sessionmarkers.marker.needsReviewDescription"),
  },
  "reply-later": {
    label: () => tr("sessionmarkers.marker.replyLater"),
    description: () => tr("sessionmarkers.marker.replyLaterDescription"),
  },
  important: {
    label: () => tr("sessionmarkers.marker.important"),
    description: () => tr("sessionmarkers.marker.importantDescription"),
  },
};

/** Predefined markers speak the reader's language; custom ones keep their name. */
export const markerLabel = (marker: Pick<MarkerDefinition, "id" | "label" | "builtIn">): string =>
  marker.builtIn ? BUILT_IN_COPY[marker.id]?.label() ?? marker.label : marker.label;

export const markerDescription = (marker: Pick<MarkerDefinition, "id" | "description" | "builtIn">): string | undefined =>
  marker.builtIn ? BUILT_IN_COPY[marker.id]?.description() ?? marker.description : marker.description;

export const colorLabel = (color: MarkerColor): string => tr(`sessionmarkers.color.${color}`);
export const iconLabel = (icon: MarkerIcon): string => tr(`sessionmarkers.icon.${icon}`);

/** A chat's markers paired with their definitions, unknown ids dropped. */
export function definedMarkers(
  markers: readonly SessionMarker[],
  definitions: readonly MarkerDefinition[],
): Array<{ marker: SessionMarker; definition: MarkerDefinition }> {
  return markers.flatMap((marker) => {
    const definition = definitions.find((candidate) => candidate.id === marker.id);
    return definition ? [{ marker, definition }] : [];
  });
}

export function MarkerGlyph({ definition, size = "sm", className }: {
  definition: Pick<MarkerDefinition, "color" | "icon">;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span className={`session-markers-glyph${className ? ` ${className}` : ""}`} data-color={definition.color} aria-hidden="true">
      <Icon icon={MARKER_ICON_GLYPHS[definition.icon]} size={size} />
    </span>
  );
}

export function MarkerChip({ definition, note }: { definition: MarkerDefinition; note?: string }) {
  const label = markerLabel(definition);
  const title = note ? tr("sessionmarkers.badge.note", { label, note }) : label;
  return (
    <span className="session-markers-chip" data-color={definition.color} title={title}>
      <Icon icon={MARKER_ICON_GLYPHS[definition.icon]} size="sm" />
      <span className="session-markers-chip__label">{label}</span>
    </span>
  );
}
