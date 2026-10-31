import type { ObservationCheckpoint, RuntimeSnapshot } from "@polyth/contracts";
import {
  normalizeOcObservation,
  type ObservationBinding,
  type TranslateState,
} from "./events.ts";

/** One pulled native observation becomes one snapshot entry carrying every
 * canonical event it derives. Grouping is what lets the session store admit
 * the source observation once instead of per canonical member. */
export const appendPulledEvents = (
  target: RuntimeSnapshot["events"],
  data: unknown,
  binding: ObservationBinding,
  state: TranslateState,
  checkpoints?: ReadonlyMap<string, ObservationCheckpoint>,
): void => {
  const normalized = normalizeOcObservation({
    data,
    channel: "pull",
    observed: binding,
    current: binding,
    state,
    ...(checkpoints ? { checkpoints } : {}),
  });
  if (normalized.kind !== "accepted") return;
  const observation = normalized.observation;
  if (!observation.events.length) return;
  target.push({
    entityKey: observation.entityKey,
    revision: observation.identity.revision,
    artifactKind: observation.identity.artifactKind,
    events: observation.events,
    ...(observation.checkpoint?.stateRank !== undefined
      ? { stateRank: observation.checkpoint.stateRank }
      : {}),
    ...(observation.checkpoint ? { checkpoint: observation.checkpoint.value } : {}),
  });
};
