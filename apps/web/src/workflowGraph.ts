import type { WorkflowDto } from "@polyth/contracts";

type Graph = Pick<WorkflowDto, "nodes" | "edges">;
export type WorkflowLayerResult =
  | { ok: true; layers: string[][] }
  | { ok: false; error: string };

/** Client preview of the server's Kahn-layer validation. */
export function layerizeWorkflow(graph: Graph): WorkflowLayerResult {
  if (graph.nodes.length === 0) return { ok: false, error: "workflow has no nodes" };
  const ids = new Set(graph.nodes.map((node) => node.id));
  if (ids.size !== graph.nodes.length || ids.has("")) {
    return { ok: false, error: "workflow node ids must be unique" };
  }
  const indegree = new Map([...ids].map((id) => [id, 0]));
  const outgoing = new Map([...ids].map((id) => [id, [] as string[]]));
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      return { ok: false, error: `edge ${edge.id} references a missing node` };
    }
    if (edge.source === edge.target) return { ok: false, error: "workflow contains a self-loop" };
    const key = `${edge.source}\u0000${edge.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }
  let frontier = [...ids].filter((id) => indegree.get(id) === 0).sort();
  const layers: string[][] = [];
  let placed = 0;
  while (frontier.length > 0) {
    layers.push(frontier);
    placed += frontier.length;
    const next: string[] = [];
    for (const id of frontier) {
      for (const target of outgoing.get(id) ?? []) {
        const remaining = (indegree.get(target) ?? 0) - 1;
        indegree.set(target, remaining);
        if (remaining === 0) next.push(target);
      }
    }
    frontier = next.sort();
  }
  return placed === ids.size
    ? { ok: true, layers }
    : { ok: false, error: "workflow contains a cycle" };
}

export function wouldWorkflowCycle(graph: Graph, source: string, target: string): boolean {
  if (source === target) return true;
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge.target);
    outgoing.set(edge.source, list);
  }
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === source) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(outgoing.get(id) ?? []));
  }
  return false;
}
