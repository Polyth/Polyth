// Parser for the agent-written ```ui fence: a line-oriented, positional
// format designed for few output tokens. Pure and DOM-free; shared by the
// browser renderer and tests. It never throws: unknown views and malformed
// lines degrade to `invalid` entries so the renderer can show the source.
//
//   cards Headphones under $400 · pick=many
//   - https://…/a.jpg | Sony WH-1000XM6 | ANC · 30 h | $399 | ★4.8 | https://shop/…
//   > Compare selected = Compare these in detail: {sel}
//
// Rows can also come from a project file (`from=_out/data.json`): the
// renderer loads it (see records.ts) and feeds the records through
// `withRecords`, which reuses the same per-view row builders.

export const CHAT_BLOCK_VIEWS = ["cards", "list", "table", "stats", "choice", "chart", "compare", "form", "steps", "media"] as const;
export type ChatBlockView = typeof CHAT_BLOCK_VIEWS[number];

export const CHAT_BLOCK_MAX_ROWS = 200;
export const CHAT_BLOCK_MAX_RECORDS = 5000;
export const CHAT_BLOCK_MAX_FIELDS = 12;
export const CHAT_BLOCK_MAX_ACTIONS = 6;
export const CHAT_BLOCK_MAX_TEXT = 600;
export const CHAT_BLOCK_MAX_SPARK = 64;
export const CHAT_BLOCK_MAX_SERIES = 6;
export const CHAT_BLOCK_MAX_OPTIONS = 24;

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";
const TONES: ReadonlySet<string> = new Set(["neutral", "accent", "success", "warning", "danger", "info"]);

export type StepStatus = "done" | "doing" | "todo" | "fail" | "skip";
export type FormFieldType = "text" | "textarea" | "number" | "select" | "toggle" | "date" | "email" | "url";
export type ChartType = "bar" | "line" | "area" | "donut";

export interface FormField {
  name: string;
  label: string;
  type: FormFieldType;
  value: string;
  options: string[];
  required: boolean;
  /** number/date: inclusive bounds from a `min..max` fifth field. */
  min?: string;
  max?: string;
  /** text/textarea: a `/regex/` fifth field the whole value must match. */
  pattern?: string;
}

/** Something in the fence the renderer had to drop or ignore. `hint` is
 *  written for the agent (it is what "Ask the agent to fix" sends back). */
export type ChatBlockProblemCode =
  | "unknown-view"
  | "bad-row"
  | "bad-button"
  | "bad-source"
  | "unknown-option"
  | "bad-option"
  | "bad-field"
  | "too-many-rows"
  | "too-many-buttons"
  | "too-many-fields";

export interface ChatBlockProblem {
  code: ChatBlockProblemCode;
  /** 1-based line in the fence body; absent for rows read from a file. */
  line?: number;
  /** The offending source text (a line, an option or a count). */
  text: string;
  hint: string;
}

export const CHAT_BLOCK_MAX_PROBLEMS = 20;

/** One `- ` line (or one loaded record), split into the view's roles. */
export interface ChatBlockItem {
  /** Zero-based position among data rows (stable for selection keys). */
  index: number;
  selected: boolean;
  image?: string;
  title: string;
  subtitle?: string;
  value?: string;
  badge?: string;
  tone?: BadgeTone;
  link?: string;
  /** Stable id from an `id=` field (or an `id` record key); a click message
   *  names the item as "Title (#id)" so the agent need not match titles. */
  id?: string;
  /** Raw trimmed fields, for table cells and copy. */
  cells: string[];
  /** stats: parsed sparkline points. */
  spark?: number[];
  /** chart: one number per series (null when a cell is not a number). */
  values?: Array<number | null>;
  /** steps: progress state. */
  status?: StepStatus;
  /** compare: which value wins in this row. */
  best?: "max" | "min";
  /** form: the input this row describes. */
  field?: FormField;
}

export interface ChatBlockAction {
  label: string;
  /** Message sent for this action; `{sel}` expands to the selected titles. */
  message?: string;
}

export type PickMode = "none" | "one" | "many";

export interface ChatBlockDoc {
  view: ChatBlockView;
  title: string;
  options: Readonly<Record<string, string>>;
  pick: PickMode;
  /** table: column headers; compare: compared object names. */
  columns: string[];
  /** compare: optional image per compared object. */
  columnImages: Array<string | undefined>;
  /** chart: series names. */
  series: string[];
  items: ChatBlockItem[];
  actions: ChatBlockAction[];
  /** Free text lines shown as a caption. */
  notes: string[];
  /** Lines that could not be understood (also reported in `problems`). */
  invalid: string[];
  /** Everything dropped or ignored, with a hint for the agent; at most
   *  CHAT_BLOCK_MAX_PROBLEMS entries. */
  problems: ChatBlockProblem[];
  /** True when the trailing line was held back because the fence is still
   *  streaming; the renderer shows a placeholder for it. */
  pending: boolean;
  /** `from=` file whose records replace the inline rows once loaded. */
  source?: string;
  /** Records were loaded from `source` (and maybe cut at the limit). */
  loaded?: { total: number; truncated: boolean };
}

export type ParseResult =
  | { ok: true; doc: ChatBlockDoc }
  | { ok: false; reason: "empty" | "unknown-view"; view?: string };

interface RawRow {
  selected: boolean;
  fields: string[];
  /** The source line, quoted back when the row cannot be used. */
  line?: string;
  /** Its 1-based line number in the fence body. */
  at?: number;
}

const VIEW_SET: ReadonlySet<string> = new Set(CHAT_BLOCK_VIEWS);
// A whole `·` segment may carry spaces in its value (`cols=fixed:Fixed in`);
// options trailing a title are single words.
const OPTION_RE = /^([a-z][a-z-]{0,23})=(\S.{0,159})$/;
const TRAILING_OPTION_RE = /\s+([a-z][a-z-]{0,23})=(\S{1,160})$/;
const ROW_RE = /^\s*(?:[-*•+]|\d{1,3}[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/;
// A bare `>` is a button line with no label (reported), not a caption.
const ACTION_RE = /^\s*>(?:\s+(.*))?$/;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#].*)?$/i;
const SOURCE_EXT_RE = /\.(?:json|jsonl|ndjson|csv|tsv)$/i;

const clamp = (text: string): string => (text.length > CHAT_BLOCK_MAX_TEXT ? `${text.slice(0, CHAT_BLOCK_MAX_TEXT - 1)}…` : text);

const isUrl = (value: string): boolean => /^https?:\/\/\S+$/i.test(value);
/** An image field is an http(s) URL or a project-relative path to an image. */
export const looksLikeImage = (value: string): boolean =>
  isUrl(value)
  || (!/\s/.test(value) && IMAGE_EXT_RE.test(value) && !value.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/i.test(value));

/** A `from=` path: relative, inside the project, a supported data file. */
export const sourcePath = (value: string | undefined): string | null => projectFilePath(value, SOURCE_EXT_RE);

/** A project-relative file path ending in the given extension pattern. */
export function projectFilePath(value: string | undefined, extension: RegExp): string | null {
  if (!value) return null;
  const path = value.trim().replace(/^\.\//, "");
  if (!path || path.length > 240) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("/") || path.startsWith("~") || path.includes("\\")) return null;
  if (path.split("/").some((part) => part === ".." || part === "")) return null;
  return extension.test(path) ? path : null;
}

/** Split a row on `|`, honouring `\|` as a literal bar. */
export function splitFields(body: string): string[] {
  return splitAllFields(body).slice(0, CHAT_BLOCK_MAX_FIELDS).map(clamp);
}

function splitAllFields(body: string): string[] {
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "\\" && body[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (ch === "|") {
      out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current.trim());
  return out;
}

// A row written without its `- ` bullet, or as a Markdown pipe table
// (`| a | b |` with a `|---|---|` rule under the header). Only table blocks
// read these, so a prose caption that happens to contain a bar stays prose
// everywhere else.
const TABLE_RULE_RE = /^:?-{2,}:?$/;

function tableLineFields(line: string): string[] | null {
  if (!line.includes("|")) return null;
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const fields = splitFields(body);
  if (fields.length < 2) return null;
  // The `|---|---|` separator between a Markdown header and its body: skip it.
  if (fields.every((field) => TABLE_RULE_RE.test(field))) return [];
  return fields;
}

function parseHeader(line: string): { view: string; title: string; options: Record<string, string> } {
  const trimmed = line.trim();
  const space = trimmed.search(/\s/);
  const view = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const rest = space < 0 ? "" : trimmed.slice(space + 1);
  const options: Record<string, string> = {};
  const titleParts: string[] = [];
  for (const segment of rest.split(/\s+·\s+|\s+·$|^·\s+/)) {
    let text = segment.trim();
    // Trailing `key=value` words also count, so `cards Title pick=many` works.
    for (let m = TRAILING_OPTION_RE.exec(text); m; m = TRAILING_OPTION_RE.exec(text)) {
      options[m[1]!] ??= m[2]!;
      text = text.slice(0, m.index).trim();
    }
    const whole = OPTION_RE.exec(text);
    if (whole) options[whole[1]!] ??= whole[2]!;
    else if (text) titleParts.push(text);
  }
  return { view, title: clamp(titleParts.join(" · ")), options };
}

function parseTone(value: string | undefined): BadgeTone | undefined {
  return value && TONES.has(value) ? value as BadgeTone : undefined;
}

function parseSpark(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const points = value.split(/[\s,;]+/).filter(Boolean).map((part) => Number(part.replace(/[^\d.+-]/g, "")));
  if (points.length < 2 || points.some((n) => !Number.isFinite(n))) return undefined;
  return points.slice(-CHAT_BLOCK_MAX_SPARK);
}

const ITEM_ID_RE = /^id=([^\s|]{1,80})$/;

/** Pull `key=value` option fields (`tone=success`, `id=h-142`) out of a row. */
function rowOptions(fields: string[]): { fields: string[]; tone?: BadgeTone; id?: string } {
  const kept: string[] = [];
  let tone: BadgeTone | undefined;
  let id: string | undefined;
  for (const field of fields) {
    const m = /^tone=([a-z]+)$/.exec(field);
    const idMatch = ITEM_ID_RE.exec(field);
    if (m) tone = parseTone(m[1]) ?? tone;
    else if (idMatch) id ??= idMatch[1]!;
    else kept.push(field);
  }
  return { fields: kept, ...(tone ? { tone } : {}), ...(id ? { id } : {}) };
}

/** How a click message names an item: its title, plus its id when it has one. */
export function itemLabel(item: Pick<ChatBlockItem, "title" | "id">): string {
  return item.id ? `${item.title} (#${item.id})` : item.title;
}

// ------------------------------------------------------------ row builders

/** cards/list: optional leading image, optional trailing link, then
 *  title · subtitle · value · badge in order. Empty fields keep positions. */
function mediaItem(index: number, selected: boolean, raw: string[]): ChatBlockItem | null {
  const { fields, tone, id } = rowOptions(raw);
  let start = 0;
  let end = fields.length;
  let image: string | undefined;
  let link: string | undefined;
  if (fields.length > 1 && (fields[0] === "" || looksLikeImage(fields[0]!))) {
    image = fields[0] || undefined;
    start = 1;
  }
  if (end - start > 1 && isUrl(fields[end - 1]!)) {
    link = fields[end - 1];
    end -= 1;
  }
  const [title = "", subtitle, value, badge] = fields.slice(start, end);
  if (!title && !image) return null;
  return {
    index,
    selected,
    title,
    cells: raw,
    ...(image ? { image } : {}),
    ...(subtitle ? { subtitle } : {}),
    ...(value ? { value } : {}),
    ...(badge ? { badge } : {}),
    ...(tone ? { tone } : {}),
    ...(link ? { link } : {}),
    ...(id ? { id } : {}),
  };
}

/** media: image | caption | link. */
function galleryItem(index: number, raw: string[]): ChatBlockItem | null {
  const { fields, id } = rowOptions(raw);
  const [image = "", caption = "", link] = fields;
  if (!looksLikeImage(image)) return null;
  return {
    index,
    selected: false,
    image,
    title: caption,
    cells: raw,
    ...(link && isUrl(link) ? { link } : {}),
    ...(id ? { id } : {}),
  };
}

function statItem(index: number, raw: string[]): ChatBlockItem | null {
  const [title = "", value, delta, spark] = raw;
  if (!title) return null;
  const points = parseSpark(spark);
  return {
    index,
    selected: false,
    title,
    cells: raw,
    ...(value ? { value } : {}),
    ...(delta ? { badge: delta } : {}),
    ...(points ? { spark: points } : {}),
  };
}

function choiceItem(index: number, selected: boolean, raw: string[]): ChatBlockItem | null {
  const { fields, id } = rowOptions(raw);
  const [title = "", subtitle] = fields;
  if (!title) return null;
  return { index, selected, title, cells: raw, ...(subtitle ? { subtitle } : {}), ...(id ? { id } : {}) };
}

const STEP_STATUS: Readonly<Record<string, StepStatus>> = {
  done: "done", ok: "done", completed: "done", complete: "done", "✓": "done", "✅": "done",
  doing: "doing", active: "doing", running: "doing", now: "doing", current: "doing", "in_progress": "doing", "▶": "doing", "…": "doing",
  todo: "todo", pending: "todo", next: "todo", later: "todo", "○": "todo",
  fail: "fail", failed: "fail", error: "fail", blocked: "fail", "✗": "fail", "❌": "fail",
  skip: "skip", skipped: "skip", cancelled: "skip", canceled: "skip",
};

/** steps: status | title | detail. A row without a known status is a todo. */
function stepItem(index: number, raw: string[]): ChatBlockItem | null {
  const known = STEP_STATUS[(raw[0] ?? "").toLowerCase()];
  const [title = "", detail] = known ? raw.slice(1) : raw;
  if (!title) return null;
  return { index, selected: false, title, cells: raw, status: known ?? "todo", ...(detail ? { subtitle: detail } : {}) };
}

const FIELD_TYPES: Readonly<Record<string, FormFieldType>> = {
  text: "text", string: "text", tel: "text", phone: "text",
  email: "email", url: "url", link: "url",
  textarea: "textarea", long: "textarea", multiline: "textarea",
  number: "number", int: "number", integer: "number", float: "number",
  select: "select", choice: "select", enum: "select",
  toggle: "toggle", switch: "toggle", bool: "toggle", boolean: "toggle", checkbox: "toggle",
  date: "date",
};
const FIELD_TYPE_NAMES = "text, textarea, number, select, toggle, date, email, url";

const RANGE_RE = /^\s*(\S*?)\s*\.\.\s*(\S*)\s*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PATTERN_RE = /^\/(.{1,200})\/$/;

type Report = (code: ChatBlockProblemCode, text: string, hint: string) => void;

/** A field pattern as an anchored regular expression, or null when it does
 *  not compile. Patterns come from the agent and test only what the user
 *  types into this one field. */
const patterns = new Map<string, RegExp | null>();
function fieldPattern(source: string): RegExp | null {
  let compiled = patterns.get(source);
  if (compiled === undefined) {
    try {
      compiled = new RegExp(`^(?:${source})$`, "u");
    } catch {
      compiled = null;
    }
    if (patterns.size > 200) patterns.clear();
    patterns.set(source, compiled);
  }
  return compiled;
}

/** form: name | label | type | default | options, a `min..max` range
 *  (number, date) or a `/pattern/` (text, textarea). */
function formItem(index: number, raw: string[], report: Report): ChatBlockItem | null {
  const [rawName = "", rawLabel = "", rawType = "", value = "", extra = ""] = raw;
  const name = rawName.trim().slice(0, 60);
  if (!name) return null;
  const required = /\*\s*$/.test(rawLabel || name);
  const label = (rawLabel || name).replace(/\s*\*\s*$/, "");
  const typeName = rawType.trim().toLowerCase();
  const range = RANGE_RE.exec(extra);
  const pattern = PATTERN_RE.exec(extra.trim());
  const options = extra && !range && !pattern
    ? extra.split(extra.includes(",") ? "," : "/").map((option) => option.trim()).filter(Boolean).slice(0, CHAT_BLOCK_MAX_OPTIONS)
    : [];
  if (typeName && !FIELD_TYPES[typeName]) {
    report("bad-field", `${name}: ${rawType.trim()}`, `Field types: ${FIELD_TYPE_NAMES}.`);
  }
  let type = FIELD_TYPES[typeName] ?? (options.length > 0 ? "select" : "text");
  if (type === "select" && options.length === 0) type = "text";
  const field: FormField = { name, label, type, value, options, required };
  if (range && (type === "number" || type === "date")) {
    const valid = (bound: string) => (type === "number" ? Number.isFinite(Number(bound)) : DATE_RE.test(bound));
    const [, min = "", max = ""] = range;
    if ((min && !valid(min)) || (max && !valid(max))) {
      report("bad-field", `${name}: ${extra.trim()}`, type === "number" ? "A number range is min..max, e.g. 1..10, 0.. or ..100." : "A date range is YYYY-MM-DD..YYYY-MM-DD; either side may be empty.");
    } else {
      if (min) field.min = min;
      if (max) field.max = max;
    }
  } else if (pattern && (type === "text" || type === "textarea")) {
    if (fieldPattern(pattern[1]!)) field.pattern = pattern[1]!;
    else report("bad-field", `${name}: ${extra.trim()}`, "The pattern is not a valid JavaScript regular expression.");
  } else if ((range || pattern) && extra.trim()) {
    report("bad-field", `${name}: ${extra.trim()}`, "min..max applies to number and date fields, /pattern/ to text and textarea fields.");
  }
  return { index, selected: false, title: label, cells: raw, field };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Why a form value cannot be sent yet, or null when it can. */
export function fieldError(field: FormField, value: string): "missing" | "invalid" | null {
  const text = value.trim();
  if (field.type === "toggle" || field.type === "select") return field.required && field.type === "select" && !text ? "missing" : null;
  if (!text) return field.required ? "missing" : null;
  switch (field.type) {
    case "email": return EMAIL_RE.test(text) ? null : "invalid";
    case "url": return isUrl(text) ? null : "invalid";
    case "number": {
      const n = Number(text);
      if (!Number.isFinite(n)) return "invalid";
      if (field.min !== undefined && n < Number(field.min)) return "invalid";
      if (field.max !== undefined && n > Number(field.max)) return "invalid";
      return null;
    }
    case "date":
      if (!DATE_RE.test(text)) return "invalid";
      if (field.min !== undefined && text < field.min) return "invalid";
      if (field.max !== undefined && text > field.max) return "invalid";
      return null;
    default: {
      const pattern = field.pattern ? fieldPattern(field.pattern) : null;
      return pattern && !pattern.test(text) ? "invalid" : null;
    }
  }
}

// A number with an optional currency, sign, grouping and a short unit:
// "9,5", "$1,199", "−12%", "18 h", "1.24 kg". Not "{\"a\":1}" or "v2".
const NUMBER_CELL_RE = /^[$€£₴¥]?\s*[-+\u2212]?\d[\d\s.,\u00a0\u202f]*\s*(?:%|[\p{L}$€£₴¥.]{1,6})?$/u;
const isNumeric = (cell: string | undefined): boolean =>
  cell !== undefined && NUMBER_CELL_RE.test(cell.trim()) && numericValue(cell) !== null;

/** What a row of each view looks like, for problem hints. */
export const CHAT_BLOCK_ROW_SIGNATURES: Readonly<Record<ChatBlockView, string>> = {
  cards: "- image | title | subtitle | value | badge | link (a title or an image is required)",
  list: "- image | title | subtitle | value | badge | link (a title or an image is required)",
  table: "- cell | cell | … (the first row is the header unless cols= names the columns)",
  stats: "- label | value | delta | 3,5,4,8 (a label is required)",
  choice: "- label | detail (a label is required)",
  chart: "- label | n1 | n2 … (a label and at least one number)",
  compare: "first row - | A | B, then - Feature ↑ | value | value (a label is required)",
  form: "- name | Label * | type | default | options (a name is required)",
  steps: "- done|doing|todo|fail|skip | title | detail (a title is required)",
  media: "- image | caption | link (the image must be an http(s) URL or a project image path)",
};

const VIEW_OPTIONS: Readonly<Record<ChatBlockView, readonly string[]>> = {
  cards: ["pick", "sort", "ratio", "from", "map", "send"],
  list: ["pick", "sort", "ratio", "from", "map", "send"],
  table: ["cols", "sort", "from", "send"],
  stats: ["from", "map", "send"],
  choice: ["pick", "from", "map", "send"],
  chart: ["type", "series", "unit", "cols", "from", "send"],
  compare: ["pick", "cols", "from", "send"],
  form: ["from", "send"],
  steps: ["from", "map", "send"],
  media: ["pick", "ratio", "from", "map", "send"],
};

const OPTION_VALUES: Readonly<Record<string, { test(value: string): boolean; hint: string }>> = {
  pick: { test: (value) => /^(?:one|single|many|multi|none)$/.test(value), hint: "pick=one or pick=many." },
  send: { test: (value) => value === "draft", hint: "send=draft is the only value." },
  type: { test: (value) => /^(?:bar|line|area|donut|pie)$/.test(value), hint: "type=bar, line, area or donut." },
  ratio: {
    test: (value) => {
      const m = /^(\d{1,2})[:/x](\d{1,2})$/.exec(value);
      return m !== null && Number(m[1]) > 0 && Number(m[2]) > 0;
    },
    hint: "ratio=W:H, e.g. 1:1, 4:3 or 16:9.",
  },
};

function pushProblem(doc: ChatBlockDoc, problem: ChatBlockProblem): void {
  if (doc.problems.length < CHAT_BLOCK_MAX_PROBLEMS) doc.problems.push(problem);
}

function checkOptions(doc: ChatBlockDoc, line: number): void {
  const allowed = VIEW_OPTIONS[doc.view];
  for (const [key, value] of Object.entries(doc.options)) {
    if (!allowed.includes(key)) {
      pushProblem(doc, { code: "unknown-option", line, text: `${key}=${value}`, hint: `${doc.view} options: ${allowed.join(", ")}.` });
      continue;
    }
    const rule = OPTION_VALUES[key];
    if (key === "sort" && (doc.view === "cards" || doc.view === "list") && !/^[-+]?(?:value|title)$/.test(value)) {
      pushProblem(doc, { code: "bad-option", line, text: `${key}=${value}`, hint: "sort=value, -value or title." });
    } else if (rule && !rule.test(value)) {
      pushProblem(doc, { code: "bad-option", line, text: `${key}=${value}`, hint: rule.hint });
    }
  }
}

function applyRows(doc: ChatBlockDoc, rows: RawRow[]): void {
  doc.items = [];
  const add = (item: ChatBlockItem | null, line: RawRow) => {
    if (item) {
      doc.items.push(item);
      return;
    }
    const text = clamp(line.line ?? `- ${line.fields.join(" | ")}`);
    doc.invalid.push(text);
    pushProblem(doc, { code: "bad-row", ...(line.at ? { line: line.at } : {}), text, hint: `A ${doc.view} row is ${CHAT_BLOCK_ROW_SIGNATURES[doc.view]}.` });
  };
  switch (doc.view) {
    case "table": {
      let body = rows;
      if (doc.columns.length === 0 && rows.length > 0) {
        doc.columns = rows[0]!.fields;
        body = rows.slice(1);
      }
      for (const row of body) doc.items.push({ index: doc.items.length, selected: false, title: row.fields[0] ?? "", cells: row.fields });
      return;
    }
    case "chart": {
      let body = rows;
      const first = rows[0]?.fields;
      if (first && first.length > 1 && first.slice(1).every((cell) => !isNumeric(cell))) {
        doc.series = first.slice(1, 1 + CHAT_BLOCK_MAX_SERIES);
        body = rows.slice(1);
      } else if (doc.options.series) {
        doc.series = doc.options.series.split(",").map((name) => name.trim()).filter(Boolean).slice(0, CHAT_BLOCK_MAX_SERIES);
      }
      const width = Math.max(1, Math.min(CHAT_BLOCK_MAX_SERIES, doc.series.length || Math.max(0, ...body.map((row) => row.fields.length - 1))));
      if (doc.series.length === 0) doc.series = Array.from({ length: width }, (_, i) => (width === 1 ? doc.title || "#1" : `#${i + 1}`));
      for (const row of body) {
        const [label = "", ...cells] = row.fields;
        const values = doc.series.map((_, i) => (isNumeric(cells[i]) ? numericValue(cells[i]) : null));
        if (!label || values.every((value) => value === null)) add(null, row);
        else doc.items.push({ index: doc.items.length, selected: false, title: label, cells: row.fields, values });
      }
      return;
    }
    case "compare": {
      const [header, ...body] = rows;
      if (!header) return;
      doc.columns = header.fields.slice(1, 1 + CHAT_BLOCK_MAX_FIELDS);
      doc.columnImages = doc.columns.map(() => undefined);
      for (const row of body) {
        const [rawLabel = "", ...cells] = row.fields;
        const label = rawLabel.replace(/\s*[↑↓]\s*$/, "");
        if (/^(?:image|img|photo|фото)$/i.test(label) || (label === "" && cells.length > 0 && cells.every((cell) => cell === "" || looksLikeImage(cell)))) {
          doc.columnImages = doc.columns.map((_, i) => (cells[i] && looksLikeImage(cells[i]!) ? cells[i] : undefined));
          continue;
        }
        if (!label) { add(null, row); continue; }
        const best = /↑\s*$/.test(rawLabel) ? "max" : /↓\s*$/.test(rawLabel) ? "min" : undefined;
        doc.items.push({
          index: doc.items.length,
          selected: false,
          title: label,
          cells: doc.columns.map((_, i) => cells[i] ?? ""),
          ...(best ? { best } : {}),
        });
      }
      return;
    }
    default:
      for (const row of rows) {
        const index = doc.items.length;
        switch (doc.view) {
          case "stats": add(statItem(index, row.fields), row); break;
          case "choice": add(choiceItem(index, row.selected, row.fields), row); break;
          case "steps": add(stepItem(index, row.fields), row); break;
          case "form": {
            const report: Report = (code, text, hint) => pushProblem(doc, { code, ...(row.at ? { line: row.at } : {}), text, hint });
            add(formItem(index, row.fields, report), row);
            break;
          }
          case "media": add(galleryItem(index, row.fields), row); break;
          default: add(mediaItem(index, row.selected, row.fields), row);
        }
      }
  }
  if (doc.pick === "one") {
    // A single-choice block keeps at most one preselected item.
    let seen = false;
    for (const item of doc.items) {
      if (item.selected && seen) item.selected = false;
      seen ||= item.selected;
    }
  }
}

function parseAction(body: string): ChatBlockAction | null {
  const at = body.indexOf(" = ");
  const label = clamp((at < 0 ? body : body.slice(0, at)).trim()).slice(0, 80);
  const message = at < 0 ? "" : clamp(body.slice(at + 3).trim());
  if (!label) return null;
  return message ? { label, message } : { label };
}

const PICK_VIEWS: ReadonlySet<ChatBlockView> = new Set(["cards", "list", "choice", "media", "compare"]);

/**
 * Parse a fence body. `closed: false` means the fence is still streaming, so
 * its last line may be cut mid-way: it is held back and reported as pending.
 */
export function parseChatBlock(text: string, closed = true): ParseResult {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let pending = false;
  if (!closed && lines.length > 1) {
    lines.pop();
    pending = true;
  }
  const headerAt = lines.findIndex((line) => line.trim() !== "");
  if (headerAt < 0) return { ok: false, reason: "empty" };
  const header = parseHeader(lines[headerAt]!);
  if (!VIEW_SET.has(header.view)) return { ok: false, reason: "unknown-view", view: header.view };
  const view = header.view as ChatBlockView;
  const pickOption = header.options.pick;
  const pick: PickMode = !PICK_VIEWS.has(view)
    ? "none"
    : pickOption === "many" || pickOption === "multi"
      ? "many"
      : pickOption === "one" || pickOption === "single" || view === "choice"
        ? "one"
        : "none";

  const doc: ChatBlockDoc = {
    view,
    title: header.title,
    options: header.options,
    pick,
    columns: [],
    columnImages: [],
    series: [],
    items: [],
    actions: [],
    notes: [],
    invalid: [],
    problems: [],
    pending,
  };
  checkOptions(doc, headerAt + 1);
  if (view === "table" && header.options.cols && !header.options.from) {
    doc.columns = header.options.cols.split(",").map((col) => col.trim()).filter(Boolean).slice(0, CHAT_BLOCK_MAX_FIELDS);
  }
  if (header.options.from !== undefined) {
    const source = sourcePath(header.options.from);
    if (source) doc.source = source;
    else {
      doc.invalid.push(`from=${header.options.from}`);
      pushProblem(doc, {
        code: "bad-source",
        line: headerAt + 1,
        text: `from=${header.options.from}`,
        hint: "from= takes a project-relative path (no leading /, ~, \\ or ..) to a .json, .jsonl, .ndjson, .csv or .tsv file.",
      });
    }
  }

  const rows: RawRow[] = [];
  let droppedRows = 0;
  let droppedActions = 0;
  for (let at = headerAt + 1; at < lines.length; at++) {
    const line = lines[at]!;
    if (!line.trim()) continue;
    const action = ACTION_RE.exec(line);
    if (action) {
      const parsed = parseAction(action[1] ?? "");
      if (parsed && doc.actions.length < CHAT_BLOCK_MAX_ACTIONS) doc.actions.push(parsed);
      else if (parsed) droppedActions += 1;
      else {
        doc.invalid.push(clamp(line.trim()));
        pushProblem(doc, { code: "bad-button", line: at + 1, text: clamp(line.trim()), hint: "A button is > Label or > Label = message; {sel} in the message is replaced by the selected titles." });
      }
      continue;
    }
    const row = ROW_RE.exec(line);
    if (!row) {
      const fields = view === "table" ? tableLineFields(line) : null;
      if (!fields) {
        doc.notes.push(clamp(line.trim()));
        continue;
      }
      if (fields.length === 0) continue;
      if (rows.length >= CHAT_BLOCK_MAX_ROWS + 1) {
        droppedRows += 1;
        continue;
      }
      rows.push({ selected: false, fields, line: clamp(line.trim()), at: at + 1 });
      continue;
    }
    if (rows.length >= CHAT_BLOCK_MAX_ROWS + 1) {
      droppedRows += 1;
      continue;
    }
    const fieldCount = splitAllFields(row[2]!).length;
    if (fieldCount > CHAT_BLOCK_MAX_FIELDS) {
      pushProblem(doc, { code: "too-many-fields", line: at + 1, text: clamp(line.trim()), hint: `A row has at most ${CHAT_BLOCK_MAX_FIELDS} fields; this one has ${fieldCount}. Write \\| for a literal bar.` });
    }
    rows.push({ selected: row[1] === "x" || row[1] === "X", fields: splitFields(row[2]!), line: clamp(line.trim()), at: at + 1 });
  }
  if (droppedActions > 0) {
    pushProblem(doc, { code: "too-many-buttons", text: `${droppedActions} more`, hint: `A block shows at most ${CHAT_BLOCK_MAX_ACTIONS} buttons.` });
  }
  applyRows(doc, rows);
  // The row cap counts the table/compare header, so those may hold one more.
  const cap = doc.view === "table" ? CHAT_BLOCK_MAX_ROWS : doc.view === "compare" ? Infinity : CHAT_BLOCK_MAX_ROWS;
  const overflow = droppedRows + Math.max(0, doc.items.length - cap);
  if (overflow > 0) {
    pushProblem(doc, { code: "too-many-rows", text: `${overflow} more`, hint: `A fence holds at most ${CHAT_BLOCK_MAX_ROWS} rows; for more, write a JSON, JSON Lines or CSV file in the project and use from=<path>.` });
  }
  // Rows are built after the loop; report in reading order (limits last).
  doc.problems.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity));
  if (doc.view !== "table" && doc.view !== "compare" && doc.items.length > CHAT_BLOCK_MAX_ROWS) doc.items.length = CHAT_BLOCK_MAX_ROWS;
  if (doc.view === "table" && doc.items.length > CHAT_BLOCK_MAX_ROWS) doc.items.length = CHAT_BLOCK_MAX_ROWS;
  return { ok: true, doc };
}

// --------------------------------------------------------------- records

export type DataRecord = Readonly<Record<string, unknown>>;

const ROLE_KEYS: Readonly<Record<string, readonly string[]>> = {
  image: ["image", "img", "thumbnail", "thumb", "photo", "picture", "cover", "icon"],
  title: ["title", "name", "label", "heading"],
  subtitle: ["subtitle", "description", "desc", "summary", "details", "detail", "caption"],
  value: ["value", "price", "amount", "total", "score", "count"],
  badge: ["badge", "rating", "status", "tag", "category", "delta", "change"],
  link: ["link", "url", "href"],
  tone: ["tone"],
  id: ["id"],
  spark: ["spark", "sparkline", "trend", "history"],
  status: ["status", "state"],
  caption: ["caption", "title", "name", "alt", "description"],
};

const ROLES: Readonly<Partial<Record<ChatBlockView, readonly string[]>>> = {
  cards: ["image", "title", "subtitle", "value", "badge", "link"],
  list: ["image", "title", "subtitle", "value", "badge", "link"],
  media: ["image", "caption", "link"],
  stats: ["title", "value", "badge", "spark"],
  steps: ["status", "title", "subtitle"],
  choice: ["title", "subtitle"],
};

/** Display text for a record value: primitives as-is, arrays of numbers as a
 *  sparkline list, anything else as compact JSON. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return clamp(value.trim());
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === "number")) return value.join(",");
  try {
    return clamp(JSON.stringify(value));
  } catch {
    return "";
  }
}

/** `a,b:Label` → [{key:"a",label:"a"},{key:"b",label:"Label"}]. */
function columnSpec(spec: string | undefined): Array<{ key: string; label: string }> {
  if (!spec) return [];
  return spec.split(",").map((part) => {
    const [key = "", label] = part.split(":");
    return { key: key.trim(), label: (label ?? key).trim() };
  }).filter((column) => column.key).slice(0, CHAT_BLOCK_MAX_FIELDS);
}

/** `image:thumb,title:name` → role → record key. */
function roleMap(spec: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (spec ?? "").split(",")) {
    const [role = "", key = ""] = part.split(":").map((piece) => piece.trim());
    if (role && key) out[role] = key;
  }
  return out;
}

function findKey(keys: readonly string[], role: string, mapped: Record<string, string>): string | undefined {
  if (mapped[role]) return keys.includes(mapped[role]!) ? mapped[role] : undefined;
  const lower = new Map(keys.map((key) => [key.toLowerCase(), key]));
  for (const candidate of ROLE_KEYS[role] ?? [role]) {
    const hit = lower.get(candidate);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Replace a parsed block's rows with records from its `from=` file. Columns,
 * roles and series come from `cols=` / `map=` or from the record keys.
 */
export function withRecords(
  doc: ChatBlockDoc,
  records: readonly DataRecord[],
  loaded: { total: number; truncated: boolean } = { total: records.length, truncated: false },
): ChatBlockDoc {
  const next: ChatBlockDoc = { ...doc, items: [], invalid: [...doc.invalid], problems: [...doc.problems], columns: [], series: [], columnImages: [], loaded };
  const keys = [...new Set(records.slice(0, 50).flatMap((record) => Object.keys(record)))];
  const cols = columnSpec(doc.options.cols);
  const rows: RawRow[] = [];
  const selectedKey = keys.find((key) => key.toLowerCase() === "selected");

  if (doc.view === "table" || doc.view === "chart" || doc.view === "compare") {
    let columns = cols.filter((column) => keys.includes(column.key));
    if (columns.length === 0) {
      if (doc.view === "chart") {
        const label = keys.find((key) => records.some((record) => typeof record[key] === "string")) ?? keys[0];
        const numeric = keys.filter((key) => key !== label && records.some((record) => typeof record[key] === "number" || isNumeric(cellText(record[key]))));
        columns = [label, ...numeric.slice(0, CHAT_BLOCK_MAX_SERIES)].filter((key): key is string => Boolean(key)).map((key) => ({ key, label: key }));
      } else {
        columns = keys.slice(0, CHAT_BLOCK_MAX_FIELDS).map((key) => ({ key, label: key }));
      }
    }
    if (doc.view === "chart") {
      // Series come from the column choice, never from guessing a header row.
      const [labelColumn, ...seriesColumns] = columns;
      next.series = seriesColumns.map((column) => column.label);
      if (!labelColumn || next.series.length === 0) return next;
      for (const record of records) {
        const label = cellText(record[labelColumn.key]);
        const cells = seriesColumns.map((column) => cellText(record[column.key]));
        const values = cells.map((cell) => (isNumeric(cell) ? numericValue(cell) : null));
        if (label && values.some((value) => value !== null)) {
          next.items.push({ index: next.items.length, selected: false, title: label, cells: [label, ...cells], values });
        }
      }
      return next;
    }
    rows.push({ selected: false, fields: columns.map((column) => column.label) });
    for (const record of records) rows.push({ selected: false, fields: columns.map((column) => cellText(record[column.key])) });
  } else if (doc.view === "form") {
    for (const record of records) {
      rows.push({ selected: false, fields: ["name", "label", "type", "value", "options"].map((key) => cellText(record[key] ?? (key === "value" ? record.default : undefined))) });
    }
  } else {
    const mapped = roleMap(doc.options.map);
    const roles = ROLES[doc.view] ?? ROLES.cards!;
    const roleKeys = roles.map((role) => findKey(keys, role, mapped));
    const toneKey = findKey(keys, "tone", mapped);
    const idKey = findKey(keys, "id", mapped);
    for (const record of records) {
      const fields = roleKeys.map((key) => (key ? cellText(record[key]) : ""));
      const tone = toneKey ? cellText(record[toneKey]) : "";
      const id = idKey ? cellText(record[idKey]) : "";
      if (tone) fields.push(`tone=${tone}`);
      if (id && ITEM_ID_RE.test(`id=${id}`)) fields.push(`id=${id}`);
      rows.push({ selected: selectedKey ? record[selectedKey] === true : false, fields });
    }
  }
  applyRows(next, rows);
  return next;
}

// --------------------------------------------------------------- helpers

/** Numeric value of a display string such as "14 999 ₴", "$1,299.50", "−12%". */
export function numericValue(text: string | undefined): number | null {
  if (!text) return null;
  const normalized = text.replace(/[−‒–]/g, "-").replace(/[\s  ]/g, "");
  const m = /[-+]?\d+(?:[.,]\d+)*/.exec(normalized);
  if (!m) return null;
  let digits = m[0];
  const lastComma = digits.lastIndexOf(",");
  const lastDot = digits.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    digits = lastComma > lastDot ? digits.replace(/\./g, "").replace(",", ".") : digits.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // "1,299" groups thousands; "2,1" is a decimal comma.
    digits = /,\d{3}(?:,\d{3})*$/.test(digits) && !/^[-+]?0,/.test(digits) ? digits.replace(/,/g, "") : digits.replace(",", ".");
  }
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

/** Direction of a delta label: "+12%", "−0,6 п.п.", "↑ 4", "▼3". */
export function deltaDirection(text: string | undefined): "up" | "down" | "flat" {
  if (!text) return "flat";
  const t = text.trim();
  if (/^[+↑▲]/.test(t)) return "up";
  if (/^[-−↓▼]/.test(t)) return "down";
  return "flat";
}

/** Index of the winning cell in a compare row, or -1. */
export function bestIndex(item: ChatBlockItem): number {
  if (!item.best) return -1;
  const values = item.cells.map((cell) => (isNumeric(cell) ? numericValue(cell) : null));
  let at = -1;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value === null || value === undefined) continue;
    const current = at < 0 ? null : values[at]!;
    if (current === null || (item.best === "max" ? value > current : value < current)) at = i;
  }
  // A tie is not a win.
  if (at >= 0 && values.filter((value) => value === values[at]).length > 1) return -1;
  return at;
}

export function chartType(doc: ChatBlockDoc): ChartType {
  const type = doc.options.type;
  if (type === "line" || type === "area" || type === "donut" || type === "bar") return type;
  if (type === "pie") return "donut";
  return "bar";
}

const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
/** A clean axis end at or above `value`: 2 592 → 3 000, 7 → 8, 0.37 → 0.4. */
export function niceCeil(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = NICE_STEPS.find((candidate) => candidate * power >= value * (1 - 1e-9)) ?? 10;
  return Number((step * power).toPrecision(6));
}

/** Expand an action's message for the current selection. */
export function actionMessage(action: ChatBlockAction, selected: readonly string[]): string {
  const list = selected.join(", ");
  if (action.message) {
    return action.message.includes("{sel}")
      ? action.message.replace(/\{sel\}/g, list).trim()
      : selected.length > 0 ? `${action.message}: ${list}` : action.message;
  }
  return selected.length > 0 ? `${action.label}: ${list}` : action.label;
}

/** The buttons a block shows: its own, or Send for a choice/form without any. */
export function blockActions(doc: ChatBlockDoc, sendLabel: string): ChatBlockAction[] {
  const answers = doc.view === "choice" || doc.view === "form";
  return answers && doc.actions.length === 0 ? [{ label: sendLabel }] : doc.actions;
}

/** What a block's selection is called in messages: compare columns, else
 *  item labels (title plus id). Indexes are column or item indexes. */
export function selectionLabels(doc: ChatBlockDoc): Array<{ index: number; label: string }> {
  return doc.view === "compare"
    ? doc.columns.map((label, index) => ({ index, label }))
    : doc.items.map((item) => ({ index: item.index, label: itemLabel(item) }));
}

/** Read back a ", "-joined selection. Labels may contain ", " themselves, so
 *  the longest label that ends at a separator wins at each step. */
function readSelection(list: string, doc: ChatBlockDoc): number[] | null {
  const labels = selectionLabels(doc).filter((entry) => entry.label).sort((a, b) => b.label.length - a.label.length);
  const picked: number[] = [];
  let at = 0;
  while (at < list.length) {
    const hit = labels.find((entry) => !picked.includes(entry.index)
      && list.startsWith(entry.label, at)
      && (at + entry.label.length === list.length || list.startsWith(", ", at + entry.label.length)));
    if (!hit) return null;
    picked.push(hit.index);
    at += hit.label.length + 2;
  }
  return picked;
}

function readForm(body: string, doc: ChatBlockDoc, labels: { yes: string; no: string }): Record<string, string> | null {
  const values: Record<string, string> = {};
  const fields = doc.items.flatMap((item) => (item.field ? [item.field] : []));
  // Field values may hold "; ", so split only before a known "Label: ".
  const starts = fields
    .flatMap((field) => {
      const out: Array<{ at: number; field: FormField }> = [];
      for (let at = body.indexOf(`${field.label}: `); at >= 0; at = body.indexOf(`${field.label}: `, at + 1)) {
        if (at === 0 || body.startsWith("; ", at - 2)) out.push({ at, field });
      }
      return out;
    })
    .sort((a, b) => a.at - b.at);
  if (starts.length === 0 || starts[0]!.at !== 0) return null;
  for (let i = 0; i < starts.length; i++) {
    const { at, field } = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]!.at - 2 : body.length;
    const text = body.slice(at + field.label.length + 2, end);
    values[field.name] = field.type === "toggle" ? (text === labels.yes ? "true" : text === labels.no ? "false" : field.value) : text;
  }
  return values;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `reply` — the user message that followed this answer — is one this
 * block sends, so a reloaded conversation shows the block as answered. Only
 * an exact reading counts: the reply must be a button's message for some
 * selection (or the form's message) and every named item must exist.
 */
export function answeredBy(
  doc: ChatBlockDoc,
  reply: string | undefined,
  labels: { send: string; yes: string; no: string },
): { message: string; selected?: number[]; values?: Record<string, string> } | null {
  const message = reply?.trim();
  if (!message) return null;
  for (const action of blockActions(doc, labels.send)) {
    if (doc.view === "form") {
      const prefix = action.message ?? doc.title;
      const body = prefix ? (message.startsWith(`${prefix} — `) ? message.slice(prefix.length + 3) : null) : message;
      const values = body === null ? null : readForm(body, doc, labels);
      if (values) return { message, values };
      continue;
    }
    let list: string | null = null;
    if (doc.view === "choice" && !action.message) {
      list = doc.title ? (message.startsWith(`${doc.title} — `) ? message.slice(doc.title.length + 3) : null) : message;
      if (list === "") list = null;
    } else if (action.message?.includes("{sel}")) {
      const parts = action.message.split("{sel}").map(escapeRegExp);
      const match = new RegExp(`^${parts[0]}([\\s\\S]*?)${parts.slice(1).join("\\1")}$`).exec(message);
      list = match ? match[1]! : null;
    } else {
      const head = action.message ?? action.label;
      list = message === head ? "" : message.startsWith(`${head}: `) ? message.slice(head.length + 2) : null;
    }
    if (list === null) continue;
    const selected = readSelection(list, doc);
    if (selected) return { message, selected };
  }
  return null;
}

/** The message "Ask the agent to fix" sends: what went wrong and how a row
 *  should look, so the agent can resend the block. */
export function problemsMessage(title: string, view: string, problems: readonly ChatBlockProblem[]): string {
  const name = title ? `“${title}”` : `(${view})`;
  const lines = problems.slice(0, 10).map((problem) => {
    const where = problem.line ? `line ${problem.line}: ` : "";
    const text = problem.text.length > 120 ? `${problem.text.slice(0, 119)}…` : problem.text;
    return `- ${where}\`${text}\` — ${problem.hint}`;
  });
  return [`The \`\`\`ui block ${name} did not render cleanly:`, ...lines, "Please send the block again, corrected."].join("\n");
}

/** The one-line message a form sends: "Title — Label: value; Label: value".
 *  A button's own message replaces the title as the prefix. */
export function formMessage(
  doc: ChatBlockDoc,
  values: Readonly<Record<string, string>>,
  labels: { yes: string; no: string },
  prefix: string = doc.title,
): string {
  const parts = doc.items.flatMap((item) => {
    const field = item.field;
    if (!field) return [];
    const value = values[field.name] ?? field.value;
    const shown = field.type === "toggle" ? (value === "true" ? labels.yes : labels.no) : value.trim();
    return shown ? [`${field.label}: ${shown}`] : [];
  });
  const body = parts.join("; ");
  return prefix ? `${prefix} — ${body}` : body;
}

const STEP_MARK: Readonly<Record<StepStatus, string>> = { done: "[x]", doing: "[~]", todo: "[ ]", fail: "[!]", skip: "[-]" };

/** A plain Markdown rendering of the block for copy and non-Polyth readers. */
export function chatBlockMarkdown(doc: ChatBlockDoc): string {
  const out: string[] = [];
  if (doc.title) out.push(`**${doc.title}**`, "");
  const escape = (cell: string) => cell.replace(/\|/g, "\\|");
  const table = (columns: string[], rows: string[][]) => {
    if (columns.length === 0) return;
    out.push(`| ${columns.map(escape).join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`);
    for (const row of rows) out.push(`| ${columns.map((_, i) => escape(row[i] ?? "")).join(" | ")} |`);
  };
  switch (doc.view) {
    case "table": {
      const columns = doc.columns.length ? doc.columns : doc.items[0]?.cells.map((_, i) => `#${i + 1}`) ?? [];
      table(columns, doc.items.map((item) => item.cells));
      break;
    }
    case "chart":
      table(["", ...doc.series], doc.items.map((item) => [item.title, ...(item.values ?? []).map((value) => (value === null ? "" : String(value)))]));
      break;
    case "compare":
      table(["", ...doc.columns], doc.items.map((item) => [item.title, ...item.cells]));
      break;
    case "steps":
      for (const item of doc.items) out.push(`- ${STEP_MARK[item.status ?? "todo"]} ${item.title}${item.subtitle ? ` — ${item.subtitle}` : ""}`);
      break;
    case "form":
      for (const item of doc.items) out.push(`- ${item.field?.label ?? item.title}: ${item.field?.value ?? ""}`);
      break;
    case "media":
      for (const item of doc.items) out.push(`![${item.title}](${item.image ?? ""})`);
      break;
    default:
      for (const item of doc.items) {
        const title = item.link ? `[${item.title}](${item.link})` : item.title;
        const parts = [doc.view === "stats" ? `${title}: **${item.value ?? ""}**` : `**${title}**`];
        if (doc.view !== "stats" && item.value) parts.push(item.value);
        if (item.badge) parts.push(item.badge);
        if (item.subtitle) parts.push(item.subtitle);
        out.push(`- ${parts.join(" · ")}`);
      }
  }
  if (doc.notes.length) out.push("", ...doc.notes);
  return out.join("\n").trim();
}
