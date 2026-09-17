import type { RuntimeSnapshot } from "@polyth/contracts";
import {
  normalizeOcObservation,
  splitNormalizedObservation,
  type ObservationBinding,
  type TranslateState,
} from "./events.ts";

export const appendPulledEvents = (
  target: RuntimeSnapshot["events"],
  data: unknown,
  binding: ObservationBinding,
  state: TranslateState,
): void => {
  const normalized = normalizeOcObservation({
    data,
    channel: "pull",
    observed: binding,
    current: binding,
    state,
  });
  if (normalized.kind !== "accepted") return;
  for (const observation of splitNormalizedObservation(normalized.observation)) {
    const event = observation.events[0];
    if (!event) continue;
    target.push({
      entityKey: observation.entityKey,
      revision: observation.identity.revision,
      event,
    });
  }
};
