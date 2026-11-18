// The page's own short guide: every judge is three facts (when it asks, what
// it asks, what it does) and three safety rules. It opens by itself until a
// judge is on, and remembers being closed or opened on this device only (a pure
// UI preference, never history).
import { useState } from "react";
import { tr } from "@polyth/web/i18n";
import { ClockIcon, HelpIcon, Icon, ShieldIcon, ZapIcon, type LucideIcon } from "@polyth/web/ui";
import { DisclosureRow, ItemList } from "../../../apps/web/src/components/settings/parts.tsx";

type Key = Parameters<typeof tr>[0];
const STORAGE_KEY = "polyth.judges.guide.v1";

function readPreference(): "open" | "closed" | undefined {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return value === "open" || value === "closed" ? value : undefined;
  } catch { return undefined; }
}
function writePreference(value: "open" | "closed") {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, value); } catch { /* private mode: the choice lasts this visit */ }
}

const STEPS: Array<{ icon: LucideIcon; title: Key; body: Key }> = [
  { icon: ClockIcon, title: "judgesui.guideWhenTitle", body: "judgesui.guideWhenBody" },
  { icon: HelpIcon, title: "judgesui.guideAsksTitle", body: "judgesui.guideAsksBody" },
  { icon: ZapIcon, title: "judgesui.guideDoesTitle", body: "judgesui.guideDoesBody" },
];
const RULES: Key[] = ["judgesui.guideRuleClose", "judgesui.guideRuleAccess", "judgesui.guideRuleTry"];

/** `defaultOpen` applies until the person opens or closes the guide themselves. */
export default function JudgesGuide({ defaultOpen }: { defaultOpen: boolean }) {
  const [open, setOpen] = useState(() => {
    const stored = readPreference();
    return stored ? stored === "open" : defaultOpen;
  });
  const toggle = () => setOpen((current) => { writePreference(current ? "closed" : "open"); return !current; });
  return <ItemList className="judges-guide" label={tr("judgesui.guideTitle")}>
    <DisclosureRow label={<span className="judges-guide-label"><Icon icon={HelpIcon} size="sm" />{tr("judgesui.guideTitle")}</span>}
      value={open ? undefined : tr("judgesui.guideSummary")} open={open} onToggle={toggle}>
      <ol className="judges-guide-steps">
        {STEPS.map((step, index) => <li className="judges-guide-step" key={step.title}>
          <span className="judges-guide-mark" aria-hidden="true"><Icon icon={step.icon} size="sm" /><i>{index + 1}</i></span>
          <strong className="judges-guide-step-title">{tr(step.title)}</strong>
          <p className="judges-guide-step-body">{tr(step.body)}</p>
        </li>)}
      </ol>
      <ul className="judges-guide-rules">
        {RULES.map((rule) => <li key={rule}><Icon icon={ShieldIcon} size="sm" /><span>{tr(rule)}</span></li>)}
      </ul>
    </DisclosureRow>
  </ItemList>;
}
