import type { JsonObject, RuntimeSnapshot } from "@polyth/contracts";
import type { OcEvent } from "./events.ts";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asJsonObject = (value: unknown): JsonObject =>
  asRecord(value) as JsonObject | undefined ?? {};

const errorMessage = (value: unknown): string => {
  if (typeof value === "string" && value.trim()) return value.slice(0, 500);
  const error = asRecord(value);
  const nested = asRecord(error?.error);
  for (const candidate of [error?.message, nested?.message]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.slice(0, 500);
    }
  }
  return "tool failed";
};

const toolOutput = (state: Record<string, unknown>): string | undefined => {
  if (typeof state.result === "string") return state.result;
  if (state.result === undefined) return undefined;
  try {
    return JSON.stringify(state.result);
  } catch {
    return undefined;
  }
};

export const pulledV2MessageEvents = (
  value: unknown,
  backendSessionId: string,
): OcEvent[] => {
  const message = asRecord(value);
  if (!message || typeof message.id !== "string") return [];
  const time = asRecord(message.time);
  if (message.type === "user") {
    return [{
      type: "message.updated",
      properties: {
        sessionID: backendSessionId,
        info: {
          id: message.id,
          role: "user",
          sessionID: backendSessionId,
          time: time ?? {},
        },
      },
    }];
  }
  if (message.type !== "assistant") return [];
  const model = asRecord(message.model);
  const events: OcEvent[] = [{
    type: "message.updated",
    properties: {
      sessionID: backendSessionId,
      info: {
        id: message.id,
        role: "assistant",
        sessionID: backendSessionId,
        time: time ?? {},
        ...(typeof model?.providerID === "string" ? { providerID: model.providerID } : {}),
        ...(typeof model?.id === "string" ? { modelID: model.id } : {}),
        ...(typeof message.cost === "number" ? { cost: message.cost } : {}),
        ...(asRecord(message.tokens) ? { tokens: message.tokens } : {}),
      },
    },
  }];
  for (const contentValue of Array.isArray(message.content) ? message.content : []) {
    const content = asRecord(contentValue);
    if (!content || typeof content.id !== "string") continue;
    if (content.type === "text" || content.type === "reasoning") {
      events.push({
        type: "message.part.updated",
        properties: {
          sessionID: backendSessionId,
          part: {
            id: content.id,
            type: content.type,
            text: typeof content.text === "string" ? content.text : "",
            messageID: message.id,
            sessionID: backendSessionId,
            time: {
              ...(typeof time?.created === "number" ? { start: time.created } : {}),
              ...(typeof time?.completed === "number" ? { end: time.completed } : {}),
            },
          },
        },
      });
      continue;
    }
    if (content.type !== "tool") continue;
    const state = asRecord(content.state) ?? {};
    const status = typeof state.status === "string" ? state.status : "pending";
    const output = toolOutput(state);
    events.push({
      type: "message.part.updated",
      properties: {
        sessionID: backendSessionId,
        part: {
          id: content.id,
          type: "tool",
          callID: content.id,
          tool: typeof content.name === "string" ? content.name : "tool",
          messageID: message.id,
          sessionID: backendSessionId,
          state: {
            status,
            input: asJsonObject(state.input),
            ...(output ? { output } : {}),
            ...(status === "error" ? { error: errorMessage(state.error) } : {}),
          },
        },
      },
    });
  }
  return events;
};

export const v2PermissionOf = (
  value: unknown,
  backendSessionId: string,
): RuntimeSnapshot["permissions"][number] | undefined => {
  const request = asRecord(value);
  if (!request || request.sessionID !== backendSessionId || typeof request.id !== "string") {
    return undefined;
  }
  return {
    requestId: request.id,
    permission: typeof request.action === "string" ? request.action : "unknown",
    patterns: Array.isArray(request.resources)
      ? request.resources.filter((item): item is string => typeof item === "string")
      : [],
    revision: "pending",
  };
};

export const v2QuestionOf = (
  value: unknown,
  backendSessionId: string,
): RuntimeSnapshot["questions"][number] | undefined => {
  const request = asRecord(value);
  if (!request || request.sessionID !== backendSessionId || typeof request.id !== "string") {
    return undefined;
  }
  return {
    requestId: request.id,
    questions: Array.isArray(request.questions)
      ? request.questions
          .map(asRecord)
          .filter((item): item is Record<string, unknown> => item !== undefined)
          .map((item) => item as JsonObject)
      : [],
    revision: "pending",
  };
};
