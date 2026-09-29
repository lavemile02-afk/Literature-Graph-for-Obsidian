import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAtoms, ELECTRON, FREE, NUCLEUS } from '../src/atoms';

// Two works of the vault (0, 1); 0 cites 1. Works outside: 2, 3 cited by 0
// only; 4 cited by 0 and 1; 5 cited by 1 only. Generation 2: 6 cited by 2
// only; 7 cited by 2 and 5 (two atoms).
const nodes = [
	{ generation: 0, radius: 6 },
	{ generation: 0, radius: 6 },
	{ generation: 1, radius: 3 },
	{ generation: 1, radius: 2 },
	{ generation: 1, radius: 2 },
	{ generation: 1, radius: 2 },
	{ generation: 2, radius: 2 },
	{ generation: 2, radius: 2 },
];
const links = [
	{ source: 0, target: 1 },
	{ source: 0, target: 2 },
	{ source: 0, target: 3 },
	{ source: 0, target: 4 },
	{ source: 1, target: 4 },
	{ source: 1, target: 5 },
	{ source: 2, target: 6 },
	{ source: 2, target: 7 },
	{ source: 5, target: 7 },
];

test('makes works of the vault nuclei, and gives each atom its works, shared ones to the smallest', () => {
	const atoms = buildAtoms(nodes, links, 16);
	assert.deepEqual([...atoms.role], [NUCLEUS, NUCLEUS, ELECTRON, ELECTRON, ELECTRON, ELECTRON, ELECTRON, ELECTRON]);
	// 4 (cited by 0 and 1) goes to atom 1, which has fewer works; so does 7
	// (cited through both atoms), once 6 has joined atom 0.
	assert.deepEqual([...atoms.nucleus], [-1, -1, 0, 0, 1, 1, 0, 1]);
});

test('leaves free a work that no atom cites', () => {
	const atoms = buildAtoms([{ generation: 0, radius: 6 }, { generation: 1, radius: 2 }], [], 16);
	assert.deepEqual([...atoms.role], [NUCLEUS, FREE]);
});

test('puts shared works at the edge of their cloud, even when they are larger', () => {
	// Atom 0 cites 2 and 3 alone; atom 1 cites 5, 6 and 7 alone. Both cite 4,
	// which is larger (more cited): it goes to atom 0, the smaller, at its edge.
	const ns = [
		{ generation: 0, radius: 6 },
		{ generation: 0, radius: 6 },
		{ generation: 1, radius: 2 },
		{ generation: 1, radius: 2 },
		{ generation: 1, radius: 5 },
		{ generation: 1, radius: 2 },
		{ generation: 1, radius: 2 },
		{ generation: 1, radius: 2 },
	];
	const ls = [
		...[2, 3, 4].map((t) => ({ source: 0, target: t })),
		...[4, 5, 6, 7].map((t) => ({ source: 1, target: t })),
	];
	const atoms = buildAtoms(ns, ls, 16);
	assert.equal(atoms.nucleus[4], 0);
	const dist = (i: number) => Math.hypot(atoms.dx[i] ?? 0, atoms.dy[i] ?? 0);
	assert.ok(dist(4) > dist(2) && dist(4) > dist(3));
});

test('places electrons in their cloud, generation 1 inside, and sizes clouds by their electrons', () => {
	const atoms = buildAtoms(nodes, links, 16);
	const dist = (i: number) => Math.hypot(atoms.dx[i] ?? 0, atoms.dy[i] ?? 0);
	for (const e of [2, 3, 6]) assert.ok(dist(e) + nodes[e]!.radius <= (atoms.cloud[0] ?? 0), `electron ${e} inside`);
	assert.ok(dist(2) < dist(6), 'generation 2 outside generation 1');
});

test('keeps the density of clouds the same: the radius grows as the square root of the electrons', () => {
	const many = (count: number) => {
		const ns = [{ generation: 0, radius: 6 }, ...Array.from({ length: count }, () => ({ generation: 1, radius: 2 }))];
		const ls = ns.slice(1).map((_, i) => ({ source: 0, target: i + 1 }));
		return buildAtoms(ns, ls, 16).cloud[0] ?? 0;
	};
	const small = many(25) - 14;
	const large = many(100) - 14;
	assert.ok(Math.abs(large / small - 2) < 0.25, `${small} → ${large}`);
});
