/** What a memory tool reported. The model reads `output` as plain lines; the
 * host gets ids and counts in `metadata`. */
export const told = (result: { output: string; metadata?: unknown }) => {
  const meta = (result.metadata ?? {}) as { memoryId?: string; status?: string; lifecycle?: string; ids?: string[]; total?: number; projectIds?: string[]; superseded?: string[] };
  return {
    output: result.output,
    /** A receipt's note for the agent travels in the same text. */
    message: result.output,
    memoryId: meta.memoryId ?? "",
    status: meta.status ?? "",
    lifecycle: meta.lifecycle ?? "",
    items: (meta.ids ?? []).map((id) => ({ id })),
    total: meta.total ?? 0,
    searchedProjects: (meta.projectIds ?? []).map((id) => ({ id })),
    superseded: meta.superseded ?? [],
  };
};
