// What happens to a chat's chosen model when its resolved harness changes.
import type { HarnessSelection } from "@polyth/contracts";
import type { ComposerModelRef } from "../composerConfig.ts";

/**
 * The model the composer keeps after the session's resolved harness moved
 * from `previousHarnessId` to `harnessId`, or undefined when it must be
 * dropped (an incompatible model is never sent).
 *
 * A Relay hands a chat between its member accounts without anyone changing
 * the route: the session stays pinned to the Relay while the member that runs
 * it changes. The choice then moves with the chat, re-owned by the new member
 * (members of one family list the same models; the runtime still checks it).
 * Any other route change drops a model owned by another harness.
 */
export function carriedRouteModel(input: {
  model: ComposerModelRef | undefined;
  /** The session's selection before and after the move. */
  previousSelection: HarnessSelection | undefined;
  selection: HarnessSelection | undefined;
  previousHarnessId: string | undefined;
  harnessId: string | undefined;
}): ComposerModelRef | undefined {
  const { model, harnessId } = input;
  if (!model) return undefined;
  if (!harnessId || (model.harnessId ?? "opencode") === harnessId) return model;
  const pinned = input.selection?.mode === "pinned" ? input.selection.harnessId : undefined;
  const handedOver = pinned !== undefined
    && input.previousSelection?.mode === "pinned"
    && input.previousSelection.harnessId === pinned
    && input.previousHarnessId !== undefined
    && input.previousHarnessId !== pinned
    && harnessId !== pinned
    && (model.harnessId === input.previousHarnessId || model.harnessId === pinned);
  return handedOver ? { ...model, harnessId } : undefined;
}
