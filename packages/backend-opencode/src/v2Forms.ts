import type { JsonObject, RuntimeSnapshot } from "@polyth/contracts";

type RecordValue = Record<string, unknown>;
type FormValue = string | number | boolean | string[];

export interface V2FormField {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external";
  title?: string;
  description?: string;
  required?: boolean;
  when?: Array<{ key: string; op: "eq" | "neq"; value: string | number | boolean }>;
  options?: Array<{ value: string; label: string; description?: string }>;
  custom?: boolean;
  url?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
}

export interface V2FormInfo {
  id: string;
  sessionID: string;
  title: string;
  fields: V2FormField[];
}

const asRecord = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : undefined;

const optionRows = (value: unknown): V2FormField["options"] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const result: NonNullable<V2FormField["options"]> = [];
  for (const entry of value) {
    const option = asRecord(entry);
    if (!option || typeof option.value !== "string" || typeof option.label !== "string") {
      return undefined;
    }
    result.push({
      value: option.value,
      label: option.label,
      ...(typeof option.description === "string" ? { description: option.description } : {}),
    });
  }
  return result;
};

const whenRows = (value: unknown): V2FormField["when"] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const result: NonNullable<V2FormField["when"]> = [];
  for (const entry of value) {
    const when = asRecord(entry);
    if (
      !when
      || typeof when.key !== "string"
      || (when.op !== "eq" && when.op !== "neq")
      || !["string", "number", "boolean"].includes(typeof when.value)
    ) return undefined;
    result.push({
      key: when.key,
      op: when.op,
      value: when.value as string | number | boolean,
    });
  }
  return result;
};

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const formFieldOf = (value: unknown): V2FormField | undefined => {
  const field = asRecord(value);
  if (!field || typeof field.key !== "string" || !field.key) return undefined;
  const type = field.type;
  if (
    type !== "string"
    && type !== "number"
    && type !== "integer"
    && type !== "boolean"
    && type !== "multiselect"
    && type !== "external"
  ) return undefined;
  const options = optionRows(field.options);
  const when = type === "external" ? undefined : whenRows(field.when);
  if ((field.options !== undefined && !options) || (field.when !== undefined && !when)) return undefined;
  if (type === "multiselect" && !options) return undefined;
  if (type === "external" && typeof field.url !== "string") return undefined;
  return {
    key: field.key,
    type,
    ...(typeof field.title === "string" ? { title: field.title } : {}),
    ...(typeof field.description === "string" ? { description: field.description } : {}),
    ...(typeof field.required === "boolean" ? { required: field.required } : {}),
    ...(when ? { when } : {}),
    ...(options ? { options } : {}),
    ...(typeof field.custom === "boolean" ? { custom: field.custom } : {}),
    ...(typeof field.url === "string" ? { url: field.url } : {}),
    ...(finite(field.minimum) !== undefined ? { minimum: finite(field.minimum) } : {}),
    ...(finite(field.maximum) !== undefined ? { maximum: finite(field.maximum) } : {}),
    ...(finite(field.minItems) !== undefined ? { minItems: finite(field.minItems) } : {}),
    ...(finite(field.maxItems) !== undefined ? { maxItems: finite(field.maxItems) } : {}),
    ...(finite(field.minLength) !== undefined ? { minLength: finite(field.minLength) } : {}),
    ...(finite(field.maxLength) !== undefined ? { maxLength: finite(field.maxLength) } : {}),
  };
};

/** Validate the released V2 Form.Info response before it can become an
 * interactive canonical request. The server separately checks route ownership;
 * retaining sessionID here protects a stale or cross-session adapter binding. */
export const v2FormInfoOf = (
  value: unknown,
  backendSessionId: string,
): V2FormInfo | undefined => {
  const form = asRecord(value);
  if (
    !form
    || typeof form.id !== "string"
    || !form.id
    || form.sessionID !== backendSessionId
    || typeof form.title !== "string"
    || !Array.isArray(form.fields)
    || form.fields.length === 0
  ) return undefined;
  const fields: V2FormField[] = [];
  for (const value of form.fields) {
    const field = formFieldOf(value);
    if (!field) return undefined;
    fields.push(field);
  }
  const keys = new Set<string>();
  for (const field of fields) {
    if (keys.has(field.key)) return undefined;
    keys.add(field.key);
  }
  return { id: form.id, sessionID: backendSessionId, title: form.title, fields };
};

const formQuestionOf = (field: V2FormField): JsonObject => {
  const description = field.type === "external"
    ? `${field.description ?? field.title ?? field.key}\n\nOpen ${field.url ?? "the requested URL"}, then confirm completion.`
    : field.description ?? field.title ?? field.key;
  const conditional = Boolean(field.when?.length);
  const prompt = conditional
    ? `${description}\n\n${field.required ? "Required" : "Applies"} when ${field.when!.map((condition) => `${condition.key} ${condition.op === "eq" ? "is" : "is not"} ${JSON.stringify(condition.value)}`).join(" and ")}.`
    : description;
  // The shared question UI does not evaluate native form conditions. Let it
  // submit omitted conditional fields; typed reply validation checks activity.
  const required = field.required === true && !conditional;
  if (field.type === "boolean") {
    return {
      id: field.key,
      ...(field.title ? { title: field.title } : {}),
      prompt,
      type: "single",
      options: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }],
      required,
    };
  }
  if (field.type === "multiselect") {
    return {
      id: field.key,
      ...(field.title ? { title: field.title } : {}),
      prompt,
      type: "multi",
      options: field.options ?? [],
      required,
      ...(field.custom ? { allowOther: true } : {}),
    };
  }
  if (field.type === "external") {
    return {
      id: field.key,
      ...(field.title ? { title: field.title } : {}),
      prompt,
      type: "single",
      options: [{ value: "true", label: "I completed this step" }],
      required: true,
    };
  }
  return {
    id: field.key,
    ...(field.title ? { title: field.title } : {}),
    prompt,
    ...(field.options && field.options.length > 0
      ? { type: "single", options: field.options, ...(field.custom ? { allowOther: true } : {}) }
      : { type: "text" }),
    required,
  };
};

export const v2FormQuestionOf = (
  value: unknown,
  backendSessionId: string,
): RuntimeSnapshot["questions"][number] | undefined => {
  const form = v2FormInfoOf(value, backendSessionId);
  if (!form) return undefined;
  return {
    requestId: form.id,
    questions: form.fields.map(formQuestionOf),
    revision: "pending",
  };
};

const isActive = (field: V2FormField, answer: Record<string, FormValue>): boolean =>
  (field.when ?? []).every((when) => {
    const value = answer[when.key];
    if (value === undefined) return false;
    const match = Array.isArray(value) ? value.includes(String(when.value)) : value === when.value;
    return when.op === "eq" ? match : !match;
  });

const valueError = (field: V2FormField, message: string): { error: string } => ({
  error: `Invalid answer for ${field.key}: ${message}`,
});

const answerValues = (raw: RecordValue, index: number): string[] | { error: string } => {
  const values = raw.answers;
  if (!Array.isArray(values) || !Array.isArray(values[index])) {
    return { error: "OpenCode form reply requires positional string answers" };
  }
  const answer = values[index];
  if (!answer.every((item) => typeof item === "string")) {
    return { error: "OpenCode form reply contains a non-string answer" };
  }
  return answer;
};

const acceptsOption = (field: V2FormField, value: string): boolean =>
  field.options === undefined || field.custom === true || field.options.some((option) => option.value === value);

/** Convert the generic positional question reply back into released V2's
 * typed Form.Answer. This has no side effects; the native server remains the
 * authority for complete constraint validation. */
export const v2FormAnswerOf = (
  form: V2FormInfo,
  value: JsonObject,
): { answer: JsonObject } | { error: string } => {
  const raw = asRecord(value);
  if (!raw) return { error: "OpenCode form reply must be an object" };
  const answer: Record<string, FormValue> = {};
  for (let index = 0; index < form.fields.length; index += 1) {
    const field = form.fields[index]!;
    const values = answerValues(raw, index);
    if ("error" in values) return values;
    if (!isActive(field, answer)) continue;
    if (field.type === "multiselect") {
      if (values.some((item) => !acceptsOption(field, item))) return valueError(field, "unknown option");
      if (values.length > 0) answer[field.key] = values;
      else if (field.required) return valueError(field, "a selection is required");
      continue;
    }
    const scalar = values[0];
    if (values.length > 1) return valueError(field, "expected one value");
    if (scalar === undefined || scalar === "") {
      if (field.required || field.type === "external") return valueError(field, "an answer is required");
      continue;
    }
    if (field.type === "string") {
      if (!acceptsOption(field, scalar)) return valueError(field, "unknown option");
      answer[field.key] = scalar;
      continue;
    }
    if (field.type === "boolean") {
      if (scalar !== "true" && scalar !== "false") return valueError(field, "expected yes or no");
      answer[field.key] = scalar === "true";
      continue;
    }
    if (field.type === "external") {
      if (scalar !== "true") return valueError(field, "the external step must be acknowledged");
      answer[field.key] = true;
      continue;
    }
    const numeric = Number(scalar);
    if (!Number.isFinite(numeric) || (field.type === "integer" && !Number.isInteger(numeric))) {
      return valueError(field, field.type === "integer" ? "expected an integer" : "expected a number");
    }
    answer[field.key] = numeric;
  }
  return { answer: answer as JsonObject };
};
