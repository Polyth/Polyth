// "Add judge" starts here: a blank judge, or one of the starter templates
// grouped by what they are about. A template only fills the editor; nothing is
// saved until the person saves it, and every template says it is a starting
// point, not a recommendation.
import { useEffect, useRef } from "react";
import { tr } from "@polyth/web/i18n";
import { AddIcon, Badge, Button, BackIcon, Icon, Notice } from "@polyth/web/ui";
import { ItemList, ItemRow, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import { STARTERS, type JudgeCategory, type StarterTemplate } from "../src/starters.ts";
import type { JudgeInput } from "../src/types.ts";
import { CATEGORY_KEYS, judgeIcon, JudgeTile, whenText } from "./judgeKinds.tsx";

const ORDER: JudgeCategory[] = ["permissions", "actions", "long-work", "quality", "limits"];
/** A starter in the person's language: its copy comes from the package's own keys. */
export const buildStarter = (starter: StarterTemplate): JudgeInput => starter.build((key) => tr(key as Parameters<typeof tr>[0]));

export default function StarterGallery({ onBlank, onPick, onBack, inList }: {
  onBlank: () => void;
  onPick: (starter: StarterTemplate, draft: JudgeInput) => void;
  onBack: () => void;
  /** Starter ids already in the list, to say so on their rows. */
  inList: ReadonlySet<string>;
}) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, []);
  return <div className="judges-detail judges-gallery">
    <Button ref={back} size="sm" variant="ghost" iconStart={BackIcon} className="judges-back" onClick={onBack}>{tr("judgesui.allJudges")}</Button>
    <Section title={tr("judgesui.galleryTitle")} hint={tr("judgesui.galleryHint")}>
      <ItemList label={tr("judgesui.galleryTitle")}>
        <ItemRow className="judges-row" icon={<span className="judges-tile" data-category="blank"><Icon icon={AddIcon} size="md" /></span>}
          title={tr("judgesui.blankJudge")} description={tr("judgesui.blankJudgeDesc")} onOpen={onBlank} openLabel={tr("judgesui.blankJudge")} />
      </ItemList>
    </Section>
    <Notice className="judges-starter-notice" tone="info" heading={tr("judgesui.startersHeading")}>{tr("judgesui.galleryDisclaimer")}</Notice>
    {ORDER.map((category) => {
      const starters = STARTERS.filter((starter) => starter.category === category);
      if (!starters.length) return null;
      return <Section key={category} title={tr(CATEGORY_KEYS[category])}>
        <ItemList label={tr(CATEGORY_KEYS[category])}>
          {starters.map((starter) => {
            const draft = buildStarter(starter);
            return <ItemRow key={starter.id} className="judges-row" icon={<JudgeTile icon={judgeIcon(draft, category)} category={category} />}
              title={draft.name} description={draft.description}
              meta={<>
                <span className="judges-row-when">{whenText(draft.trigger)}</span>
                {inList.has(starter.id) && <Badge tone="neutral">{tr("judgesui.alreadyAdded")}</Badge>}
                {draft.trigger === "limit-reached" && <Badge tone="neutral">{tr("judgesui.needsModels")}</Badge>}
              </>}
              onOpen={() => onPick(starter, draft)} openLabel={tr("judgesui.useTemplateAria", { name: draft.name })} />;
          })}
        </ItemList>
      </Section>;
    })}
  </div>;
}
