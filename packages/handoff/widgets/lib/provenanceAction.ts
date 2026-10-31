import type { HandoffTarget } from "./client.ts";

export type HandoffProvenanceAction = "none" | "record-session" | "pending-new-session";

/** V1: draft is composer text only. Provenance starts on actual delivery. */
export function provenanceActionForTarget(target: HandoffTarget): HandoffProvenanceAction {
  if (target === "draft") return "none";
  if (target === "new-session") return "pending-new-session";
  if (target === "current-session" || target === "queue") return "record-session";
  return "none";
}
