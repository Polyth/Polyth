import type { WorkflowDto, WorkflowNodeDto } from "@polyth/contracts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

type Graph = Pick<WorkflowDto, "nodes" | "edges">;
export type WorkflowLayerResult =
  | { ok: true; layers: string[][] }
  | { ok: false; error: string };

export type WorkflowEditorNode = WorkflowNodeDto & {
  /** Replica count is presentation metadata; replicas remain explicit DAG nodes. */
  replicas?: number;
};

export type WorkflowCanvasNode = WorkflowEditorNode & {
  layer: number;
  order: number;
  width: number;
};

export type WorkflowInsertPlacement = "before" | "after" | "parallel";

/** Client preview of the server's Kahn-layer validation. */
export function layerizeWorkflow(graph: Graph): WorkflowLayerResult {
  if (graph.nodes.length === 0)
    return { ok: false, error: tr("workflowgraph.noNodes") };
  const ids = new Set(graph.nodes.map((node) => node.id));
  if (ids.size !== graph.nodes.length || ids.has("")) {
    return { ok: false, error: tr("workflowgraph.nodeIdsMustBeUnique") };
  }
  const indegree = new Map([...ids].map((id) => [id, 0]));
  const outgoing = new Map([...ids].map((id) => [id, [] as string[]]));
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      return {
        ok: false,
        error: tr("workflowgraph.edgeReferencesMissingNode", { id: edge.id }),
      };
    }
    if (edge.source === edge.target)
      return { ok: false, error: tr("workflowgraph.selfLoop") };
    const key = `${edge.source}\u0000${edge.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }
  const ordered = graph.nodes.some((node) => node.position);
  const order = new Map(
    graph.nodes.map((node, index) => [node.id, node.position?.x ?? index])
  );
  const stableSort = (values: string[]) =>
    values.sort((a, b) =>
      ordered
        ? (order.get(a) ?? 0) - (order.get(b) ?? 0) || a.localeCompare(b)
        : a.localeCompare(b)
    );
  let frontier = stableSort([...ids].filter((id) => indegree.get(id) === 0));
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
    frontier = stableSort(next);
  }
  return placed === ids.size
    ? { ok: true, layers }
    : { ok: false, error: tr("workflowgraph.cycle") };
}

export function wouldWorkflowCycle(
  graph: Graph,
  source: string,
  target: string
): boolean {
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

/** Stable, dependency-aware coordinates for the desktop topology preview. */
export function layoutWorkflow(
  graph: Graph,
  width = 720
): WorkflowCanvasNode[] {
  const result = layerizeWorkflow(graph);
  if (!result.ok) return [];
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const gap = 24;
  const columnWidth = Math.max(148, Math.min(220, (width - gap) / 3));
  return result.layers.flatMap((layer, layerIndex) => {
    return layer.map((id, order) => ({
      ...(byId.get(id) as WorkflowEditorNode),
      layer: layerIndex,
      order,
      width: columnWidth,
      position: {
        x: layerIndex * (columnWidth + gap),
        y: order * 108,
      },
    }));
  });
}

export function addWorkflowEdge(
  graph: Graph,
  source: string,
  target: string,
  id: string
): Graph {
  if (source === target || wouldWorkflowCycle(graph, source, target))
    return graph;
  if (
    graph.edges.some((edge) => edge.source === source && edge.target === target)
  )
    return graph;
  return { ...graph, edges: [...graph.edges, { id, source, target }] };
}

/** Remove a node and reconnect its immediate predecessors to successors. */
export function removeWorkflowNode(
  graph: Graph,
  nodeId: string,
  edgeId: (source: string, target: string) => string
): Graph {
  const incoming = graph.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => edge.source);
  const outgoing = graph.edges
    .filter((edge) => edge.source === nodeId)
    .map((edge) => edge.target);
  const retained = graph.edges.filter(
    (edge) => edge.source !== nodeId && edge.target !== nodeId
  );
  const next = {
    ...graph,
    nodes: graph.nodes.filter((node) => node.id !== nodeId),
    edges: retained,
  };
  for (const source of incoming)
    for (const target of outgoing) {
      const withEdge = addWorkflowEdge(
        next,
        source,
        target,
        edgeId(source, target)
      );
      next.edges = withEdge.edges;
    }
  return next;
}

/** Remove one repeated worker without reconnecting its sibling stage. */
export function removeWorkflowReplica(graph: Graph, nodeId: string): Graph {
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => node.id !== nodeId),
    edges: graph.edges.filter(
      (edge) => edge.source !== nodeId && edge.target !== nodeId
    ),
  };
}

/** Resize a presentation group while keeping every replica an ordinary DAG node. */
export function resizeWorkflowGroup(
  graph: Graph,
  group: string,
  count: number,
  nodeId: () => string,
  edgeId: (source: string, target: string) => string
): Graph {
  const members = graph.nodes.filter((node) => node.group === group);
  if (!members.length || count < 1) return graph;
  let next: Graph = { ...graph, nodes: [...graph.nodes], edges: [...graph.edges] };
  while (members.length > count) {
    const removable = [...next.nodes].reverse().find((node) => node.group === group);
    if (!removable) break;
    next = removeWorkflowReplica(next, removable.id);
    members.pop();
  }
  while (members.length < count) {
    const source = next.nodes.find((node) => node.group === group);
    if (!source) break;
    const replica: WorkflowNodeDto = { ...source, id: nodeId() };
    next.nodes = [...next.nodes, replica];
    const incoming = next.edges.filter((edge) => edge.target === source.id);
    const outgoing = next.edges.filter((edge) => edge.source === source.id);
    for (const edge of incoming) {
      next = addWorkflowEdge(next, edge.source, replica.id, edgeId(edge.source, replica.id));
    }
    for (const edge of outgoing) {
      next = addWorkflowEdge(next, replica.id, edge.target, edgeId(replica.id, edge.target));
    }
    members.push(replica);
  }
  return next;
}

/** Insert a node around an existing node while preserving the dependency roles. */
export function insertWorkflowNode(
  graph: Graph,
  node: WorkflowNodeDto,
  anchorId: string | undefined,
  placement: WorkflowInsertPlacement,
  edgeId: (source: string, target: string) => string
): Graph {
  if (!anchorId || !graph.nodes.some((candidate) => candidate.id === anchorId)) {
    return { ...graph, nodes: [...graph.nodes, node] };
  }
  const incoming = graph.edges
    .filter((edge) => edge.target === anchorId)
    .map((edge) => edge.source);
  const outgoing = graph.edges
    .filter((edge) => edge.source === anchorId)
    .map((edge) => edge.target);
  let edges = graph.edges;
  if (placement === "before") {
    edges = edges.filter((edge) => edge.target !== anchorId);
  } else if (placement === "after") {
    edges = edges.filter((edge) => edge.source !== anchorId);
  }
  let next: Graph = { ...graph, nodes: [...graph.nodes], edges };
  if (placement === "before") {
    next = addWorkflowEdge(next, node.id, anchorId, edgeId(node.id, anchorId));
    for (const source of incoming) {
      next = addWorkflowEdge(next, source, node.id, edgeId(source, node.id));
    }
  } else if (placement === "after") {
    next = addWorkflowEdge(next, anchorId, node.id, edgeId(anchorId, node.id));
    for (const target of outgoing) {
      next = addWorkflowEdge(next, node.id, target, edgeId(node.id, target));
    }
  } else {
    for (const source of incoming) {
      next = addWorkflowEdge(next, source, node.id, edgeId(source, node.id));
    }
    for (const target of outgoing) {
      next = addWorkflowEdge(next, node.id, target, edgeId(node.id, target));
    }
  }
  const anchorIndex = next.nodes.findIndex((candidate) => candidate.id === anchorId);
  const insertIndex = placement === "before" ? anchorIndex : anchorIndex + 1;
  next.nodes = [
    ...next.nodes.slice(0, insertIndex),
    node,
    ...next.nodes.slice(insertIndex),
  ];
  return next;
}

/** Move a node relative to its visible neighbor and update the DAG edges. */
export function moveWorkflowNode(
  graph: Graph,
  nodeId: string,
  direction: -1 | 1,
  edgeId: (source: string, target: string) => string
): Graph {
  const index = graph.nodes.findIndex((node) => node.id === nodeId);
  const target = graph.nodes[index + direction];
  if (index < 0 || !target) return graph;
  const node = graph.nodes[index]!;
  const without = removeWorkflowNode(graph, nodeId, edgeId);
  return insertWorkflowNode(
    without,
    node,
    target.id,
    direction < 0 ? "before" : "after",
    edgeId
  );
}

export function reorderWorkflowNodes(
  graph: Graph,
  orderedIds: string[]
): Graph {
  const rank = new Map(orderedIds.map((id, index) => [id, index]));
  return {
    ...graph,
    nodes: [...graph.nodes]
      .sort(
        (a, b) =>
          (rank.get(a.id) ?? graph.nodes.length) -
          (rank.get(b.id) ?? graph.nodes.length)
      )
      .map((node, index) => ({
        ...node,
        position: { ...(node.position ?? { x: 0, y: 0 }), x: index },
      })),
  };
}

export function groupWorkflowNodes(
  graph: Graph
): Array<{ group: string; nodes: WorkflowNodeDto[] }> {
  const grouped = new Map<string, WorkflowNodeDto[]>();
  for (const node of graph.nodes) {
    const group = (node as WorkflowEditorNode).group;
    if (!group) continue;
    const list = grouped.get(group) ?? [];
    list.push(node);
    grouped.set(group, list);
  }
  const neighbours = (id: string) => JSON.stringify([
    graph.edges.filter((edge) => edge.target === id).map((edge) => edge.source).sort(),
    graph.edges.filter((edge) => edge.source === id).map((edge) => edge.target).sort(),
  ]);
  return [...grouped]
    // A shared label alone cannot collapse different dependency stages into
    // one card. Keep irregular imported/custom graphs explicitly visible.
    .filter(([, nodes]) => nodes.every((node) => neighbours(node.id) === neighbours(nodes[0]!.id)))
    .map(([group, nodes]) => ({ group, nodes }));
}
