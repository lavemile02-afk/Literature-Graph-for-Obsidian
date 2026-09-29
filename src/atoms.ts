/**
 * The "atoms" of the literature graph: each work of the vault is a nucleus,
 * surrounded by a cloud of the works outside the vault that it cites
 * (generation 1), with the works that those cite (generation 2) further out.
 * A work cited by several atoms belongs to the one with the fewest electrons
 * (so clouds stay balanced), in its outer part; the arrows of the other atoms
 * still reach it. A work that no atom cites is free.
 *
 * Nothing here knows about Obsidian, PixiJS or d3: it gives each node its
 * role and, for an electron, its place in its cloud relative to the nucleus.
 */

export const NUCLEUS = 0;
export const ELECTRON = 1;
export const FREE = 2;

export interface AtomNode {
	generation: number;
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

/** The golden angle, which spreads points evenly on a disc (as a sunflower's seeds). */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Room between the nucleus and its first electrons. */
const INNER_GAP = 8;

/**
 * Roles and places. `spacing` is the distance between neighboring electrons;
 * the cloud's radius grows with the square root of its number of electrons,
 * so that every cloud has the same density.
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
	const gen = (i: number) => nodes[i]?.generation ?? 0;

	nodes.forEach((node, i) => {
		if (node.generation === 0) role[i] = NUCLEUS;
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
	// Generation 1: works of the vault citing it. Those cited by one atom
	// first, so that shared works then go to the smallest clouds.
	const gen1 = nodes.map((_, i) => i).filter((i) => gen(i) === 1);
	const vaultCiters = (i: number) => new Set((citers[i] ?? []).filter((c) => gen(c) === 0));
	for (const i of gen1) if (vaultCiters(i).size === 1) join(i, vaultCiters(i));
	for (const i of gen1) if (vaultCiters(i).size > 1) join(i, vaultCiters(i));
	// Generation 2: the atoms of the works citing it.
	const atomsOfCiters = (i: number) =>
		new Set((citers[i] ?? []).map((c) => (role[c] === ELECTRON ? (nucleus[c] ?? -1) : role[c] === NUCLEUS ? c : -1)));
	const gen2 = nodes.map((_, i) => i).filter((i) => gen(i) === 2);
	for (const i of gen2) if (atomsOfCiters(i).size === 1) join(i, atomsOfCiters(i));
	for (const i of gen2) if (atomsOfCiters(i).size > 1) join(i, atomsOfCiters(i));

	// Places in each cloud: generation 1 first, then 2; in each, the works of
	// this atom only, then the shared ones (at the edge, toward the other
	// atoms' arrows); the larger (more cited) nearer the nucleus. Each atom is
	// turned by its own angle.
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
				gen(a) - gen(b) || (shared[a] ?? 0) - (shared[b] ?? 0) || (nodes[b]?.radius ?? 0) - (nodes[a]?.radius ?? 0) || a - b,
		);
		const start = (nodes[center]?.radius ?? 0) + INNER_GAP;
		const turn = center * 2.1;
		let outer = start;
		electrons.forEach((e, k) => {
			const r = start + spacing * Math.sqrt(k + 0.5) * 0.55;
			const angle = turn + k * GOLDEN_ANGLE;
			dx[e] = Math.cos(angle) * r;
			dy[e] = Math.sin(angle) * r;
			outer = Math.max(outer, r + (nodes[e]?.radius ?? 0));
		});
		cloud[center] = outer + spacing / 2;
	}
	return { role, nucleus, dx, dy, cloud };
}
