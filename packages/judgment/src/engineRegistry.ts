import type { JudgmentEngineAdapter } from "./types.ts";

export class JudgmentEngineRegistry {
  #engines = new Map<string, JudgmentEngineAdapter>();
  register(engine: JudgmentEngineAdapter): () => void {
    if (!engine.id || engine.metadata.id !== engine.id || this.#engines.has(engine.id)) {
      throw new TypeError("Invalid or duplicate Judgment engine");
    }
    this.#engines.set(engine.id, engine);
    return () => { if (this.#engines.get(engine.id) === engine) this.#engines.delete(engine.id); };
  }
  get(id: string): JudgmentEngineAdapter | undefined { return this.#engines.get(id); }
  list(): JudgmentEngineAdapter[] { return [...this.#engines.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  defaultId(): string | undefined {
    const all = this.list();
    return all.find((engine) => engine.metadata.recommended)?.id ?? all[0]?.id;
  }
}
