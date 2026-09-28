/**
 * Geometry of the graph's edges, for one mesh drawn in a single call: each
 * edge is a thin quad (a line of the given width) and a triangle (its
 * arrowhead), so thousands of edges cost one buffer update per frame instead
 * of one path each.
 */

/** Vertices per edge: four for the line, three for the arrowhead. */
export const VERTICES_PER_EDGE = 7;
/** Indices per edge: two triangles for the line, one for the arrowhead. */
export const INDICES_PER_EDGE = 9;

/** The triangles of `count` edges; they never change while the edges stay the same. */
export function edgeIndices(count: number): Uint32Array {
	const indices = new Uint32Array(count * INDICES_PER_EDGE);
	for (let i = 0; i < count; i++) {
		const v = i * VERTICES_PER_EDGE;
		indices.set([v, v + 1, v + 2, v + 1, v + 3, v + 2, v + 4, v + 5, v + 6], i * INDICES_PER_EDGE);
	}
	return indices;
}

/** Where an edge goes: from its citing work to the edge of its cited work. */
export interface EdgeEnds {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	/** Radius of the cited work's node, where the arrow stops. */
	targetRadius: number;
}

/**
 * Writes the vertices of edge `i` into `out` (x, y pairs). With `arrow` 0 the
 * arrowhead is left out (its triangle has no area) and the line goes to the
 * node's center, hidden under the node.
 */
export function writeEdge(out: Float32Array, i: number, e: EdgeEnds, width: number, arrow: number): void {
	const o = i * VERTICES_PER_EDGE * 2;
	const dx = e.x2 - e.x1;
	const dy = e.y2 - e.y1;
	const len = Math.hypot(dx, dy);
	if (len < 1e-6) {
		out.fill(e.x1, o, o + VERTICES_PER_EDGE * 2);
		for (let k = 1; k < VERTICES_PER_EDGE * 2; k += 2) out[k] = e.y1;
		return;
	}
	const ux = dx / len;
	const uy = dy / len;
	const hw = width / 2;
	const nx = -uy * hw;
	const ny = ux * hw;
	// An arrowhead only when there is room for it outside the node.
	const withArrow = arrow > 0 && len > e.targetRadius + arrow * 1.5;
	let ex = e.x2;
	let ey = e.y2;
	let tipX = e.x2;
	let tipY = e.y2;
	if (withArrow) {
		tipX = e.x2 - ux * (e.targetRadius + 1);
		tipY = e.y2 - uy * (e.targetRadius + 1);
		ex = tipX - ux * arrow * 1.6;
		ey = tipY - uy * arrow * 1.6;
	}
	out[o] = e.x1 + nx;
	out[o + 1] = e.y1 + ny;
	out[o + 2] = e.x1 - nx;
	out[o + 3] = e.y1 - ny;
	out[o + 4] = ex + nx;
	out[o + 5] = ey + ny;
	out[o + 6] = ex - nx;
	out[o + 7] = ey - ny;
	out[o + 8] = tipX;
	out[o + 9] = tipY;
	if (withArrow) {
		out[o + 10] = ex - uy * arrow;
		out[o + 11] = ey + ux * arrow;
		out[o + 12] = ex + uy * arrow;
		out[o + 13] = ey - ux * arrow;
	} else {
		out[o + 10] = tipX;
		out[o + 11] = tipY;
		out[o + 12] = tipX;
		out[o + 13] = tipY;
	}
}
