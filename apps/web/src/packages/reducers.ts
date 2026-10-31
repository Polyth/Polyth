import type { SessionEvent } from "@polyth/contracts";
import type { WebEventReducer } from "@polyth/web-sdk";

const reducers = new Map<string, Set<WebEventReducer>>();

export function registerWebReducer<State = unknown>(
  eventType: string,
  reducer: WebEventReducer<State>,
): () => void {
  if (!eventType.includes("/")) {
    throw new Error(`web reducer event type must be domain/past-tense: ${eventType}`);
  }
  const registered = reducer as WebEventReducer;
  const set = reducers.get(eventType) ?? new Set<WebEventReducer>();
  set.add(registered);
  reducers.set(eventType, set);
  return () => {
    const current = reducers.get(eventType);
    current?.delete(registered);
    if (current?.size === 0) reducers.delete(eventType);
  };
}

export function runWebReducers(state: unknown, event: SessionEvent): void {
  for (const reducer of [...(reducers.get(event.type) ?? [])]) {
    reducer(state, event);
  }
}
