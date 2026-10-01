import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LayoutLink, LayoutNode } from '../src/layout';
import {
	circlePlaces,
	circleRadius,
	createChronologicalSimulation,
	createCircleSimulation,
	createIslandsSimulation,
	createLayersSimulation,
	createMeaningSimulation,
	detectCommunities,
	islandCenters,
	yearScale,
} from '../src/shapes';

const forces = { repel: 90, linkDistance: 60, center: 0.02, meaning: 1 };

/** Two dense groups of works joined by a single citation. */
function twoGroups(): { nodes: LayoutNode[]; links: LayoutLink[] } {
	const nodes: LayoutNode[] = Array.from({ length: 20 }, (_, i) => ({ depth: i % 10 === 0 ? 0 : 1, radius: 3, year: 1990 + i, x: (i * 37) % 50, y: (i * 53) % 50 }));
	const links: LayoutLink[] = [];
	for (const base of [0, 10]) for (let a = base; a < base + 10; a++) for (let b = a + 1; b < base + 10; b++) links.push({ source: a, target: b, inVault: false });
	links.push({ source: 3, target: 13, inVault: false });
	return { nodes, links };
}

const run = (sim: { tick: (n?: number) => unknown }) => sim.tick(400);

test('finds the communities of a graph', () => {
	const { links } = twoGroups();
	const community = detectCommunities(20, links.map((l) => [l.source as number, l.target as number]));
	for (let i = 1; i < 10; i++) assert.equal(community[i], community[0]);
	for (let i = 11; i < 20; i++) assert.equal(community[i], community[10]);
	assert.notEqual(community[0], community[10]);
	// Works without any link are communities of their own.
	assert.deepEqual([...detectCommunities(3, [])].sort(), [0, 1, 2]);
});

test('places the largest island in the middle and the others apart', () => {
	const centers = islandCenters([100, 20, 20]);
	assert.deepEqual(centers[0], { x: 0, y: 0 });
	const d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
	const [a, b, c] = centers;
	assert.ok(a && b && c && d(a, b) > 200 && d(b, c) > 100);
});

test('spreads the years so that each stretch holds as many works', () => {
	const years = [1700, 1990, 1995, 2000, 2005, 2010, 2015, 2020];
	const x = yearScale(years, 800);
	assert.ok(x(1700) < x(1990) && x(1990) < x(2020));
	// One old work does not take most of the width.
	assert.ok(x(1990) - x(1700) < (x(2020) - x(1700)) / 3);
	assert.ok(Math.abs(x(2005) - (x(2000) + x(2010)) / 2) < 1);
	assert.equal(yearScale([], 800)(2000), 0);
});

test('lays the works out by year in the chronological layout', () => {
	const { nodes, links } = twoGroups();
	run(createChronologicalSimulation(nodes, links, forces));
	const early = nodes.slice(0, 5).reduce((s, n) => s + (n.x ?? 0), 0) / 5;
	const late = nodes.slice(15).reduce((s, n) => s + (n.x ?? 0), 0) / 5;
	assert.ok(early < late - 300, `${early} < ${late}`);
});

test('keeps the islands apart', () => {
	const { nodes, links } = twoGroups();
	run(createIslandsSimulation(nodes, links, forces));
	const center = (from: number) => {
		const group = nodes.slice(from, from + 10);
		return { x: group.reduce((s, n) => s + (n.x ?? 0), 0) / 10, y: group.reduce((s, n) => s + (n.y ?? 0), 0) / 10 };
	};
	const spread = (from: number) => Math.max(...nodes.slice(from, from + 10).map((n) => Math.hypot((n.x ?? 0) - center(from).x, (n.y ?? 0) - center(from).y)));
	const apart = Math.hypot(center(0).x - center(10).x, center(0).y - center(10).y);
	assert.ok(apart > spread(0) + spread(10), `${apart} apart, islands of ${spread(0)} and ${spread(10)}`);
});

test('puts each depth on its own ring in the layers layout', () => {
	const { nodes, links } = twoGroups();
	nodes.forEach((n, i) => (n.depth = i < 4 ? 0 : i < 12 ? 1 : 2));
	run(createLayersSimulation(nodes, links, forces));
	const r = (depth: number) => {
		const ring = nodes.filter((n) => n.depth === depth);
		return ring.reduce((s, n) => s + Math.hypot(n.x ?? 0, n.y ?? 0), 0) / ring.length;
	};
	assert.ok(r(0) < r(1) && r(1) < r(2), `${r(0)} < ${r(1)} < ${r(2)}`);
});

test('holds the works of the vault on a circle, by year', () => {
	const { nodes, links } = twoGroups();
	nodes.forEach((n, i) => (n.depth = i % 4 === 0 ? 0 : 1));
	const places = circlePlaces(nodes);
	const R = circleRadius(5);
	// Oldest at the top, then clockwise.
	assert.ok(Math.abs((places[0]?.y ?? 0) + R) < 1e-6);
	assert.equal(places[1], null);
	run(createCircleSimulation(nodes, links, forces));
	for (const n of nodes.filter((m) => m.depth === 0)) assert.ok(Math.abs(Math.hypot(n.x ?? 0, n.y ?? 0) - R) < R * 0.05);
	for (const n of nodes.filter((m) => m.depth === 1)) assert.ok(Math.hypot(n.x ?? 0, n.y ?? 0) > R);
});

test('draws works close in meaning together, and the graph in with the center force', () => {
	const run = (meaning: number, center: number) => {
		// Pairs of works close in meaning (kin), their places in a ring.
		const nodes: LayoutNode[] = Array.from({ length: 40 }, (_, i) => {
			const angle = (Math.floor(i / 2) / 20) * 2 * Math.PI;
			return { depth: 1, radius: 4, x: Math.cos(i) * 300, y: Math.sin(i) * 300, anchor: [Math.cos(angle) * 800, Math.sin(angle) * 800] as [number, number], kin: [[i % 2 ? i - 1 : i + 1, 0.9]] as [number, number][] };
		});
		const sim = createMeaningSimulation(nodes, [], { ...forces, meaning, center });
		for (let i = 0; i < 300; i++) sim.tick();
		const pairGap = nodes.filter((_, i) => i % 2 === 0).reduce((s, n, k) => s + Math.hypot((n.x ?? 0) - (nodes[2 * k + 1]?.x ?? 0), (n.y ?? 0) - (nodes[2 * k + 1]?.y ?? 0)), 0) / 20;
		const extent = Math.max(...nodes.map((n) => Math.hypot(n.x ?? 0, n.y ?? 0)));
		return { pairGap, extent };
	};
	const usual = run(1, 0.02);
	const strong = run(4, 0.02);
	const centered = run(1, 0.2);
	assert.ok(strong.pairGap < usual.pairGap, `pairs: ${strong.pairGap} < ${usual.pairGap}`);
	assert.ok(centered.extent < usual.extent * 0.8, `extent: ${centered.extent} < ${usual.extent}`);
});
