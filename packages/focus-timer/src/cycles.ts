// Cycles: the person's own sequences of timed steps. A step has a name, a
// length, a kind (focus counts toward today's tally and follows "start focus
// on its own"; a break follows "start breaks on their own") and a colour. The
// steps run in order and start over after the last one. A few ready-made
// cycles ship built in (classic pomodoro, 52/17, ...); the person's own are
// saved in their settings. Pure data and functions: no DOM, no i18n.

/** Longest name, in characters (code points, so an emoji is one). */
export const LABEL_MAX = 40;

/** One line, no control characters, at most LABEL_MAX characters. */
export function normalizeLabel(value: unknown): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const line = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(line).slice(0, LABEL_MAX).join("").trim();
}

export const STEP_KINDS = ["focus", "break"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** Colours a step can wear; each maps to a host colour token (styles.css). */
export const STEP_COLORS = ["accent", "red", "amber", "green", "teal", "blue", "purple", "pink"] as const;
export type StepColor = (typeof STEP_COLORS)[number];

/** Built-in step names, translated on screen; a step the person named shows
 *  its own name instead. */
export const STEP_PRESETS = ["focus", "short", "long", "break", "stand", "sit"] as const;
export type StepPreset = (typeof STEP_PRESETS)[number];

/** The ready-made cycles. Their ids are `builtin:<preset>`. */
export const CYCLE_PRESETS = ["pomodoro", "52-17", "50-10", "90-20", "sit-stand"] as const;
export type CyclePreset = (typeof CYCLE_PRESETS)[number];

export interface CycleStep {
  /** The person's name; "" shows the preset's or the kind's built-in name. */
  name: string;
  preset?: StepPreset;
  minutes: number;
  kind: StepKind;
  color: StepColor;
}

export interface CycleSet {
  id: string;
  /** The person's name; "" shows a name built from `preset` or "My cycle". */
  name: string;
  /** Ready-made cycle this one is (or was copied from). */
  preset?: CyclePreset;
  steps: CycleStep[];
}

export const STEP_MINUTES = Object.freeze({ min: 1, max: 240 });
export const MAX_STEPS = 16;
export const MAX_CYCLES = 24;
export const BUILTIN_PREFIX = "builtin:";
export const DEFAULT_CYCLE_ID = `${BUILTIN_PREFIX}pomodoro`;

const step = (preset: StepPreset, minutes: number, kind: StepKind, color: StepColor): CycleStep =>
  ({ name: "", preset, minutes, kind, color });

/** Focus and short breaks `rounds` times, the last break a long one. */
export function classicSteps(
  focusMin: number,
  shortMin: number,
  longMin: number,
  rounds: number,
  names: { focus?: string; short?: string; long?: string } = {},
): CycleStep[] {
  const focus = { ...step("focus", focusMin, "focus", "accent"), name: names.focus ?? "" };
  const short = { ...step("short", shortMin, "break", "green"), name: names.short ?? "" };
  const long = { ...step("long", longMin, "break", "blue"), name: names.long ?? "" };
  const steps: CycleStep[] = [];
  for (let round = 1; round <= rounds; round += 1) steps.push({ ...focus }, round === rounds ? { ...long } : { ...short });
  return steps.slice(0, MAX_STEPS);
}

export const BUILTIN_CYCLES: readonly CycleSet[] = Object.freeze([
  { id: `${BUILTIN_PREFIX}pomodoro`, name: "", preset: "pomodoro", steps: classicSteps(25, 5, 15, 4) },
  { id: `${BUILTIN_PREFIX}52-17`, name: "", preset: "52-17", steps: [step("focus", 52, "focus", "accent"), step("break", 17, "break", "green")] },
  { id: `${BUILTIN_PREFIX}50-10`, name: "", preset: "50-10", steps: [step("focus", 50, "focus", "accent"), step("break", 10, "break", "green")] },
  { id: `${BUILTIN_PREFIX}90-20`, name: "", preset: "90-20", steps: [step("focus", 90, "focus", "purple"), step("break", 20, "break", "teal")] },
  { id: `${BUILTIN_PREFIX}sit-stand`, name: "", preset: "sit-stand", steps: [step("sit", 40, "focus", "blue"), step("stand", 20, "focus", "amber")] },
].map((cycle) => Object.freeze({ ...cycle, steps: cycle.steps.map((item) => Object.freeze(item)) })) as CycleSet[]);

export function isBuiltinCycle(id: string): boolean {
  return id.startsWith(BUILTIN_PREFIX);
}

/** The cycle with `id` among the person's own and the built-in ones, else
 *  the classic pomodoro. */
export function findCycle(own: readonly CycleSet[], id: string): CycleSet {
  return (isBuiltinCycle(id) ? BUILTIN_CYCLES : own).find((cycle) => cycle.id === id) ?? BUILTIN_CYCLES[0]!;
}

export function cycleExists(own: readonly CycleSet[], id: string): boolean {
  return (isBuiltinCycle(id) ? BUILTIN_CYCLES : own).some((cycle) => cycle.id === id);
}

export function clampMinutes(value: number): number {
  if (!Number.isFinite(value)) return 25;
  return Math.min(STEP_MINUTES.max, Math.max(STEP_MINUTES.min, Math.round(value)));
}

const record = (raw: unknown): Record<string, unknown> | null =>
  raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;

export function parseStep(raw: unknown): CycleStep | null {
  const value = record(raw);
  if (!value || typeof value.minutes !== "number") return null;
  const kind = STEP_KINDS.includes(value.kind as StepKind) ? value.kind as StepKind : "focus";
  const parsed: CycleStep = {
    name: normalizeLabel(value.name),
    minutes: clampMinutes(value.minutes),
    kind,
    color: STEP_COLORS.includes(value.color as StepColor) ? value.color as StepColor : kind === "focus" ? "accent" : "green",
  };
  if (STEP_PRESETS.includes(value.preset as StepPreset)) parsed.preset = value.preset as StepPreset;
  return parsed;
}

const ID_PATTERN = /^[a-z0-9-]{1,40}$/;

export function parseCycle(raw: unknown): CycleSet | null {
  const value = record(raw);
  if (!value || typeof value.id !== "string" || !ID_PATTERN.test(value.id) || !Array.isArray(value.steps)) return null;
  const steps = value.steps.map(parseStep).filter((item): item is CycleStep => item !== null).slice(0, MAX_STEPS);
  if (steps.length === 0) return null;
  const parsed: CycleSet = { id: value.id, name: normalizeLabel(value.name), steps };
  if (CYCLE_PRESETS.includes(value.preset as CyclePreset)) parsed.preset = value.preset as CyclePreset;
  return parsed;
}

/** The person's own cycles: valid ones only, unique ids, at most MAX_CYCLES. */
export function parseCycles(raw: unknown): CycleSet[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const cycles: CycleSet[] = [];
  for (const item of raw) {
    const cycle = parseCycle(item);
    if (!cycle || seen.has(cycle.id)) continue;
    seen.add(cycle.id);
    cycles.push(cycle);
    if (cycles.length >= MAX_CYCLES) break;
  }
  return cycles;
}

/** A fresh id for an own cycle, unique among `own`. */
export function newCycleId(own: readonly CycleSet[], random: () => number = Math.random): string {
  for (;;) {
    const id = `c-${Math.floor(random() * 36 ** 8).toString(36).padStart(8, "0")}`;
    if (!own.some((cycle) => cycle.id === id)) return id;
  }
}

const sameStep = (a: CycleStep, b: CycleStep): boolean =>
  a.name === b.name && a.preset === b.preset && a.minutes === b.minutes && a.kind === b.kind && a.color === b.color;

export function sameCycle(a: CycleSet, b: CycleSet): boolean {
  return a.id === b.id && a.name === b.name && a.preset === b.preset
    && a.steps.length === b.steps.length && a.steps.every((item, index) => sameStep(item, b.steps[index]!));
}

export function sameCycles(a: readonly CycleSet[], b: readonly CycleSet[]): boolean {
  return a.length === b.length && a.every((cycle, index) => sameCycle(cycle, b[index]!));
}

/** A step to append after `after`: the other kind than it, so adding steps
 *  alternates focus and breaks. */
export function newStep(after: CycleStep | undefined): CycleStep {
  if (!after || after.kind === "break") return { name: "", minutes: 25, kind: "focus", color: "accent" };
  return { name: "", minutes: 5, kind: "break", color: "green" };
}

/** A structural edit of a cycle and where each old step index went. */
export interface CycleEdit {
  cycle: CycleSet;
  /** Old step index → new step index. */
  map?: (index: number) => number;
}

const at = (steps: readonly CycleStep[], index: number): number => Math.min(Math.max(0, index), steps.length - 1);

export function updateStep(cycle: CycleSet, index: number, patch: Partial<CycleStep>): CycleEdit {
  const target = cycle.steps[index];
  if (!target) return { cycle };
  const next: CycleStep = { ...target, ...patch };
  if (patch.name !== undefined) next.name = normalizeLabel(patch.name);
  if (patch.minutes !== undefined) next.minutes = clampMinutes(patch.minutes);
  return { cycle: { ...cycle, steps: cycle.steps.map((item, i) => i === index ? next : item) } };
}

export function insertStep(cycle: CycleSet, index: number, added: CycleStep): CycleEdit {
  if (cycle.steps.length >= MAX_STEPS) return { cycle };
  const where = Math.min(Math.max(0, index), cycle.steps.length);
  const steps = [...cycle.steps.slice(0, where), added, ...cycle.steps.slice(where)];
  return { cycle: { ...cycle, steps }, map: (old) => old >= where ? old + 1 : old };
}

export function removeStep(cycle: CycleSet, index: number): CycleEdit {
  if (cycle.steps.length <= 1 || !cycle.steps[index]) return { cycle };
  const steps = cycle.steps.filter((_, i) => i !== index);
  return { cycle: { ...cycle, steps }, map: (old) => at(steps, old > index ? old - 1 : old) };
}

export function moveStep(cycle: CycleSet, from: number, to: number): CycleEdit {
  if (!cycle.steps[from] || to < 0 || to >= cycle.steps.length || from === to) return { cycle };
  const steps = [...cycle.steps];
  const moved = steps.splice(from, 1)[0]!;
  steps.splice(to, 0, moved);
  return {
    cycle: { ...cycle, steps },
    map: (old) => {
      if (old === from) return to;
      if (from < to && old > from && old <= to) return old - 1;
      if (from > to && old >= to && old < from) return old + 1;
      return old;
    },
  };
}
