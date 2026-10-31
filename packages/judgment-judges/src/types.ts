// Browser-safe vocabulary of the Judges package: the user-defined judge
// shape, its validation, and the `judgment/assessment` event payload shared by
// the server and the timeline marker. No Node, network or secret access.

/** Canonical ignorable session event every judge records when it fires. */
export const ASSESSMENT_EVENT = "judgment/assessment";
/**
 * Ignorable event a permission judge that decides on requests (it can approve
 * or deny them) records about the waiting request it answered, fired or not.
 * The request's card shows it; the timeline does not.
 */
export const REQUEST_VERDICT_EVENT = "judgment/request-judged";
/**
 * Ignorable event such a judge records when it starts on a waiting request,
 * and again when its call gets no answer, so the card can say it is checking.
 * Its verdict, a later event, ends the check.
 */
export const REQUEST_CHECK_EVENT = "judgment/request-check";
/**
 * A check with nothing after it for this long was cut short (a restart, the
 * package turned off): the card stops saying the judge is checking. Above
 * Judgment's longest call with its retry.
 */
export const REQUEST_CHECK_STALE_MS = 5 * 60_000;
export const PACKAGE_ID = "judgment-judges";
/** Fixed hidden prompt of the keep-warm use; its turn is never judged as work. */
export const KEEP_ALIVE_PROMPT =
  "Automatic keep-alive from Polyth to keep this conversation's prompt cache warm. Do nothing; reply with just: OK";

/** When a judge asks its question. */
export const TRIGGERS = ["turn-completed", "permission-requested", "limit-reached"] as const;
export type JudgeTrigger = (typeof TRIGGERS)[number];

/** Evidence a user-defined judge may read; nothing outside this set reaches Judgment. */
export const EVIDENCE_PICKS = ["last-request", "last-answer", "commands-run", "changed-files", "open-todos", "permission-request"] as const;
export type EvidencePick = (typeof EVIDENCE_PICKS)[number];
export const EVIDENCE_LABELS: Record<EvidencePick, string> = {
  "last-request": "Last request",
  "last-answer": "Last answer",
  "commands-run": "Commands run",
  "changed-files": "Changed files",
  "open-todos": "Open todos",
  "permission-request": "The permission request",
};
/** The evidence each trigger can supply. A permission judge always reads the request it decides on. */
export const TRIGGER_EVIDENCE: Record<JudgeTrigger, readonly EvidencePick[]> = {
  "turn-completed": ["last-request", "last-answer", "commands-run", "changed-files", "open-todos"],
  "permission-requested": ["permission-request", "last-request", "last-answer", "commands-run", "changed-files", "open-todos"],
  "limit-reached": ["last-request", "last-answer", "open-todos"],
};
export const EVIDENCE_CHARS = { min: 100, max: 4_000, default: 1_200 } as const;

/** What a judge can show: a marker, a highlighted marker, a composer suggestion. */
export const DISPLAY_EFFECTS = ["timeline-marker", "needs-attention", "suggest-follow-up"] as const;
/**
 * What a judge can do, only when the person who saves it chooses so. Each runs
 * through that person's own session access, exactly as if they pressed the
 * button: nothing here reaches a chat, setting or approval they could not.
 */
export const ACTION_EFFECTS = ["send-message", "merge-isolated", "approve-request", "deny-request", "set-approval", "switch-route"] as const;
/** The complete effect allowlist. Anything else is rejected. */
export const EFFECT_KINDS = [...DISPLAY_EFFECTS, ...ACTION_EFFECTS] as const;
export type DisplayEffectKind = (typeof DISPLAY_EFFECTS)[number];
export type ActionKind = (typeof ACTION_EFFECTS)[number];
export type EffectKind = DisplayEffectKind | ActionKind;
export const EFFECT_LABELS: Record<EffectKind, string> = {
  "timeline-marker": "Timeline marker",
  "needs-attention": "Needs-attention marker",
  "suggest-follow-up": "Suggest a follow-up",
  "send-message": "Send a message",
  "merge-isolated": "Merge the isolated work",
  "approve-request": "Approve the request",
  "deny-request": "Deny the request",
  "set-approval": "Change Auto-Approve",
  "switch-route": "Switch model",
};
/** The effects each trigger can have. */
export const TRIGGER_EFFECTS: Record<JudgeTrigger, readonly EffectKind[]> = {
  "turn-completed": ["timeline-marker", "needs-attention", "suggest-follow-up", "send-message", "merge-isolated", "set-approval"],
  "permission-requested": ["timeline-marker", "needs-attention", "approve-request", "deny-request", "set-approval"],
  "limit-reached": ["timeline-marker", "needs-attention", "switch-route"],
};
export const isAction = (kind: EffectKind): kind is ActionKind => (ACTION_EFFECTS as readonly string[]).includes(kind);

/** A session's own Auto-Approve choice: routine actions, everything (Full access), or none. */
export type ApprovalLevel = "on" | "all" | "off";
export const APPROVAL_LEVELS: readonly ApprovalLevel[] = ["on", "all", "off"];

/**
 * A choice judge binds each action to one of its answers (`when`); a yes/no
 * or score judge runs its actions when it fires.
 */
export type JudgeEffect =
  | { kind: "timeline-marker" }
  | { kind: "needs-attention" }
  | { kind: "suggest-follow-up"; text: string }
  | { kind: "send-message"; text: string; when?: string }
  | { kind: "merge-isolated"; when?: string }
  | { kind: "approve-request"; when?: string }
  | { kind: "deny-request"; when?: string }
  | { kind: "set-approval"; level: ApprovalLevel; when?: string }
  | { kind: "switch-route" };
export type ActionEffect = Extract<JudgeEffect, { kind: ActionKind }>;

/** Effects that answer the waiting request with Allow: approving it, or Full access, which answers every open card. */
export const approvesRequest = (effect: JudgeEffect): boolean =>
  effect.kind === "approve-request" || (effect.kind === "set-approval" && effect.level === "all");
/** True when a judge decides on permission requests: one of its answers approves or denies them. */
export const decidesRequests = (judge: Pick<JudgeInput, "trigger" | "effects">): boolean => judge.trigger === "permission-requested"
  && judge.effects.some((effect) => approvesRequest(effect) || effect.kind === "deny-request");

/** Ready-made messages a judge can send; the person may also write their own. */
export const MESSAGE_PRESETS = [
  { id: "continue", label: "Continue",
    text: "You have not finished the work yet. Continue from where you stopped and carry it through to the end." },
  { id: "fix-remaining", label: "Fix what is left",
    text: "Fix what is still left: the remaining items, open todos and failing checks you mentioned. Then verify the result." },
  { id: "refine", label: "Refine",
    text: "The work is close but not finished. Refine it: close the gaps and rough edges you can see, then verify it." },
  { id: "audit", label: "Spawn an auditor",
    text: "Spawn a separate agent to validate and audit this work: have it review the changes against the request and run the relevant checks. Then fix what it finds." },
] as const;
export const MESSAGE_MAX = 1_000;
/** Judge messages in a row a chat may receive before a person speaks again. */
export const ROUNDS = { min: 1, max: 20, default: 3 } as const;

export type JudgeQuestion =
  | { type: "noul"; text: string }
  | { type: "choice"; text: string; labels: Array<{ label: string; description: string }> }
  | { type: "score"; text: string; rubric: string[] }
  /** Limit judges: the person's instructions; the answers are generated from `routes`. */
  | { type: "route"; text: string };

/**
 * When a judge fires. Yes/no: P(yes) ≥ threshold and P(yes) − P(no) ≥ margin.
 * Choice: the top answer with P ≥ threshold and P − best other ≥ margin; its
 * actions run, and the display effects when it is `label`.
 * Score: score / (levels − 1) ≥ threshold; margin is not used.
 * Route: the top answer as for a choice; a route answer switches to it.
 */
export interface JudgeFire { label?: string; threshold: number; margin: number }

export interface JudgeInput {
  name: string;
  enabled: boolean;
  trigger: JudgeTrigger;
  /** `projectId` narrows to one project. Only limit and permission judges see delegated child sessions. */
  filters: { projectId?: string };
  evidence: Array<{ pick: EvidencePick; maxChars: number }>;
  question: JudgeQuestion;
  fire: JudgeFire;
  effects: JudgeEffect[];
  /** Limit judges: the `harness::provider/model` routes it may switch to, in the person's order. */
  routes?: string[];
  /** Judge messages in a row a chat may receive before its person writes again. */
  maxRounds?: number;
  /** The `harness::provider/model` that answers. Absent: the owner's Small Model. */
  model?: string;
  /** Judgment calls per UTC day, backtests included. */
  dailyCap: number;
}
export interface JudgeDefinition extends JudgeInput {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** The person who last saved the judge. Its actions run as them; set by the server, never from input. */
  ownerUserId?: string;
}

/** Why the judge's last call today got no answer; cleared by its next answer. */
export interface JudgeFailure { reason: string; at: number }
export interface JudgeUsage { day: string; count: number; failure?: JudgeFailure }
export interface JudgesSnapshot {
  revision: number;
  judges: JudgeDefinition[];
  /** Today's calls per judge id. */
  usage: Record<string, JudgeUsage>;
  /** False when the Judgment package is not running: judges are kept but cannot ask. */
  judgmentAvailable: boolean;
  /** The signed-in person reading the list, so the page can say whose access a judge acts with. */
  viewer?: string;
}

/** A route a limit judge may be allowed to switch to, as the person's model shortlist shows it. */
export interface JudgeRouteOption {
  key: string;
  harnessId: string;
  providerID: string;
  modelID: string;
  /** What an alias runs now (`Claude Opus 5.5` for `opus`). */
  runs?: string;
  favorite: boolean;
  available: boolean;
  /** Worst metered window, 0..1; absent when unknown. */
  quotaUsed?: number;
  blocked: boolean;
  blockedUntil?: number;
}
export interface JudgeRoutesSnapshot { routes: JudgeRouteOption[]; catalogUnavailable?: boolean }

export interface BacktestRow {
  sessionId: string;
  title: string;
  turnSeq: number;
  label?: string;
  probability?: number;
  wouldFire: boolean;
  /** Actions the answer would have run, in order. */
  wouldDo?: ActionKind[];
  /** Why the row has no answer: a Judgment failure reason or `cap`. */
  skipped?: string;
}
export interface BacktestResult { judgeId: string; rows: BacktestRow[]; usage: JudgeUsage }

/** One action a fired judge ran, or why it did not. */
export interface AssessmentAction {
  kind: ActionKind;
  /** `sending`: the message follows this marker; a failure is recorded after it. */
  status: "done" | "sending" | "skipped" | "failed";
  /** Readable detail: the message, the commit, the route, the level, or why it was skipped. */
  detail?: string;
}

/** Payload of `judgment/assessment`. Evidence is never recorded. */
export interface AssessmentData {
  useId: string;
  scope: string;
  kind: "completion-check" | "needs-you" | "custom";
  /** Short human title of the judge that fired. */
  title: string;
  label: string;
  probability: number;
  probabilities?: Record<string, number>;
  margin?: number;
  /** Raise the session's priority for the person. */
  attention?: boolean;
  /** Text offered as a button that only fills the composer; never sent automatically. */
  followUp?: string;
  judgeId?: string;
  trigger?: JudgeTrigger;
  /** What the judge did about the answer. Absent for a marker-only judge. */
  actions?: AssessmentAction[];
  ts: number;
}

/**
 * Where a permission judge's answer leaves the request. Confident in an answer
 * it acts on, the judge `approve`s or `deny`s the request. Confident in
 * another answer, it only advises: `against` approving for a judge that can
 * approve, `clear` (no objection) for one that can only deny. A close call or
 * a chance under the threshold is `unsure`. Only `approve` and `deny` act; the
 * others leave the request to its person.
 */
export type RequestVerdictKind = "approve" | "deny" | "unsure" | "against" | "clear";
export type ActionSkipReason = "space-never-approves" | "acts-for-no-one";
export const REQUEST_VERDICTS: readonly RequestVerdictKind[] = ["approve", "deny", "unsure", "against", "clear"];

/** Payload of `judgment/request-judged`. Evidence is never recorded. */
export interface RequestVerdictData {
  judgeId: string;
  /** The judge's name. */
  title: string;
  requestId: string;
  /** A parent's copy of a delegated child's verdict: the child that asked. */
  sourceSessionId?: string;
  verdict: RequestVerdictKind;
  /**
   * The judge's chance that the request is safe, 0..1: the probability of the
   * answers that approve it, or for a judge that can only deny, of every
   * answer but the ones that deny it.
   */
  safety: number;
  /** The judge's own top answer and its chance. */
  label: string;
  probability: number;
  /**
   * An approving or denying verdict whose action did not go through (a card
   * still waits), and why: `reason` for the skips a card names in the
   * person's language.
   */
  action?: { kind: "approve-request" | "deny-request" | "set-approval"; status: "skipped" | "failed"; detail?: string; reason?: ActionSkipReason };
  ts: number;
}

/**
 * Payload of `judgment/request-check`: `checking` when a deciding judge starts
 * on a waiting request, `no-answer` when that call got none (`reason` is
 * Judgment's failure code). A verdict for the same judge and request ends it.
 */
export interface RequestCheckData {
  judgeId: string;
  title: string;
  requestId: string;
  sourceSessionId?: string;
  state: "checking" | "no-answer";
  reason?: string;
  ts: number;
}

export const DEFAULT_DAILY_CAP = 40;
export const MAX_DAILY_CAP = 1_000;
export const MAX_JUDGES = 32;
export const MAX_BACKTEST = 25;
export const FOLLOW_UP_MAX = 500;
export const MAX_ROUTES = 8;

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const LABEL = /^[a-z][a-z0-9_]{0,31}$/;
/** `harness::provider/model`; the model id itself may contain `/`. */
const ROUTE_KEY = /^([a-z][a-z0-9-]{0,63})::([^\s/:]{1,100})\/([^\s\0-\x1f]{1,200})$/;
export const safeId = (value: unknown): value is string => typeof value === "string" && SAFE_ID.test(value)
  && !["__proto__", "prototype", "constructor"].includes(value);
/** Ids generated by the server: `j` + 12 lowercase hex characters. */
export const JUDGE_ID = /^j[0-9a-f]{12}$/;

export function parseRouteKey(key: string): { harnessId: string; providerID: string; modelID: string } | undefined {
  const match = ROUTE_KEY.exec(key);
  return match ? { harnessId: match[1]!, providerID: match[2]!, modelID: match[3]! } : undefined;
}
export const routeKey = (route: { harnessId: string; providerID: string; modelID: string }) => `${route.harnessId}::${route.providerID}/${route.modelID}`;

const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid-input" });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[], what: string) => {
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra) throw invalid(`${what}: unknown field ${extra}`);
};
const text = (value: unknown, max: number, what: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw invalid(`${what} must be 1–${max} characters`);
  return value.trim();
};
const probability = (value: unknown, what: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw invalid(`${what} must be between 0 and 1`);
  return value;
};

/** Validates and normalizes a judge from untrusted input; throws `invalid-input` with a readable message. */
export function validateJudgeInput(value: unknown): JudgeInput {
  if (!record(value)) throw invalid("Invalid judge");
  onlyKeys(value, ["name", "enabled", "trigger", "filters", "evidence", "question", "fire", "effects", "routes", "maxRounds", "model", "dailyCap"], "Judge");
  const name = text(value.name, 80, "Name");
  if (typeof value.enabled !== "boolean") throw invalid("Enabled must be true or false");
  if (!TRIGGERS.includes(value.trigger as JudgeTrigger)) throw invalid("Unknown trigger");
  const trigger = value.trigger as JudgeTrigger;
  const filters = value.filters ?? {};
  if (!record(filters)) throw invalid("Invalid filters");
  onlyKeys(filters, ["projectId"], "Filters");
  if (filters.projectId !== undefined && !safeIdOrUuid(filters.projectId)) throw invalid("Invalid project filter");

  // A limit judge always reads the route facts; the picks only add context.
  const minPicks = trigger === "limit-reached" ? 0 : 1;
  const allowedPicks = TRIGGER_EVIDENCE[trigger];
  if (!Array.isArray(value.evidence) || value.evidence.length < minPicks || value.evidence.length > allowedPicks.length) throw invalid("Choose at least one piece of evidence");
  const seen = new Set<string>();
  const evidence = value.evidence.map((entry) => {
    if (!record(entry)) throw invalid("Invalid evidence");
    onlyKeys(entry, ["pick", "maxChars"], "Evidence");
    if (!EVIDENCE_PICKS.includes(entry.pick as EvidencePick) || seen.has(entry.pick as string)) throw invalid("Unknown or repeated evidence");
    if (!allowedPicks.includes(entry.pick as EvidencePick)) throw invalid(`${EVIDENCE_LABELS[entry.pick as EvidencePick]} is not available for this trigger`);
    seen.add(entry.pick as string);
    if (!Number.isSafeInteger(entry.maxChars) || (entry.maxChars as number) < EVIDENCE_CHARS.min || (entry.maxChars as number) > EVIDENCE_CHARS.max) {
      throw invalid(`Evidence length must be ${EVIDENCE_CHARS.min}–${EVIDENCE_CHARS.max} characters`);
    }
    return { pick: entry.pick as EvidencePick, maxChars: entry.maxChars as number };
  });
  if (trigger === "permission-requested" && !seen.has("permission-request")) throw invalid("A permission judge must read the permission request");

  if (!record(value.question)) throw invalid("Invalid question");
  const q = value.question;
  let question: JudgeQuestion;
  if ((q.type === "route") !== (trigger === "limit-reached")) throw invalid(trigger === "limit-reached" ? "A limit judge chooses a route" : "Only a limit judge chooses a route");
  if (q.type === "noul") {
    onlyKeys(q, ["type", "text"], "Question");
    question = { type: "noul", text: text(q.text, 600, "Question") };
  } else if (q.type === "choice") {
    onlyKeys(q, ["type", "text", "labels"], "Question");
    if (!Array.isArray(q.labels) || q.labels.length < 2 || q.labels.length > 8) throw invalid("A choice needs 2–8 answers");
    const labels = q.labels.map((entry) => {
      if (!record(entry)) throw invalid("Invalid answer");
      onlyKeys(entry, ["label", "description"], "Answer");
      if (typeof entry.label !== "string" || !LABEL.test(entry.label)) throw invalid("Answer names use lowercase letters, digits and _ (up to 32)");
      return { label: entry.label, description: text(entry.description, 300, "Answer description") };
    });
    if (new Set(labels.map((entry) => entry.label)).size !== labels.length) throw invalid("Answer names must be different");
    question = { type: "choice", text: text(q.text, 600, "Question"), labels };
  } else if (q.type === "score") {
    onlyKeys(q, ["type", "text", "rubric"], "Question");
    if (!Array.isArray(q.rubric) || q.rubric.length < 2 || q.rubric.length > 8) throw invalid("A score needs 2–8 levels");
    question = { type: "score", text: text(q.text, 600, "Question"), rubric: q.rubric.map((level) => text(level, 300, "Score level")) };
  } else if (q.type === "route") {
    onlyKeys(q, ["type", "text"], "Question");
    question = { type: "route", text: text(q.text, 600, "Instructions") };
  } else throw invalid("Unknown question type");
  const answers = question.type === "choice" ? question.labels.map((entry) => entry.label) : [];

  const rawFire = value.fire;
  if (!record(rawFire)) throw invalid("Invalid fire condition");
  onlyKeys(rawFire, ["label", "threshold", "margin"], "Fire condition");
  const fire: JudgeFire = { threshold: probability(rawFire.threshold, "Threshold"), margin: probability(rawFire.margin, "Margin") };
  if (rawFire.label !== undefined) {
    if (question.type !== "choice") throw invalid("Only a choice question fires on an answer");
    if (!answers.includes(rawFire.label as string)) throw invalid("Choose which answer fires the judge");
    fire.label = rawFire.label as string;
  }

  const allowedEffects = TRIGGER_EFFECTS[trigger];
  if (!Array.isArray(value.effects) || value.effects.length < 1 || value.effects.length > 24) throw invalid("Choose at least one effect");
  const keys = new Set<string>();
  const effects = value.effects.map((entry): JudgeEffect => {
    if (!record(entry) || !EFFECT_KINDS.includes(entry.kind as EffectKind)) throw invalid("Unknown effect");
    const kind = entry.kind as EffectKind;
    if (!allowedEffects.includes(kind)) throw invalid(`${EFFECT_LABELS[kind]} is not available for this trigger`);
    // A choice judge's actions each belong to one answer; elsewhere an action runs when the judge fires.
    let when: string | undefined;
    if (isAction(kind) && kind !== "switch-route" && question.type === "choice") {
      if (!answers.includes(entry.when as string)) throw invalid(`Choose the answer that makes the judge ${EFFECT_LABELS[kind].toLowerCase()}`);
      when = entry.when as string;
    } else if (entry.when !== undefined) throw invalid("Only a choice judge ties an action to an answer");
    const key = `${kind}\0${when ?? ""}`;
    if (keys.has(key)) throw invalid("Repeated effect");
    keys.add(key);
    const at = when !== undefined ? { when } : {};
    switch (kind) {
      case "suggest-follow-up":
        onlyKeys(entry, ["kind", "text"], "Effect");
        return { kind, text: text(entry.text, FOLLOW_UP_MAX, "Follow-up text") };
      case "send-message":
        onlyKeys(entry, ["kind", "text", "when"], "Effect");
        return { kind, text: text(entry.text, MESSAGE_MAX, "Message"), ...at };
      case "set-approval":
        onlyKeys(entry, ["kind", "level", "when"], "Effect");
        if (!APPROVAL_LEVELS.includes(entry.level as ApprovalLevel)) throw invalid("Auto-Approve level must be on, all or off");
        return { kind, level: entry.level as ApprovalLevel, ...at };
      case "merge-isolated":
      case "approve-request":
      case "deny-request":
        onlyKeys(entry, ["kind", "when"], "Effect");
        return { kind, ...at };
      default:
        onlyKeys(entry, ["kind"], "Effect");
        return { kind } as JudgeEffect;
    }
  });
  // On a choice, markers and suggestions belong to the answer the judge fires on.
  if (question.type === "choice" && effects.some((effect) => !isAction(effect.kind)) && fire.label === undefined) throw invalid("Choose which answer fires the judge");
  // One answer (a yes/no or score judge has one: when it fires) either lets the request through or denies it.
  const answering = (effect: JudgeEffect) => (effect as { when?: string }).when ?? "";
  const allowsOn = new Set(effects.filter(approvesRequest).map(answering));
  if (effects.some((effect) => effect.kind === "deny-request" && allowsOn.has(answering(effect)))) {
    throw invalid(question.type === "choice" ? "An answer cannot both allow and deny the request" : "A judge cannot both allow and deny the request; use a choice to tie each to its own answer");
  }
  if (trigger === "limit-reached" && !effects.some((effect) => effect.kind === "switch-route")) throw invalid("A limit judge switches the model");

  let routes: string[] | undefined;
  if (trigger === "limit-reached") {
    if (!Array.isArray(value.routes) || value.routes.length < 1 || value.routes.length > MAX_ROUTES) throw invalid(`Allow 1–${MAX_ROUTES} models to switch to`);
    routes = value.routes.map((key) => {
      if (typeof key !== "string" || !parseRouteKey(key)) throw invalid("Invalid model route");
      return key;
    });
    if (new Set(routes).size !== routes.length) throw invalid("Repeated model route");
  } else if (value.routes !== undefined) throw invalid("Only a limit judge has models to switch to");

  if (value.model !== undefined && (typeof value.model !== "string" || !parseRouteKey(value.model))) throw invalid("Invalid model");

  let maxRounds: number | undefined;
  if (value.maxRounds !== undefined) {
    if (!Number.isSafeInteger(value.maxRounds) || (value.maxRounds as number) < ROUNDS.min || (value.maxRounds as number) > ROUNDS.max) {
      throw invalid(`Messages in a row must be ${ROUNDS.min}–${ROUNDS.max}`);
    }
    maxRounds = value.maxRounds as number;
  }

  const dailyCap = value.dailyCap ?? DEFAULT_DAILY_CAP;
  if (!Number.isSafeInteger(dailyCap) || (dailyCap as number) < 1 || (dailyCap as number) > MAX_DAILY_CAP) throw invalid(`Daily limit must be 1–${MAX_DAILY_CAP}`);
  return { name, enabled: value.enabled, trigger,
    filters: filters.projectId !== undefined ? { projectId: filters.projectId as string } : {},
    evidence, question, fire, effects,
    ...(routes ? { routes } : {}),
    ...(maxRounds !== undefined ? { maxRounds } : {}),
    ...(value.model !== undefined ? { model: value.model as string } : {}),
    dailyCap: dailyCap as number };
}

/** True when a judge can do more than mark a chat. */
export const hasActions = (judge: Pick<JudgeInput, "effects">): boolean => judge.effects.some((effect) => isAction(effect.kind));

/** Project ids are canonical ids from the host; accept safe ids and UUIDs. */
export const safeIdOrUuid = (value: unknown): value is string => safeId(value)
  || (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));

export function blankJudge(trigger: JudgeTrigger = "turn-completed"): JudgeInput {
  const base = { name: "", enabled: true, filters: {}, dailyCap: DEFAULT_DAILY_CAP };
  if (trigger === "permission-requested") {
    return { ...base, trigger, evidence: [{ pick: "permission-request", maxChars: 1_200 }, { pick: "last-request", maxChars: 1_200 }],
      question: { type: "choice", text: "Is this action a normal, safe step of what the person asked for?",
        labels: [{ label: "safe", description: "A normal, low-risk step of the requested work." },
          { label: "unsure", description: "It may be fine, but a person should look first." }] },
      fire: { threshold: 0.8, margin: 0.3 }, effects: [{ kind: "approve-request", when: "safe" }] };
  }
  if (trigger === "limit-reached") {
    return { ...base, trigger, evidence: [{ pick: "last-request", maxChars: 600 }],
      question: { type: "route", text: "Switch to an allowed model with headroom when the wait is long; for a short wait, keep waiting." },
      fire: { threshold: 0.6, margin: 0.2 }, effects: [{ kind: "switch-route" }], routes: [] };
  }
  return { ...base, trigger,
    evidence: [{ pick: "last-request", maxChars: 600 }, { pick: "last-answer", maxChars: EVIDENCE_CHARS.default }],
    question: { type: "noul", text: "" }, fire: { threshold: 0.7, margin: 0.2 }, effects: [{ kind: "timeline-marker" }] };
}
