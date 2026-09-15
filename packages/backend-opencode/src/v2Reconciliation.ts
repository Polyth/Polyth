import type { JsonObject, RuntimeSnapshot } from "@polyth/contracts";
import { v2AssistantPartId, v2ToolError, v2ToolOutput, type OcEvent } from "./events.ts";
import { v2FormQuestionOf } from "./v2Forms.ts";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const asJsonObject = (value: unknown): JsonObject =>
  asRecord(value) as JsonObject | undefined ?? {};

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
  const partOrdinals = { text: 0, reasoning: 0 };
  for (const contentValue of Array.isArray(message.content) ? message.content : []) {
    const content = asRecord(contentValue);
    if (!content) continue;
    if (content.type === "text" || content.type === "reasoning") {
      // V2's released AssistantText and AssistantReasoning schema has no
      // content id. Derive a stable part identity from the durable message and
      // its ordered content position so a pulled completed response finalizes
      // exactly once. Tool parts retain their native ids below.
      const ordinal = partOrdinals[content.type]++;
      const partId = v2AssistantPartId(message.id, content.type, ordinal);
      events.push({
        type: "message.part.updated",
        properties: {
          sessionID: backendSessionId,
          part: {
            id: partId,
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
    if (content.type !== "tool" || typeof content.id !== "string" || !content.id) continue;
    const state = asRecord(content.state) ?? {};
    const status = typeof state.status === "string" ? state.status : "pending";
    const output = v2ToolOutput(state.content);
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
            ...(status === "error" ? { error: v2ToolError(state.error) } : {}),
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
): RuntimeSnapshot["questions"][number] | undefined => v2FormQuestionOf(value, backendSessionId);
