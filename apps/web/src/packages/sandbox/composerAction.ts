const pending = new Map<string, string>();
const deliverers = new Map<string, (actionId: string) => boolean>();

function keyOf(pluginId: string, surfaceId: string): string {
  return `${pluginId}::${surfaceId}`;
}

export function registerComposerActionDeliverer(
  pluginId: string,
  surfaceId: string,
  deliver: (actionId: string) => boolean,
): () => void {
  const key = keyOf(pluginId, surfaceId);
  deliverers.set(key, deliver);
  return () => {
    if (deliverers.get(key) === deliver) deliverers.delete(key);
  };
}

/** Request a composer action; if the port is not ready yet, keep only the latest action per surface. */
export function requestComposerAction(pluginId: string, actionId: string, surfaceId: string): void {
  const deliver = deliverers.get(keyOf(pluginId, surfaceId));
  if (deliver?.(actionId)) return;
  pending.set(keyOf(pluginId, surfaceId), actionId);
}

export function takePendingComposerAction(pluginId: string, surfaceId: string): string | undefined {
  const key = keyOf(pluginId, surfaceId);
  const actionId = pending.get(key);
  pending.delete(key);
  return actionId;
}

export function clearPackageComposerActions(packageId: string): void {
  const prefix = `${packageId}::`;
  for (const key of [...pending.keys()]) {
    if (key.startsWith(prefix)) pending.delete(key);
  }
  for (const key of [...deliverers.keys()]) {
    if (key.startsWith(prefix)) deliverers.delete(key);
  }
}
