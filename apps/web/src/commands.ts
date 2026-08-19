export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  group?: string;
  when?: () => boolean;
  run: () => void;
}

const cmds = new Map<string, PaletteCommand>();

export function registerCommand(cmd: PaletteCommand): () => void {
  cmds.set(cmd.id, cmd);
  return () => { cmds.delete(cmd.id); };
}

export function listCommands(): PaletteCommand[] {
  return [...cmds.values()].filter((c) => !c.when || c.when());
}

export function filterPalette(all: PaletteCommand[], q: string): PaletteCommand[] {
  const n = q.trim().toLowerCase();
  if (!n) return all;
  return all.filter((c) =>
    c.label.toLowerCase().includes(n) || c.id.toLowerCase().includes(n) || (c.group ?? "").toLowerCase().includes(n),
  );
}

export function runCommand(id: string): boolean {
  const c = cmds.get(id);
  if (!c || (c.when && !c.when())) return false;
  c.run();
  return true;
}
