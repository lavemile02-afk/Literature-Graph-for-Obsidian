import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignTo, blendWithNeighbors, centered, mapOfMeaning, meaningTree, nearestVectors, normalized, packVector, placeAmong, radialDendrogram, unpackVector, withoutLines } from '../src/meaningMap';

const v = (...xs: number[]) => normalized(xs) as Float32Array;

test('blends a work with the meaning of the works it is linked to', () => {
	const own = v(1, 0, 0);
	const blended = blendWithNeighbors(own, [v(0, 1, 0), v(0, 1, 0)]);
	assert.ok(blended && Math.abs((blended[0] ?? 0) - (blended[1] ?? 0)) < 1e-6);
	// No text of its own: the meaning of its neighbors.
	assert.deepEqual(Array.from(blendWithNeighbors(null, [v(0, 0, 1)]) ?? []), [0, 0, 1]);
	assert.equal(blendWithNeighbors(own, []), own);
});

test('finds the nearest vectors', async () => {
	const near = await nearestVectors([v(1, 0), v(0.9, 0.1), v(0, 1), v(0.1, 0.9)], 1);
	assert.deepEqual(near.map((l) => l[0]?.[0]), [1, 0, 3, 2]);
});

test('maps two groups of meaning apart, the same way each time', async () => {
	const vectors: Float32Array[] = [];
	for (let i = 0; i < 40; i++) vectors.push(v(1, 0.05 * (i % 7), 0.01 * i, 0));
	for (let i = 0; i < 40; i++) vectors.push(v(0, 0.01 * i, 0.05 * (i % 5), 1));
	const a = await mapOfMeaning(vectors);
	const b = await mapOfMeaning(vectors);
	assert.deepEqual(a, b);
	const mean = (from: number) => {
		const part = a.slice(from, from + 40);
		return [part.reduce((s, p) => s + p[0], 0) / 40, part.reduce((s, p) => s + p[1], 0) / 40];
	};
	const [x1, y1] = mean(0);
	const [x2, y2] = mean(40);
	const spread = Math.sqrt(a.slice(0, 40).reduce((s, p) => s + (p[0] - (x1 ?? 0)) ** 2 + (p[1] - (y1 ?? 0)) ** 2, 0) / 40);
	assert.ok(Math.hypot((x1 ?? 0) - (x2 ?? 0), (y1 ?? 0) - (y2 ?? 0)) > 3 * spread);
});

test('turns a new map to match the previous one', () => {
	const old = centered([[0, 0], [1, 0], [0, 2], [3, 1]]);
	const turned = old.map(([x, y]): [number, number] => [-y, x]);
	const mirrored = old.map(([x, y]): [number, number] => [x, -y]);
	for (const moved of [turned, mirrored]) {
		const back = alignTo(moved, old);
		back.forEach((p, i) => assert.ok(Math.hypot(p[0] - (old[i]?.[0] ?? 0), p[1] - (old[i]?.[1] ?? 0)) < 1e-9));
	}
});

test('places a work among its nearest works of the corpus', () => {
	const corpus = [v(1, 0), v(0, 1)];
	const places: [number, number][] = [[-5, 0], [5, 0]];
	assert.deepEqual(placeAmong(v(1, 0.01), corpus, places)?.map(Math.round), [-5, 0]);
});

test('packs a vector of meaning in a short string', () => {
	const vector = v(0.3, -0.5, 0.1, 0.8);
	const back = unpackVector(packVector(vector)) ?? new Float32Array(4);
	vector.forEach((x, i) => assert.ok(Math.abs(x - (back[i] ?? 0)) < 0.01));
});

test('grows a tree of the most alike works', () => {
	const vectors = [v(1, 0), v(0.95, 0.05), v(0.9, 0.1), v(0, 1), v(0.05, 0.95)];
	const all = vectors.map((_, i) => vectors.map((__, j) => j).filter((j) => j !== i));
	const tree = meaningTree(vectors, all, 2);
	assert.equal(tree.length, 4);
	const links = new Set(tree.map(([a, b]) => [a, b].sort().join('-')));
	assert.ok(links.has('0-1') && links.has('1-2') && links.has('3-4'));
});

test('leaves the reference lists out of a note', () => {
	const text = ['# Title', 'Peat holds water.', '', '## References', 'Price, J. (2003). A.', 'Smith, B. (2001). B,', 'cut in two.', 'Waddington, J. (2015). C.', '', '## Annex', 'More text.'].join('\n');
	assert.equal(withoutLines(text, [4, 5, 7]), ['# Title', 'Peat holds water.', '', '## References', '', '## Annex', 'More text.'].join('\n'));
});

test('draws a radial dendrogram: groups, subgroups, then works on a circle', () => {
	const places: [number, number][] = [[1, 0], [1, 0.1], [0, 1], [0.1, 1], [-1, 0]];
	const group = [0, 0, 1, 1, 2];
	const d = radialDendrogram(places, group, 3, (works) => [works], 10, 2);
	// Every work on the circle.
	for (const p of d.places) assert.ok(p && Math.abs(Math.hypot(p[0], p[1]) - d.radius) < 1e-9);
	// Three groups from the middle, three subgroups, five works.
	assert.equal(d.hubs.filter((h) => h.level === 1).length, 3);
	assert.equal(d.links.filter((l) => l.from === -1).length, 3);
	assert.equal(d.links.filter((l) => l.work).length, 5);
	// Works of one group are side by side on the circle.
	const angle = (i: number) => Math.atan2(d.places[i]?.[1] ?? 0, d.places[i]?.[0] ?? 0);
	assert.ok(Math.abs(angle(0) - angle(1)) < Math.abs(angle(0) - angle(2)));
});
