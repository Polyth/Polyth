import type { JsonObject, JsonValue, RuntimeEvent } from "@polyth/contracts";

export interface AcpToolCallState {
    toolCallId: string;
    tool?: string;
    title?: string;
    status?: string;
    rawInput?: JsonObject;
    rawOutput?: unknown;
    locations?: unknown[];
    content?: unknown[];
    startedEmitted: boolean;
    finished: boolean;
    lastEmittedInput?: string;
}

const GENERIC_TITLES = new Set([
    "grep",
    "find",
    "read",
    "read file",
    "search",
    "write",
    "edit",
    "tool",
    "execute",
    "run",
    "shell",
]);

const INPUT_KEYS = [
    "path",
    "filePath",
    "file_path",
    "pattern",
    "query",
    "search",
    "text",
    "command",
    "cmd",
    "oldString",
    "old_string",
    "newString",
    "new_string",
    "offset",
    "limit",
    "url",
    "glob",
    "grep",
    "target",
    "destination",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

const asJsonObject = (value: unknown): JsonObject | undefined =>
    isRecord(value) ? value as JsonObject : undefined;

const stringValue = (...values: unknown[]): string | undefined => {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
};

const inputSignature = (input: JsonObject): string => JSON.stringify(input);

/** ACP v1 content items may be nested (`type: content`) or top-level siblings. */
const contentPayload = (item: Record<string, unknown>): Record<string, unknown> | undefined => {
    if (item.type === "content" && isRecord(item.content)) return item.content;
    if (typeof item.type === "string" && item.type !== "content") return item;
    return undefined;
};

export function mergeAcpToolCallUpdate(state: AcpToolCallState, update: Record<string, unknown>): void {
    const kind = stringValue(update.kind);
    if (kind) state.tool = kind;
    const title = stringValue(update.title);
    if (title) state.title = title;
    const status = stringValue(update.status);
    if (status) state.status = status;
    const rawInput = asJsonObject(update.rawInput);
    if (rawInput) state.rawInput = rawInput;
    if (update.rawOutput !== undefined) state.rawOutput = update.rawOutput;
    if (Array.isArray(update.locations)) state.locations = update.locations;
    if (Array.isArray(update.content)) state.content = update.content;
}

function locationPath(locations: unknown[] | undefined): { path?: string; line?: number } {
    const first = locations?.[0];
    if (!isRecord(first)) return {};
    const path = stringValue(first.path, first.filePath, first.file_path);
    const line = typeof first.line === "number"
        ? first.line
        : typeof first.startLine === "number"
            ? first.startLine
            : undefined;
    return { path, line };
}

function isGenericTitle(title: string | undefined): boolean {
    if (!title) return true;
    return GENERIC_TITLES.has(title.toLowerCase());
}

function applyDiffToInput(input: JsonObject, diff: Record<string, unknown>): void {
    const diffPath = stringValue(diff.path, diff.filePath, diff.file_path);
    if (diffPath && !stringValue(input.path, input.filePath, input.file_path)) input.filePath = diffPath;
    if (typeof diff.oldText === "string" && input.oldString === undefined) input.oldString = diff.oldText;
    if (typeof diff.newText === "string" && input.newString === undefined) input.newString = diff.newText;
}

export function formatAcpToolInput(state: AcpToolCallState): JsonObject {
    const input: JsonObject = {};
    const raw = state.rawInput ?? {};
    for (const key of INPUT_KEYS) {
        const value = raw[key];
        if (typeof value === "string" && value.trim()) input[key] = value.trim();
        else if (typeof value === "number") input[key] = value;
    }
    for (const [key, value] of Object.entries(raw)) {
        if ((INPUT_KEYS as readonly string[]).includes(key)) continue;
        if (typeof value === "string" && value.trim()) input[key] = value.trim();
        else if (typeof value === "number" || typeof value === "boolean") input[key] = value;
    }
    const { path, line } = locationPath(state.locations);
    if (path && !stringValue(input.path, input.filePath, input.file_path)) input.path = path;
    if (line !== undefined && input.offset === undefined) input.offset = line;
    for (const item of state.content ?? []) {
        if (!isRecord(item)) continue;
        const payload = contentPayload(item);
        if (!payload || payload.type !== "diff") continue;
        applyDiffToInput(input, payload);
    }
    const title = state.title;
    if (title && !isGenericTitle(title) && Object.keys(input).length === 0) input.description = title;
    return input;
}

function searchResultLine(path: string, line: number | string, context?: string): string {
    const lineText = String(line);
    return context !== undefined && context !== ""
        ? `${path}:${lineText}:${context}`
        : `${path}:${lineText}`;
}

function flattenSearchResults(value: JsonValue): string[] {
    if (Array.isArray(value)) {
        return value.flatMap((item) => flattenSearchResults(item));
    }
    if (!isRecord(value)) return [];
    const path = stringValue(value.path, value.file, value.filePath, value.file_path, value.filename);
    const line = value.line ?? value.lineNumber ?? value.line_number ?? value.row;
    const context = stringValue(value.context, value.content, value.text, value.match, value.preview, value.snippet);
    if (path && line !== undefined) return [searchResultLine(path, line as number | string, context)];
    const nested = value.matches ?? value.results ?? value.hits ?? value.items ?? value.files;
    if (nested !== undefined) return flattenSearchResults(nested as JsonValue);
    return [];
}

function semanticFlatten(value: JsonValue, label = "Result"): string[] {
    if (typeof value === "string") return value.trim() ? [value.trim()] : [];
    if (typeof value === "number" || typeof value === "boolean") return [String(value)];
    if (value === null) return [];
    if (Array.isArray(value)) {
        const searchLines = value.flatMap((item) => flattenSearchResults(item));
        if (searchLines.length > 0) return searchLines;
        return value.flatMap((item, index) => {
            const lines = semanticFlatten(item, `${label} ${index + 1}`);
            return lines.length === 1 ? lines : lines.map((line) => `${label} ${index + 1}: ${line}`);
        });
    }
    if (!isRecord(value)) return [];
    const searchLines = flattenSearchResults(value);
    if (searchLines.length > 0) return searchLines;
    for (const key of ["stdout", "stderr", "output", "text", "message", "result", "data"]) {
        const nested = value[key];
        if (typeof nested === "string" && nested.trim()) return [nested.trim()];
    }
    if (typeof value.terminalId === "string" || typeof value.terminal_id === "string") {
        const terminalId = stringValue(value.terminalId, value.terminal_id)!;
        return [`Output streamed to terminal ${terminalId}`];
    }
    const entries = Object.entries(value).slice(0, 12);
    if (entries.length === 0) return [];
    return entries.map(([key, nested]) => {
        if (typeof nested === "string") return `${key}: ${nested.trim()}`;
        if (typeof nested === "number" || typeof nested === "boolean") return `${key}: ${String(nested)}`;
        if (Array.isArray(nested)) return `${key}: ${nested.length} ${nested.length === 1 ? "item" : "items"}`;
        if (isRecord(nested)) return `${key}: ${Object.keys(nested).length} fields`;
        return `${key}: ${String(nested)}`;
    });
}

function flattenTextBlock(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return "";
    try {
        const parsed = JSON.parse(trimmed) as JsonValue;
        if (parsed !== null && (typeof parsed === "object" || Array.isArray(parsed))) {
            const searchLines = flattenSearchResults(parsed);
            if (searchLines.length > 0) return searchLines.join("\n");
            const flattened = semanticFlatten(parsed).join("\n");
            if (flattened) return flattened;
        }
    } catch { /* plain text */ }
    return text;
}

function terminalMessage(payload: Record<string, unknown>): string {
    const terminalId = stringValue(payload.terminalId, payload.terminal_id, payload.id);
    return terminalId ? `Output streamed to terminal ${terminalId}` : "Output streamed to terminal";
}

function textFromPayload(payload: Record<string, unknown>): string | undefined {
    const direct = stringValue(payload.text, payload.output);
    if (direct) return flattenTextBlock(direct);
    if (payload.type === "text" && typeof payload.text === "string") return flattenTextBlock(payload.text);
    return undefined;
}

function textBlocksFromContent(content: unknown[] | undefined): string[] {
    const parts: string[] = [];
    for (const item of content ?? []) {
        if (!isRecord(item)) {
            parts.push(`Unsupported content: ${typeof item}`);
            continue;
        }
        const payload = contentPayload(item);
        if (!payload) continue;
        const text = textFromPayload(payload);
        if (text) {
            parts.push(text);
            continue;
        }
        if (payload.type === "resource") {
            const uri = stringValue(payload.uri, payload.url);
            if (uri) parts.push(`Resource: ${uri}`);
            continue;
        }
        if (payload.type === "terminal") {
            parts.push(terminalMessage(payload));
            continue;
        }
        if (payload.type === "diff") continue;
        if (typeof payload.type === "string") {
            const fallback = stringValue(payload.message, payload.summary, payload.label);
            if (fallback) parts.push(fallback);
        }
    }
    return parts;
}

function diffInputPatch(content: unknown[] | undefined): JsonObject {
    const patch: JsonObject = {};
    for (const item of content ?? []) {
        if (!isRecord(item)) continue;
        const payload = contentPayload(item);
        if (!payload || payload.type !== "diff") continue;
        applyDiffToInput(patch, payload);
    }
    return patch;
}

function locationSearchLines(locations: unknown[] | undefined): string[] {
    const lines: string[] = [];
    for (const location of locations ?? []) {
        if (!isRecord(location)) continue;
        const path = stringValue(location.path, location.filePath, location.file_path);
        const line = location.line ?? location.lineNumber ?? location.line_number ?? location.startLine;
        const context = stringValue(location.context, location.snippet, location.content, location.text, location.preview);
        if (path && line !== undefined) lines.push(searchResultLine(path, line as number | string, context));
    }
    return lines;
}

function formatRawOutput(rawOutput: unknown): string {
    if (rawOutput === undefined || rawOutput === null) return "";
    if (typeof rawOutput === "string") {
        const trimmed = rawOutput.trim();
        if (!trimmed) return "";
        try {
            const parsed = JSON.parse(trimmed) as JsonValue;
            if (parsed !== null && (typeof parsed === "object" || Array.isArray(parsed))) {
                const flattened = semanticFlatten(parsed).join("\n");
                if (flattened) return flattened;
            }
        } catch { /* plain text */ }
        return trimmed;
    }
    return semanticFlatten(rawOutput as JsonValue).join("\n");
}

export function formatAcpToolOutput(state: AcpToolCallState): { text: string; inputPatch: JsonObject } {
    const textParts = textBlocksFromContent(state.content);
    const rawText = formatRawOutput(state.rawOutput);
    if (rawText) textParts.push(rawText);
    const inputPatch = diffInputPatch(state.content);
    let text = textParts.join("\n").trim();
    if (!text) {
        const locationLines = locationSearchLines(state.locations);
        if (locationLines.length > 0) text = locationLines.join("\n");
    }
    return {
        text,
        inputPatch,
    };
}

function extractFailureMessage(state: AcpToolCallState): string {
    const { text } = formatAcpToolOutput(state);
    if (text) return text.split(/\r?\n/)[0] ?? text;
    return "Tool failed";
}

function maybeEmitToolStarted(
    state: AcpToolCallState,
    events: RuntimeEvent[],
    toolCallId: string,
    tool: string,
    input: JsonObject,
): void {
    const signature = inputSignature(input);
    if (!state.startedEmitted) {
        state.startedEmitted = true;
        state.lastEmittedInput = signature;
        events.push({ type: "tool/started", callId: toolCallId, tool, input });
        return;
    }
    if (state.finished || Object.keys(input).length === 0 || signature === state.lastEmittedInput) return;
    state.lastEmittedInput = signature;
    events.push({ type: "tool/started", callId: toolCallId, tool, input });
}

export function eventsFromAcpToolCallUpdate(
    states: Map<string, AcpToolCallState>,
    update: Record<string, unknown>,
): RuntimeEvent[] {
    const toolCallId = stringValue(update.toolCallId);
    if (!toolCallId) return [];
    let state = states.get(toolCallId);
    if (!state) {
        state = {
            toolCallId,
            startedEmitted: false,
            finished: false,
        };
        states.set(toolCallId, state);
    }
    mergeAcpToolCallUpdate(state, update);
    const events: RuntimeEvent[] = [];
    const tool = state.tool ?? "tool";
    const input = formatAcpToolInput(state);
    maybeEmitToolStarted(state, events, toolCallId, tool, input);
    if (state.status === "completed" || state.status === "failed") {
        if (state.finished) return events;
        state.finished = true;
        if (state.status === "failed") {
            events.push({
                type: "tool/error",
                callId: toolCallId,
                tool,
                error: extractFailureMessage(state),
            });
            return events;
        }
        const { text, inputPatch } = formatAcpToolOutput(state);
        const mergedInput = Object.keys(inputPatch).length > 0 ? { ...input, ...inputPatch } : input;
        events.push({
            type: "tool/result",
            callId: toolCallId,
            tool,
            output: text,
            ...(Object.keys(mergedInput).length > 0 ? { input: mergedInput } : {}),
        });
    }
    return events;
}
