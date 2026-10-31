import type { WorkflowDto } from "@polyth/contracts";

export type WorkflowGraph = Pick<WorkflowDto, "nodes" | "edges">;
export type LayerResult =
  | { ok: true; layers: string[][] }
  | { ok: false; error: string };

/** Kahn's algorithm, grouped into layers that can execute concurrently. */
export function layerize(graph: WorkflowGraph): LayerResult {
  if (graph.nodes.length === 0) return { ok: false, error: "workflow has no nodes" };

  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.id.trim()) return { ok: false, error: "workflow node id is required" };
    if (ids.has(node.id)) return { ok: false, error: `duplicate workflow node id ${node.id}` };
    ids.add(node.id);
  }

  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    outgoing.set(id, []);
  }

  const seenEdges = new Set<string>();
  for (const edge of graph.edges) {
    if (!ids.has(edge.source)) return { ok: false, error: `edge ${edge.id} has unknown source ${edge.source}` };
    if (!ids.has(edge.target)) return { ok: false, error: `edge ${edge.id} has unknown target ${edge.target}` };
    if (edge.source === edge.target) return { ok: false, error: `edge ${edge.id} is a self-loop` };
    const key = `${edge.source}\u0000${edge.target}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }

  const layers: string[][] = [];
  let frontier = [...ids].filter((id) => indegree.get(id) === 0).sort();
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

/** True when adding source -> target would close a cycle. */
export function wouldCycle(graph: WorkflowGraph, source: string, target: string): boolean {
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

export function upstream(graph: WorkflowGraph, id: string): string[] {
  return [...new Set(graph.edges.filter((edge) => edge.target === id).map((edge) => edge.source))];
}

/** Every node that can reach id, excluding id itself. */
export function ancestors(graph: WorkflowGraph, id: string): Set<string> {
  const found = new Set<string>();
  const stack = upstream(graph, id);
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (found.has(next)) continue;
    found.add(next);
    stack.push(...upstream(graph, next));
  }
  return found;
}
