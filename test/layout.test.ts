import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LayoutLoop, LayoutMessage, LayoutUpdate } from '../src/layout';

/** Timers run by hand: `run` fires the pending callbacks. */
function fakeTimers() {
	let next = 1;
	const pending = new Map<number, () => void>();
	return {
		timers: {
			setTimeout: (fn: () => void) => {
				pending.set(next, fn);
				return next++;
			},
			clearTimeout: (id: number) => void pending.delete(id),
			now: () => 0,
		},
		run(times = 1): void {
			for (let i = 0; i < times; i++) {
				const callbacks = [...pending.values()];
				pending.clear();
				callbacks.forEach((fn) => fn());
			}
		},
		get pending() {
			return pending.size;
		},
	};
}

const start = (graph: number): LayoutMessage => ({
	type: 'start',
	graph,
	nodes: [
		{ depth: 0, radius: 5 },
		{ depth: 0, radius: 5 },
		{ depth: 1, radius: 3 },
	],
	links: [
		{ source: 0, target: 1, inVault: true },
		{ source: 0, target: 2, inVault: false },
	],
	forces: { repel: 90, linkDistance: 60, center: 0.05, meaning: 1 },
	alpha: 1,
});

test('sends positions after each step until the layout settles, then stops', () => {
	const updates: LayoutUpdate[] = [];
	const clock = fakeTimers();
	const loop = new LayoutLoop((u) => updates.push(u), clock.timers);
	loop.handle(start(7));
	clock.run(1000);
	assert.ok(updates.length > 20 && updates.length < 1000, `${updates.length} steps`);
	assert.equal(updates.at(-1)?.moving, false);
	assert.equal(updates.at(-1)?.graph, 7);
	assert.equal(updates.at(-1)?.positions.length, 6);
	assert.equal(clock.pending, 0);
	// Linked works end up about a link's distance apart.
	const p = updates.at(-1)?.positions ?? new Float32Array(6);
	const d = Math.hypot((p[0] ?? 0) - (p[2] ?? 0), (p[1] ?? 0) - (p[3] ?? 0));
	assert.ok(d > 20 && d < 200, `distance ${d}`);
});

test('keeps a dragged node where it is put, and moves again while dragging', () => {
	const updates: LayoutUpdate[] = [];
	const clock = fakeTimers();
	const loop = new LayoutLoop((u) => updates.push(u), clock.timers);
	loop.handle(start(1));
	clock.run(1000);
	loop.handle({ type: 'drag', index: 1, x: 500, y: -300 });
	clock.run(50);
	const last = updates.at(-1);
	assert.equal(last?.moving, true);
	assert.deepEqual([last?.positions[2], last?.positions[3]], [500, -300]);
	loop.handle({ type: 'release', index: 1 });
	clock.run(1000);
	assert.equal(updates.at(-1)?.moving, false);
});

test('stops for good on "stop"', () => {
	const updates: LayoutUpdate[] = [];
	const clock = fakeTimers();
	const loop = new LayoutLoop((u) => updates.push(u), clock.timers);
	loop.handle(start(1));
	clock.run(3);
	loop.handle({ type: 'stop' });
	const count = updates.length;
	clock.run(10);
	loop.handle({ type: 'reheat', alpha: 1 });
	clock.run(10);
	assert.equal(updates.length, count);
});

test('freezes once nothing moves visibly, before the end of the cooling, and moves again when asked', () => {
	const updates: LayoutUpdate[] = [];
	const clock = fakeTimers();
	const loop = new LayoutLoop((u) => updates.push(u), clock.timers);
	loop.handle(start(1));
	clock.run(1000);
	assert.equal(updates.at(-1)?.moving, false);
	// d3 cools in about 300 steps from alpha 1; a still graph stops before.
	const steps = updates.length;
	assert.ok(steps < 300, `${steps} steps`);
	// The last steps barely moved anything.
	const a = updates.at(-2)?.positions ?? new Float32Array(6);
	const b = updates.at(-1)?.positions ?? new Float32Array(6);
	assert.ok(a.every((x, i) => Math.abs(x - (b[i] ?? 0)) < 0.05));
	// Changing a force starts it again.
	loop.handle({ type: 'forces', forces: { repel: 200, linkDistance: 120, center: 0.05, meaning: 1 } });
	clock.run(1);
	assert.equal(updates.at(-1)?.moving, true);
	clock.run(1000);
	assert.equal(updates.at(-1)?.moving, false);
});
