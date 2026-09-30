/**
 * The "atoms" of the literature graph: each work of the vault is a nucleus,
 * alone at the center of a circle of the works outside the vault that it
 * cites (depth 1), with the works that those cite (depth 2) on a
 * larger circle. A work cited by several atoms belongs to the one with the
 * fewest electrons (so atoms stay balanced); the arrows of the other atoms
 * still reach it. A work that no atom cites is free.
 *
 * Nothing here knows about Obsidian, PixiJS or d3: it gives each node its
 * role and, for an electron, its place in its cloud relative to the nucleus.
 */

export const NUCLEUS = 0;
export const ELECTRON = 1;
export const FREE = 2;

export interface AtomNode {
	depth: number;
	radius: number;
}

export interface AtomLink {
	/** Index of the citing work. */
	source: number;
	/** Index of the cited work. */
	target: number;
}

export interface Atoms {
	/** NUCLEUS, ELECTRON or FREE, by node. */
	role: Uint8Array;
	/** For an electron, the index of its nucleus (else -1). */
	nucleus: Int32Array;
	/** For an electron, its place relative to its nucleus. */
	dx: Float32Array;
	dy: Float32Array;
	/** For a nucleus, the radius of its cloud (for others, their own radius). */
	cloud: Float32Array;
}

/** Room around a nucleus without electrons. */
const INNER_GAP = 8;

/**
 * Roles and places. Electrons stand on circles around their nucleus (the
 * nucleus alone inside): depth 1 on one, depth 2 on a larger one.
 * `spacing` is the distance between neighbors on a circle, so a circle's
 * radius grows with its number of electrons.
 */
export function buildAtoms(nodes: readonly AtomNode[], links: readonly AtomLink[], spacing: number): Atoms {
	const n = nodes.length;
	const role = new Uint8Array(n).fill(FREE);
	const nucleus = new Int32Array(n).fill(-1);
	const dx = new Float32Array(n);
	const dy = new Float32Array(n);
	const cloud = new Float32Array(n);
	const citers: number[][] = nodes.map(() => []);
	for (const l of links) if (l.source !== l.target) citers[l.target]?.push(l.source);
	const depthOf = (i: number) => nodes[i]?.depth ?? 0;

	nodes.forEach((node, i) => {
		if (node.depth === 0) role[i] = NUCLEUS;
	});
	/** Electrons of each atom so far, to give a shared work to the smallest. */
	const size = new Map<number, number>();
	/** Works cited by several atoms: in the outer part of their cloud. */
	const shared = new Uint8Array(n);
	const join = (i: number, atoms: Set<number>) => {
		const candidates = [...atoms].filter((a) => a >= 0);
		if (candidates.length === 0) return;
		const smallest = candidates.reduce((a, b) => ((size.get(b) ?? 0) < (size.get(a) ?? 0) || ((size.get(b) ?? 0) === (size.get(a) ?? 0) && b < a) ? b : a));
		role[i] = ELECTRON;
		nucleus[i] = smallest;
		shared[i] = candidates.length > 1 ? 1 : 0;
		size.set(smallest, (size.get(smallest) ?? 0) + 1);
	};
	// Depth 1: works of the vault citing it. Those cited by one atom
	// first, so that shared works then go to the smallest clouds.
	const atDepth1 = nodes.map((_, i) => i).filter((i) => depthOf(i) === 1);
	const vaultCiters = (i: number) => new Set((citers[i] ?? []).filter((c) => depthOf(c) === 0));
	for (const i of atDepth1) if (vaultCiters(i).size === 1) join(i, vaultCiters(i));
	for (const i of atDepth1) if (vaultCiters(i).size > 1) join(i, vaultCiters(i));
	// Depth 2: the atoms of the works citing it.
	const atomsOfCiters = (i: number) =>
		new Set((citers[i] ?? []).map((c) => (role[c] === ELECTRON ? (nucleus[c] ?? -1) : role[c] === NUCLEUS ? c : -1)));
	const atDepth2 = nodes.map((_, i) => i).filter((i) => depthOf(i) === 2);
	for (const i of atDepth2) if (atomsOfCiters(i).size === 1) join(i, atomsOfCiters(i));
	for (const i of atDepth2) if (atomsOfCiters(i).size > 1) join(i, atomsOfCiters(i));

	// Places on each circle: the works of this atom only, then the shared ones,
	// the larger (more cited) first. Each atom is turned by its own angle.
	const electronsOf = new Map<number, number[]>();
	for (let i = 0; i < n; i++) {
		if (role[i] !== ELECTRON) continue;
		const list = electronsOf.get(nucleus[i] ?? -1) ?? [];
		list.push(i);
		electronsOf.set(nucleus[i] ?? -1, list);
	}
	for (let i = 0; i < n; i++) cloud[i] = (nodes[i]?.radius ?? 0) + (role[i] === NUCLEUS ? INNER_GAP : 0);
	for (const [center, electrons] of electronsOf) {
		electrons.sort(
			(a, b) =>
				depthOf(a) - depthOf(b) || (shared[a] ?? 0) - (shared[b] ?? 0) || (nodes[b]?.radius ?? 0) - (nodes[a]?.radius ?? 0) || a - b,
		);
		// Each depth on its own circle, the nucleus alone inside: the
		// circle is as long as its electrons need, one `spacing` apart.
		const minimum = (nodes[center]?.radius ?? 0) + MIN_RING;
		const turn = center * 2.1;
		let ring = 0;
		let outer = minimum;
		for (const depth of [1, 2]) {
			const onRing = electrons.filter((e) => depthOf(e) === depth);
			if (onRing.length === 0) continue;
			const radius = Math.max(ring === 0 ? minimum : ring + RING_GAP, (onRing.length * spacing) / (2 * Math.PI));
			onRing.forEach((e, k) => {
				const angle = turn + (2 * Math.PI * k) / onRing.length;
				dx[e] = Math.cos(angle) * radius;
				dy[e] = Math.sin(angle) * radius;
				outer = Math.max(outer, radius + (nodes[e]?.radius ?? 0));
			});
			ring = radius;
		}
		cloud[center] = outer + spacing / 2;
	}
	return { role, nucleus, dx, dy, cloud };
}

/** Smallest distance between a nucleus and its circle of electrons. */
const MIN_RING = 30;
/** Distance between the circles of depth 1 and depth 2. */
const RING_GAP = 24;
