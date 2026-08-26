// Commit-graph lane layout (WP7). Pure and DOM-free: rows in, lane geometry
// out. The renderer draws a dot per commit plus pass-through lines and edges
// to parent lanes; merges are simply commits with >1 parent edge.

export interface GraphInput {
  sha: string;
  parents: string[];
}

export interface GraphRow {
  sha: string;
  /** Lane index of this commit's dot. */
  lane: number;
  /** Lanes that continue straight through this row (excluding the dot lane). */
  through: number[];
  /** Edges from the dot to the lanes its parents occupy on the next row. */
  edges: number[];
  /** Total lane count at this row (for sizing). */
  width: number;
}

export function layoutGraph(commits: GraphInput[]): GraphRow[] {
  // lanes[i] = sha this lane expects to see next (or null when free).
  const lanes: Array<string | null> = [];
  const rows: GraphRow[] = [];

  for (const c of commits) {
    let lane = lanes.indexOf(c.sha);
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) {
        lanes.push(null);
        lane = lanes.length - 1;
      }
    }
    // Other lanes waiting for this same commit converge into the dot lane.
    for (let j = 0; j < lanes.length; j++) {
      if (j !== lane && lanes[j] === c.sha) lanes[j] = null;
    }

    // Continue-through lanes: everything active that is not this dot.
    const through: number[] = [];
    for (let j = 0; j < lanes.length; j++) {
      if (j !== lane && lanes[j] !== null) through.push(j);
    }

    // First parent inherits the dot's lane; extra parents fan out.
    const edges: number[] = [];
    lanes[lane] = c.parents[0] ?? null;
    if (c.parents[0]) edges.push(lane);
    for (const p of c.parents.slice(1)) {
      let target = lanes.indexOf(p);
      if (target === -1) {
        target = lanes.indexOf(null);
        if (target === -1) {
          lanes.push(null);
          target = lanes.length - 1;
        }
        lanes[target] = p;
      }
      edges.push(target);
    }

    // Trim trailing free lanes so width stays honest.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    rows.push({ sha: c.sha, lane, through, edges, width: Math.max(lanes.length, lane + 1) });
  }
  return rows;
}
