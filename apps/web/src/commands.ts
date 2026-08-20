export interface PaletteCommand {
  id: string;
  label: string;
  /** Static string or live resolver — hints must track custom bindings (WP13). */
  hint?: string | (() => string);
  group?: string;
  /** Extra search terms (category synonyms, old names). */
  keywords?: string[];
  when?: () => boolean;
  /** Rendered as a checkmark (e.g. current sidebar grouping). */
  checked?: () => boolean;
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

/** Resolve a command's hint at render time so custom bindings show through. */
export function commandHint(cmd: PaletteCommand): string | undefined {
  if (typeof cmd.hint === "function") {
    try { return cmd.hint(); } catch { return undefined; }
  }
  return cmd.hint;
}

/** Case/diacritic fold for palette matching ("Café" → "cafe"). */
export function foldText(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function filterPalette(all: PaletteCommand[], q: string): PaletteCommand[] {
  const n = foldText(q.trim());
  if (!n) return all;
  return all.filter((c) => {
    if (foldText(c.label).includes(n) || c.id.toLowerCase().includes(n) || foldText(c.group ?? "").includes(n)) return true;
    if ((c.keywords ?? []).some((k) => foldText(k).includes(n))) return true;
    const hint = commandHint(c);
    return !!hint && foldText(hint).includes(n);
  });
}

export function runCommand(id: string): boolean {
  const c = cmds.get(id);
  if (!c || (c.when && !c.when())) return false;
  c.run();
  return true;
}
