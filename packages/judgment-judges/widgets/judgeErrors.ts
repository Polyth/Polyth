// Turns the English messages `validateJudgeInput` throws into the person's
// language at the widget boundary. The server keeps its canonical English
// contract and tests; a message this module does not recognise (an HTTP error,
// a future validation rule) is shown unchanged rather than guessed at.
import { tr } from "@polyth/web/i18n";

type Key = Parameters<typeof tr>[0];
type Params = Record<string, string | number>;
type Translate = (key: Key, params?: Params) => string;

/** Labels `types.ts` passes as `what` to its text/probability helpers. */
const FIELD_KEYS: Record<string, Key> = {
  "Name": "judgesui.validation.fieldName",
  "Question": "judgesui.validation.fieldQuestion",
  "Answer description": "judgesui.validation.fieldAnswerDescription",
  "Score level": "judgesui.validation.fieldScoreLevel",
  "Instructions": "judgesui.validation.fieldInstructions",
  "Follow-up text": "judgesui.validation.fieldFollowUp",
  "Message": "judgesui.validation.fieldMessage",
  "Threshold": "judgesui.validation.fieldThreshold",
  "Margin": "judgesui.validation.fieldMargin",
};

/** Labels `onlyKeys` passes as `what` in "`what`: unknown field `name`". */
const GROUP_KEYS: Record<string, Key> = {
  "Judge": "judgesui.validation.groupJudge",
  "Filters": "judgesui.validation.groupFilters",
  "Evidence": "judgesui.validation.groupEvidence",
  "Question": "judgesui.validation.fieldQuestion",
  "Answer": "judgesui.validation.groupAnswer",
  "Fire condition": "judgesui.validation.groupFire",
  "Effect": "judgesui.validation.groupEffect",
};

/** `EVIDENCE_LABELS` values, reused so evidence reads exactly as it does elsewhere. */
const EVIDENCE_KEYS: Record<string, Key> = {
  "Last request": "judgesui.evLastRequest",
  "Last answer": "judgesui.evLastAnswer",
  "Commands run": "judgesui.evCommands",
  "Changed files": "judgesui.evChangedFiles",
  "Open todos": "judgesui.evOpenTodos",
  "The permission request": "judgesui.evPermission",
};

/** `EFFECT_LABELS` values, reused so an effect reads exactly as it does elsewhere. */
const EFFECT_KEYS: Record<string, Key> = {
  "Timeline marker": "judgesui.dispMarkLabel",
  "Needs-attention marker": "judgesui.dispAttentionLabel",
  "Suggest a follow-up": "judgesui.dispFollowLabel",
  "Send a message": "judgesui.actSendLabel",
  "Merge the isolated work": "judgesui.actMergeLabel",
  "Approve the request": "judgesui.actApproveLabel",
  "Deny the request": "judgesui.actDenyLabel",
  "Change Auto-Approve": "judgesui.actApprovalLabel",
  "Switch model": "judgesui.actRouteLabel",
};

/**
 * `Choose the answer that makes the judge ${label.toLowerCase()}` reads
 * differently per language, so each action owns its whole sentence.
 */
const ACTION_KEYS: Record<string, Key> = {
  "send a message": "judgesui.validation.chooseAnswerSend",
  "merge the isolated work": "judgesui.validation.chooseAnswerMerge",
  "approve the request": "judgesui.validation.chooseAnswerApprove",
  "deny the request": "judgesui.validation.chooseAnswerDeny",
  "change auto-approve": "judgesui.validation.chooseAnswerApproval",
};

/** Messages with no dynamic parts, matched exactly. */
const EXACT_KEYS: Record<string, Key> = {
  "Invalid judge": "judgesui.validation.invalidJudge",
  "Enabled must be true or false": "judgesui.validation.enabledBoolean",
  "Unknown trigger": "judgesui.validation.unknownTrigger",
  "Invalid filters": "judgesui.validation.invalidFilters",
  "Invalid project filter": "judgesui.validation.invalidProjectFilter",
  "Choose at least one piece of evidence": "judgesui.validation.chooseEvidence",
  "Invalid evidence": "judgesui.validation.invalidEvidence",
  "Unknown or repeated evidence": "judgesui.validation.unknownOrRepeatedEvidence",
  "A permission judge must read the permission request": "judgesui.validation.permissionEvidence",
  "Invalid question": "judgesui.validation.invalidQuestion",
  "A limit judge chooses a route": "judgesui.validation.limitRoute",
  "Only a limit judge chooses a route": "judgesui.validation.onlyLimitRoute",
  "Invalid answer": "judgesui.validation.invalidAnswer",
  "Answer names use lowercase letters, digits and _ (up to 32)": "judgesui.validation.answerName",
  "Answer names must be different": "judgesui.validation.answerNamesDiffer",
  "Unknown question type": "judgesui.validation.unknownQuestionType",
  "Invalid fire condition": "judgesui.validation.invalidFire",
  "Only a choice question fires on an answer": "judgesui.validation.choiceFire",
  "Choose which answer fires the judge": "judgesui.validation.chooseFireAnswer",
  "Choose at least one effect": "judgesui.validation.chooseEffect",
  "Unknown effect": "judgesui.validation.unknownEffect",
  "Only a choice judge ties an action to an answer": "judgesui.validation.actionNeedsChoice",
  "Repeated effect": "judgesui.validation.repeatedEffect",
  "Auto-Approve level must be on, all or off": "judgesui.validation.approvalLevel",
  "An answer cannot both allow and deny the request": "judgesui.validation.answerAllowDeny",
  "A judge cannot both allow and deny the request; use a choice to tie each to its own answer": "judgesui.validation.judgeAllowDeny",
  "A limit judge switches the model": "judgesui.validation.limitSwitch",
  "Invalid model route": "judgesui.validation.invalidRoute",
  "Repeated model route": "judgesui.validation.repeatedRoute",
  "Only a limit judge has models to switch to": "judgesui.validation.onlyLimitRoutes",
  "Invalid model": "judgesui.validation.invalidModel",
};

/**
 * The person's version of one validation message, or the original text when
 * this module does not recognise it.
 */
export function judgeErrorMessage(message: string, translate: Translate = tr): string {
  const exact = EXACT_KEYS[message];
  if (exact) return translate(exact);

  let match = /^Evidence length must be (\d+)–(\d+) characters$/.exec(message);
  if (match) return translate("judgesui.validation.evidenceLength", { min: Number(match[1]), max: Number(match[2]) });

  match = /^A choice needs (\d+)–(\d+) answers$/.exec(message);
  if (match) return translate("judgesui.validation.choiceAnswers", { min: Number(match[1]), max: Number(match[2]) });

  match = /^A score needs (\d+)–(\d+) levels$/.exec(message);
  if (match) return translate("judgesui.validation.scoreLevels", { min: Number(match[1]), max: Number(match[2]) });

  match = /^Allow 1–(\d+) models to switch to$/.exec(message);
  if (match) return translate("judgesui.validation.routesRange", { max: Number(match[1]) });

  match = /^Messages in a row must be (\d+)–(\d+)$/.exec(message);
  if (match) return translate("judgesui.validation.messagesRange", { min: Number(match[1]), max: Number(match[2]) });

  match = /^Daily limit must be 1–(\d+)$/.exec(message);
  if (match) return translate("judgesui.validation.dailyRange", { max: Number(match[1]) });

  match = /^(.+) must be 1–(\d+) characters$/.exec(message);
  if (match) {
    const field = FIELD_KEYS[match[1]!];
    if (field) return translate("judgesui.validation.textRange", { field: translate(field), max: Number(match[2]) });
  }

  match = /^(.+) must be between 0 and 1$/.exec(message);
  if (match) {
    const field = FIELD_KEYS[match[1]!];
    if (field) return translate("judgesui.validation.probabilityRange", { field: translate(field) });
  }

  match = /^(.+): unknown field (.+)$/.exec(message);
  if (match) {
    const field = GROUP_KEYS[match[1]!];
    if (field) return translate("judgesui.validation.unknownField", { field: translate(field), name: match[2]! });
  }

  match = /^(.+) is not available for this trigger$/.exec(message);
  if (match) {
    const label = match[1]!;
    const evidence = EVIDENCE_KEYS[label];
    if (evidence) return translate("judgesui.validation.evidenceUnavailable", { evidence: translate(evidence) });
    const effect = EFFECT_KEYS[label];
    if (effect) return translate("judgesui.validation.effectUnavailable", { effect: translate(effect) });
  }

  match = /^Choose the answer that makes the judge (.+)$/.exec(message);
  if (match) {
    const key = ACTION_KEYS[match[1]!.toLowerCase()];
    if (key) return translate(key);
  }

  return message;
}
