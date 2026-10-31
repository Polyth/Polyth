import type { ModelRef, ResumeTurnOptions } from "@polyth/contracts";

export type RecoveryModelChoice = ModelRef & { harnessId?: string };

/**
 * Turn a picker row back into the two distinct pieces of execution intent.
 * The model identifier remains runtime-local, while a different harness is a
 * submit-time route change. A stale row from the previous harness must not
 * override the tab the person can currently see.
 */
export function resumeOptionsForModel(input: {
  currentHarnessId?: string;
  selectedHarnessId?: string;
  model: RecoveryModelChoice;
}): ResumeTurnOptions | null {
  const { currentHarnessId, selectedHarnessId, model } = input;
  if (model.harnessId && selectedHarnessId && model.harnessId !== selectedHarnessId) return null;
  const targetHarnessId = selectedHarnessId ?? model.harnessId;
  const { harnessId: _harnessId, ...modelRef } = model;
  return {
    model: modelRef,
    ...(targetHarnessId && targetHarnessId !== currentHarnessId
      ? { harness: { mode: "pinned", harnessId: targetHarnessId } }
      : {}),
  };
}
