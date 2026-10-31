/** Find state is presentation-only and belongs to one package activation. */
export function createFindController() {
  let target: { sessionId: string; focus: number } | null = null;
  const listeners = new Set<() => void>();
  // Several mounted surfaces (the composer slot, each placed widget) can host
  // the dialog; only the longest-mounted one renders it so it never doubles.
  const hosts: object[] = [];
  const emit = () => { for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => target,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    open(sessionId: string) { target = { sessionId, focus: (target?.focus ?? 0) + 1 }; emit(); },
    close() { target = null; emit(); },
    attach(token: object) {
      hosts.push(token);
      emit();
      return () => { const at = hosts.indexOf(token); if (at >= 0) hosts.splice(at, 1); emit(); };
    },
    isPrimary: (token: object) => hosts[0] === token,
    dispose() { target = null; hosts.length = 0; listeners.clear(); },
  };
}
export type FindController = ReturnType<typeof createFindController>;
