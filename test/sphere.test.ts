import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appearanceOrder, fitSphere, projectOnSphere } from '../src/sphere';

const ring = (r: number, n = 36) => Array.from({ length: n }, (_, i) => ({ x: 100 + r * Math.cos((2 * Math.PI * i) / n), y: 50 + r * Math.sin((2 * Math.PI * i) / n) }));

test('centers the sphere on the graph', () => {
	const sphere = fitSphere([...ring(300), { x: 100, y: 50 }]);
	assert.ok(Math.abs(sphere.cx - 100) < 1e-6 && Math.abs(sphere.cy - 50) < 1e-6);
	assert.ok(sphere.radius > 100 && sphere.radius < 300);
});

test('spreads the works evenly over the sphere, however dense the center', () => {
	// A dense core and a sparse ring: half the works each.
	const points = [...ring(20, 50), ...ring(400, 50)];
	const sphere = fitSphere(points);
	const fronts = points.map((p) => projectOnSphere(p.x, p.y, sphere, 0).front);
	const inFront = fronts.filter((f) => f > 0.5).length;
	// About half the works on the front half, not all of them.
	assert.ok(inFront > 30 && inFront < 70, `${inFront} of 100 in front`);
});

test('shows the graph center in front, and the far points around the back', () => {
	const sphere = fitSphere(ring(300));
	const center = projectOnSphere(100, 50, sphere, 0);
	const edge = projectOnSphere(400, 50, sphere, 0);
	assert.ok(center.front > 0.9, `center in front: ${center.front}`);
	assert.ok(edge.front < 0.3, `edge at the back: ${edge.front}`);
	// Nearer points look bigger.
	assert.ok(center.scale > edge.scale);
});

test('turning the sphere half a turn brings the back to the front', () => {
	const sphere = fitSphere(ring(300));
	const before = projectOnSphere(100, 50, sphere, 0);
	const after = projectOnSphere(100, 50, sphere, Math.PI);
	assert.ok(after.front < before.front - 0.5);
	// Every projected point stays within the sphere's disc on screen (with perspective).
	for (const p of ring(300)) {
		for (const angle of [0, 1, 2, 3]) {
			const q = projectOnSphere(p.x, p.y, sphere, angle);
			assert.ok(Math.hypot(q.x - sphere.cx, q.y - sphere.cy) <= sphere.radius * 1.5);
		}
	}
});

test('shows the works of the vault first, then the others oldest first', () => {
	const rank = appearanceOrder([
		{ depth: 1, year: 2010, citedBy: 3 },
		{ depth: 0, year: 2020, citedBy: 1 },
		{ depth: 1, year: 1990, citedBy: 1 },
		{ depth: 0, year: 2001, citedBy: 9 },
		{ depth: 2, year: 1950, citedBy: 1 },
		{ depth: 1, year: null, citedBy: 5 },
	]);
	assert.deepEqual(rank, [3, 1, 2, 0, 5, 4]);
});
