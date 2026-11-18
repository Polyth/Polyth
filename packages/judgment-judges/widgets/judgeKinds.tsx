// What a judge is about, in the person's words: its category (the tile and its
// tint), and the three facts every judge reduces to (when it asks, what it
// asks, what it does). The guide teaches exactly these three, so the list, the
// gallery and the editor all read the same way.
import { tr } from "@polyth/web/i18n";
import {
  BellIcon, GaugeIcon, Icon, JudgeIcon, MergeIcon, ShieldAlertIcon, ShieldIcon, SyncIcon, TargetIcon, TerminalIcon, TimerIcon, type LucideIcon,
} from "@polyth/web/ui";
import { starterById, type JudgeCategory } from "../src/starters.ts";
import { approvesRequest, isAction, type ActionKind, type DisplayEffectKind, type JudgeDefinition, type JudgeEffect, type JudgeInput, type JudgeTrigger } from "../src/types.ts";

type Key = Parameters<typeof tr>[0];

/** The category a judge reads as: its starter's, else what it reacts to and does. */
export function judgeCategory(judge: Pick<JudgeDefinition, "trigger" | "effects"> & { starter?: string }): JudgeCategory {
  const starter = starterById(judge.starter);
  if (starter) return starter.category;
  if (judge.trigger === "permission-requested") return "permissions";
  if (judge.trigger === "limit-reached") return "limits";
  if (judge.effects.some((effect) => effect.kind === "send-message")) return "long-work";
  if (judge.effects.some((effect) => effect.kind === "merge-isolated" || effect.kind === "set-approval")) return "actions";
  return "quality";
}

/** The glyph on a judge's tile: what it guards or does, more specific than its category. */
export function judgeIcon(judge: Pick<JudgeInput, "trigger" | "effects">, category: JudgeCategory): LucideIcon {
  if (judge.trigger === "permission-requested") return judge.effects.some(approvesRequest) ? ShieldIcon : ShieldAlertIcon;
  if (judge.effects.some((effect) => effect.kind === "merge-isolated")) return MergeIcon;
  return CATEGORY_ICON[category];
}
export const CATEGORY_ICON: Record<JudgeCategory, LucideIcon> = {
  permissions: ShieldIcon, actions: TerminalIcon, "long-work": SyncIcon, quality: TargetIcon, limits: GaugeIcon, attention: BellIcon,
};
export const CATEGORY_KEYS: Record<JudgeCategory, Key> = {
  permissions: "judgesui.catPermissions", actions: "judgesui.catActions", "long-work": "judgesui.catLongWork",
  quality: "judgesui.catQuality", limits: "judgesui.catLimits", attention: "judgesui.catAttention",
};

/** A judge's tile: the glyph on a wash of its category's tint. */
export function JudgeTile({ icon, category }: { icon: LucideIcon; category: JudgeCategory }) {
  return <span className="judges-tile" data-category={category}><Icon icon={icon} size="md" /></span>;
}
export { JudgeIcon };

/** The built-in judges this package registers with Judgment, as the page names them. */
export const BUILTIN_COPY: Record<string, { title: Key; description: Key; category: JudgeCategory; icon: LucideIcon }> = {
  "judges.completion-check": { title: "judgesui.builtinCompletionTitle", description: "judgesui.builtinCompletionDesc", category: "quality", icon: TargetIcon },
  "judges.needs-you": { title: "judgesui.builtinNeedsYouTitle", description: "judgesui.builtinNeedsYouDesc", category: "attention", icon: BellIcon },
  "judges.keep-warm": { title: "judgesui.builtinKeepWarmTitle", description: "judgesui.builtinKeepWarmDesc", category: "long-work", icon: SyncIcon },
  "judges.quiet-command": { title: "judgesui.builtinQuietTitle", description: "judgesui.builtinQuietDesc", category: "long-work", icon: TimerIcon },
};

const TRIGGER_WHEN: Record<JudgeTrigger, Key> = {
  "turn-completed": "judgesui.trigTurnShort", "permission-requested": "judgesui.trigPermissionShort", "limit-reached": "judgesui.trigLimitShort",
};
export const whenText = (trigger: JudgeTrigger) => tr(TRIGGER_WHEN[trigger]);

const DISPLAY_SHORT: Record<DisplayEffectKind, Key> = {
  "timeline-marker": "judgesui.dispMarkShort", "needs-attention": "judgesui.dispAttentionShort", "suggest-follow-up": "judgesui.dispFollowShort",
};
const ACTION_SHORT: Record<ActionKind, Key> = {
  "send-message": "judgesui.actSendShort", "merge-isolated": "judgesui.actMergeShort", "approve-request": "judgesui.actApproveShort",
  "deny-request": "judgesui.actDenyShort", "set-approval": "judgesui.actApprovalShort", "switch-route": "judgesui.actRouteShort",
};
export const effectShortText = (effect: JudgeEffect) => tr(isAction(effect.kind) ? ACTION_SHORT[effect.kind as ActionKind] : DISPLAY_SHORT[effect.kind as DisplayEffectKind]);
const andList = (items: string[]) => items.join(tr("judgesui.listAnd"));
/** Everything a judge can do, once each: `approves and denies`. */
export const doesSummary = (judge: Pick<JudgeInput, "effects">) => andList([...new Set(actionsFirst(judge.effects).map(effectShortText))]);
/** What a judge does reads best with its actions before its markers: `denies and flags it for you`. */
function actionsFirst(effects: readonly JudgeEffect[]): JudgeEffect[] {
  return [...effects.filter((effect) => isAction(effect.kind)), ...effects.filter((effect) => !isAction(effect.kind))];
}

/**
 * What a judge does, one line per answer that does something: `unfinished →
 * sends a message`. Markers follow the answer the judge fires on; a yes/no or
 * score judge does everything when it fires.
 */
export function doesLines(judge: JudgeInput): Array<{ answer?: string; text: string }> {
  const q = judge.question;
  if (q.type === "route") return [{ text: tr("judgesui.glanceRoute") }];
  const effects = judge.effects;
  const unique = (list: JudgeEffect[]) => [...new Set(actionsFirst(list).map(effectShortText))];
  if (q.type !== "choice") {
    const answer = q.type === "noul" ? tr("judgesui.yes") : tr("judgesui.glanceScoreAtLeast", { percent: Math.round(judge.fire.threshold * 100) });
    return effects.length ? [{ answer, text: andList(unique(effects)) }] : [];
  }
  return q.labels.flatMap((entry) => {
    const here = effects.filter((effect) => isAction(effect.kind)
      ? (effect as { when?: string }).when === entry.label
      : judge.fire.label === entry.label);
    return here.length && entry.label ? [{ answer: entry.label, text: andList(unique(here)) }] : [];
  });
}

/** When it asks, what it asks and what it does, as a three-part strip. */
export function JudgeGlance({ judge }: { judge: JudgeInput }) {
  const lines = doesLines(judge);
  const asks = judge.question.text.trim();
  return <dl className="judges-glance">
    <div className="judges-glance-part"><dt>{tr("judgesui.glanceWhen")}</dt><dd>{whenText(judge.trigger)}</dd></div>
    <div className="judges-glance-part"><dt>{tr(judge.question.type === "route" ? "judgesui.glanceDecides" : "judgesui.glanceAsks")}</dt>
      <dd>{asks ? tr("judgesui.quoted", { text: asks }) : <span className="judges-glance-empty">{tr("judgesui.glanceNoQuestion")}</span>}</dd></div>
    <div className="judges-glance-part"><dt>{tr("judgesui.glanceDoes")}</dt>
      <dd>{lines.length ? <ul className="judges-glance-lines">{lines.map((line, index) => <li key={index}>
        {line.answer !== undefined && <><code className="judges-glance-answer">{line.answer}</code><span className="judges-glance-arrow" aria-hidden="true">→</span>
          <span className="sr-only">{tr("judgesui.glanceThen")}</span></>}
        <span>{line.text}</span></li>)}</ul>
        : <span className="judges-glance-empty">{tr("judgesui.glanceNothing")}</span>}</dd></div>
  </dl>;
}
