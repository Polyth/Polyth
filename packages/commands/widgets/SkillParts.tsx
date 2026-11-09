import type { SkillHarnessDto } from "@polyth/contracts/capability-installations";
import type { CSSProperties } from "react";
import { AssistIcon, Icon } from "../../../apps/web/src/components/ui/index.ts";
import { formatRelativeTime, tr } from "../../../apps/web/src/i18n/index.ts";
import { relativeParts } from "./skillModel.ts";

/** A source's picture when it has one, or the page's own glyph. Never initials. */
export function SkillMark({ avatar }: { avatar?: string | undefined }) {
  return avatar
    ? <img className="skills-mark" src={avatar} alt="" draggable={false} />
    : <Icon icon={AssistIcon} size="md" />;
}

export const skillCountLabel = (count: number): string =>
  count === 1 ? tr("settings.skills.catalog.skills.one") : tr("settings.skills.catalog.skills", { count });

export const updatedLabel = (at: number): string => {
  const { value, unit } = relativeParts(at);
  return tr("settings.skills.catalog.updatedAgo", { time: formatRelativeTime(value, unit, { numeric: "auto" }) });
};

export const harnessStyle = (harness: Pick<SkillHarnessDto, "color">): CSSProperties | undefined =>
  harness.color ? { "--skills-harness-color": harness.color } as CSSProperties : undefined;
