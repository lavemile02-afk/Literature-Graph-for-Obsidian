import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAtoms, ELECTRON, NUCLEUS } from '../src/atoms';
import { ELECTRON_SPACING } from '../src/atomLayout';
import { LayoutLoop, LayoutMessage, LayoutUpdate } from '../src/layout';

/**
 * Three works of the vault: 0 cites 1, and 0 and 1 cite 2. Each cites its own
 * works outside the vault (40, 25 and 10 of them), and 0 and 1 both cite
 * three more (free works).
 */
function graph() {
	const nodes: { depth: number; radius: number }[] = [
		{ depth: 0, radius: 8 },
		{ depth: 0, radius: 6 },
		{ depth: 0, radius: 5 },
	];
	const links: { source: number; target: number; inVault: boolean }[] = [
		{ source: 0, target: 1, inVault: true },
		{ source: 0, target: 2, inVault: true },
		{ source: 1, target: 2, inVault: true },
	];
	const own = (citer: number, count: number) => {
		for (let k = 0; k < count; k++) {
			nodes.push({ depth: 1, radius: 2 + (k % 3) });
			links.push({ source: citer, target: nodes.length - 1, inVault: false });
		}
	};
	own(0, 40);
	own(1, 25);
	own(2, 10);
	for (let k = 0; k < 3; k++) {
		nodes.push({ depth: 1, radius: 3 });
		links.push({ source: 0, target: nodes.length - 1, inVault: false });
		links.push({ source: 1, target: nodes.length - 1, inVault: false });
	}
	return { nodes, links };
}

test('lays out atoms whose clouds keep their electrons and do not overlap', () => {
	const { nodes, links } = graph();
	let last: LayoutUpdate | null = null;
	const pending: (() => void)[] = [];
	const loop = new LayoutLoop((u) => (last = u), {
		setTimeout: (fn) => pending.push(fn),
		clearTimeout: () => undefined,
		now: () => 0,
	});
	const start: LayoutMessage = {
		type: 'start',
		graph: 1,
		nodes,
		links,
		forces: { repel: 90, linkDistance: 60, center: 0.02, meaning: 1 },
		alpha: 1,
		style: 'atom',
	};
	loop.handle(start);
	for (let i = 0; i < 2000 && pending.length > 0; i++) pending.shift()?.();
	const p = (last as LayoutUpdate | null)?.positions;
	assert.ok(p, 'positions');
	assert.equal((last as LayoutUpdate | null)?.moving, false);

	const atoms = buildAtoms(nodes, links, ELECTRON_SPACING);
	const at = (i: number) => [p[i * 2] ?? 0, p[i * 2 + 1] ?? 0] as const;
	const dist = (i: number, j: number) => Math.hypot(at(i)[0] - at(j)[0], at(i)[1] - at(j)[1]);
	// Every electron is in its own cloud.
	nodes.forEach((_, i) => {
		if (atoms.role[i] !== ELECTRON) return;
		const c = atoms.nucleus[i] ?? -1;
		assert.ok(dist(i, c) <= (atoms.cloud[c] ?? 0) + 2, `electron ${i} in its cloud`);
	});
	// Clouds do not overlap, but linked atoms stay close.
	const nuclei = nodes.map((_, i) => i).filter((i) => atoms.role[i] === NUCLEUS);
	for (const a of nuclei) {
		for (const b of nuclei) {
			if (b <= a) continue;
			const touching = (atoms.cloud[a] ?? 0) + (atoms.cloud[b] ?? 0);
			assert.ok(dist(a, b) >= touching - 2, `clouds ${a} and ${b} do not overlap`);
			assert.ok(dist(a, b) <= touching * 2.5, `atoms ${a} and ${b} stay close`);
		}
	}
	// Free works stay out of the clouds.
	nodes.forEach((_, i) => {
		if (atoms.role[i] === ELECTRON || atoms.role[i] === NUCLEUS) return;
		for (const c of nuclei) assert.ok(dist(i, c) >= (atoms.cloud[c] ?? 0), `free work ${i} outside cloud ${c}`);
	});
});
