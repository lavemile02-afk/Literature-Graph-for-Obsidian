import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approach, fitCamera, MAX_SCALE } from '../src/camera';
import { edgeIndices, INDICES_PER_EDGE, VERTICES_PER_EDGE, writeEdge } from '../src/edgeGeometry';

const vertex = (out: Float32Array, i: number, k: number) => [out[(i * VERTICES_PER_EDGE + k) * 2], out[(i * VERTICES_PER_EDGE + k) * 2 + 1]];

test('indexes two triangles and an arrowhead per edge', () => {
	const indices = edgeIndices(2);
	assert.equal(indices.length, 2 * INDICES_PER_EDGE);
	assert.deepEqual([...indices.slice(INDICES_PER_EDGE)], [7, 8, 9, 8, 10, 9, 11, 12, 13]);
});

test('draws a horizontal edge as a quad of the given width, and an arrow at the node', () => {
	const out = new Float32Array(VERTICES_PER_EDGE * 2);
	writeEdge(out, 0, { x1: 0, y1: 0, x2: 100, y2: 0, targetRadius: 10 }, 2, 4);
	assert.deepEqual(vertex(out, 0, 0), [0, 1]);
	assert.deepEqual(vertex(out, 0, 1), [0, -1]);
	// The line stops at the base of the arrow, which stops at the node's edge.
	const tip = 100 - 11;
	const base = tip - 4 * 1.6;
	assert.ok(Math.abs((vertex(out, 0, 2)[0] ?? 0) - base) < 1e-4);
	assert.deepEqual(vertex(out, 0, 4), [tip, 0]);
	assert.ok(Math.abs((vertex(out, 0, 5)[1] ?? 0) - 4) < 1e-4);
});

test('leaves the arrowhead out when hidden or when the edge is too short', () => {
	const out = new Float32Array(VERTICES_PER_EDGE * 2);
	writeEdge(out, 0, { x1: 0, y1: 0, x2: 100, y2: 0, targetRadius: 10 }, 1, 0);
	assert.deepEqual(vertex(out, 0, 4), vertex(out, 0, 5));
	assert.deepEqual(vertex(out, 0, 2), [100, 0.5]);
	writeEdge(out, 0, { x1: 0, y1: 0, x2: 12, y2: 0, targetRadius: 10 }, 1, 4);
	assert.deepEqual(vertex(out, 0, 5), vertex(out, 0, 6));
});

test('collapses an edge of zero length to a point', () => {
	const out = new Float32Array(VERTICES_PER_EDGE * 2);
	writeEdge(out, 0, { x1: 5, y1: 7, x2: 5, y2: 7, targetRadius: 3 }, 1, 4);
	for (let k = 0; k < VERTICES_PER_EDGE; k++) assert.deepEqual(vertex(out, 0, k), [5, 7]);
});

test('fits the nodes in the view, ignoring far outliers', () => {
	const nodes = Array.from({ length: 300 }, (_, i) => ({ x: (i % 20) * 10, y: Math.floor(i / 20) * 10, radius: 4 }));
	const fit = fitCamera(nodes, 800, 600);
	assert.ok(fit);
	const withOutlier = fitCamera([...nodes, { x: 100000, y: 0, radius: 4 }], 800, 600);
	assert.ok(withOutlier && Math.abs(withOutlier.scale - fit.scale) / fit.scale < 0.2);
	assert.equal(fitCamera([], 800, 600), null);
	// A single node is not zoomed in without end.
	assert.ok((fitCamera([{ x: 0, y: 0, radius: 4 }], 800, 600)?.scale ?? 0) <= MAX_SCALE);
});

test('moves the camera smoothly and arrives', () => {
	let cam = { x: 0, y: 0, scale: 1 };
	const goal = { x: 100, y: -50, scale: 4 };
	const first = approach(cam, goal, 0.2);
	assert.ok(first.x > 0 && first.x < 100 && first.scale > 1 && first.scale < 4);
	for (let i = 0; i < 200 && (cam.x !== goal.x || cam.scale !== goal.scale); i++) cam = approach(cam, goal, 0.2);
	assert.deepEqual(cam, goal);
});

test('hides the less important of two labels that overlap', async () => {
	const { placeLabels } = await import('../src/labels');
	const shown = placeLabels([
		{ x: 0, y: 0, width: 80, height: 14, priority: 1 },
		{ x: 40, y: 5, width: 80, height: 14, priority: 5 },
		{ x: 200, y: 0, width: 80, height: 14, priority: 0 },
		// Touching by a pixel is allowed.
		{ x: 119, y: 5, width: 50, height: 14, priority: 0 },
	]);
	assert.deepEqual(shown, [false, true, true, true]);
});
