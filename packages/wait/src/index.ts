// The condition-provider contract of `wait.conditions`. A package that can
// tell when something finished (a CI run, a deployment) registers a provider
// there; it needs only this structural shape, never an import of this package.
import type { Disposable, JsonObject } from "@polyth/contracts";

/** Who a wait acts for, as the tool resolved it. */
export interface WaitConditionContext {
  spaceId: string;
  projectId: string;
  sessionId: string;
  actorUserId: string;
  cwd: string;
}

/** What a provider sees of a stored wait. */
export interface WaitConditionRecord {
  id: string;
  spaceId: string;
  projectId: string;
  sessionId: string;
  actorUserId: string;
  kind: string;
  label: string;
  target: JsonObject;
}

export type WaitConditionPoll =
  | { done: false }
  | { done: true; outcome: string; text: string };

export interface WaitConditionProvider {
  kind: string;
  /** How often `poll` runs, in ms; the manager never polls faster than 5 s. */
  intervalMs: number;
  /** Validate the model's input and say what is waited for. Throws to refuse. */
  start(input: JsonObject, ctx: WaitConditionContext): Promise<{ label: string; target: JsonObject }>;
  poll(record: WaitConditionRecord): Promise<WaitConditionPoll>;
}

export interface WaitConditionRegistry {
  register(provider: WaitConditionProvider): Disposable;
}

export const WAIT_CONDITIONS_SERVICE_ID = "wait.conditions";
export const WAIT_TOOL_NAME = "polyth_wait";
