import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fibonacci, IDLE_ANIMATIONS, IdleAnimation, keepsEdges, placeWork, setUpAnimation, signals } from '../src/animations';
import { fitSphere } from '../src/sphere';

const points = Array.from({ length: 300 }, (_, i) => ({ x: 400 * Math.cos(i * 2.4) * Math.sqrt(i / 300), y: 400 * Math.sin(i * 2.4) * Math.sqrt(i / 300) }));
const sphere = fitSphere(points);
const setup = setUpAnimation(points, sphere, (i) => i % 7);

test('spreads points evenly on the unit sphere', () => {
	const n = 500;
	let sum = 0;
	for (let i = 0; i < n; i++) {
		const [x, y, z] = fibonacci(i, n);
		assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-9);
		sum += y;
	}
	// As many points above the equator as below.
	assert.ok(Math.abs(sum / n) < 1e-9);
});

test('gives the works at the center of the graph the top of the globe', () => {
	const center = points.reduce((best, p, i) => (Math.hypot(p.x, p.y) < Math.hypot(points[best]!.x, points[best]!.y) ? i : best), 0);
	assert.ok((setup.lattice[center * 3 + 1] ?? 0) > 0.9);
});

test('places every work of every animation on screen, near the shape', () => {
	for (const animation of Object.keys(IDLE_ANIMATIONS) as IdleAnimation[]) {
		for (const t of [0, 1.3, 17.9, 250]) {
			points.forEach((p, i) => {
				const placed = placeWork(animation, setup, i, p.x, p.y, t);
				for (const value of [placed.x, placed.y, placed.scale, placed.front]) assert.ok(Number.isFinite(value), `${animation} at ${t}`);
				assert.ok(placed.front >= 0 && placed.front <= 1, `${animation}: front ${placed.front}`);
				// Within a few sphere radii of the center.
				assert.ok(Math.hypot(placed.x - sphere.cx, placed.y - sphere.cy) < sphere.radius * 3, `${animation} too far`);
			});
		}
	}
});

test('moves the works over time', () => {
	for (const animation of ['drift', 'globe', 'orbits', 'wave', 'braid', 'ribbon', 'constellation'] as IdleAnimation[]) {
		const a = placeWork(animation, setup, 5, points[5]!.x, points[5]!.y, 2);
		const b = placeWork(animation, setup, 5, points[5]!.x, points[5]!.y, 4);
		assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 1e-6, animation);
	}
});

test('keeps the citation lines only where they belong to the animation', () => {
	assert.ok(keepsEdges('sphere') && keepsEdges('constellation'));
	assert.ok(!keepsEdges('drift') && !keepsEdges('orbits'));
});

test('runs signals along existing citations', () => {
	const list = signals(40, 12, 3.7);
	assert.equal(list.length, 40);
	for (const s of list) {
		assert.ok(Number.isInteger(s.link) && s.link >= 0 && s.link < 12);
		assert.ok(s.along >= 0 && s.along < 1);
	}
	assert.deepEqual(signals(5, 0, 1), []);
});
