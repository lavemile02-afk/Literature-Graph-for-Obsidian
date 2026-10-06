/**
 * More styles of layout, each giving the graph a shape that tells something:
 *
 * - "chronological": the works from left to right by year of publication;
 * - "islands": the communities of citations (works citing one another a
 *   lot) as islands, apart from one another;
 * - "layers": the works of the vault in the middle, then a ring for each
 *   depth, like the rings of a tree;
 * - "circle": the works of the vault on a circle, by year, their citations
 *   as chords, and the other works around;
 * - "meaning": each work drawn to its place in the plane of meaning (see
 *   `meaning.ts`), so works on related subjects make clouds, and the further
 *   apart their subjects, the further apart the clouds.
 *
 * Like `layout.ts`, nothing here knows about Obsidian or PixiJS: it runs in
 * the layout's web worker.
 */
import { forceCollide, forceLink, forceManyBody, forceRadial, forceSimulation, forceX, forceY, Simulation } from 'd3-force';
import { collideRadius, repelFor } from './layout';
import type { Forces, LayoutLink, LayoutNode } from './layout';

type Sim = Simulation<LayoutNode, LayoutLink>;

const node = (nodes: LayoutNode[], end: LayoutLink['source']): LayoutNode | undefined =>
	typeof end === 'number' ? nodes[end] : typeof end === 'object' ? end : undefined;

/** Links counted per node (as `createSimulation` does), for their strength. */
function countDegrees(nodes: LayoutNode[], links: LayoutLink[]): void {
	for (const n of nodes) n.degree = 0;
	for (const l of links) {
		const s = node(nodes, l.source);
		const t = node(nodes, l.target);
		if (s) s.degree = (s.degree ?? 0) + 1;
		if (t) t.degree = (t.degree ?? 0) + 1;
	}
}

const ends = (l: LayoutLink) => [l.source as LayoutNode, l.target as LayoutNode] as const;
const weakestDegree = (l: LayoutLink) => Math.max(1, Math.min(ends(l)[0].degree ?? 1, ends(l)[1].degree ?? 1));
const repel = (forces: Forces, share: number) => repelFor(forces, share);
const collide = () => forceCollide<LayoutNode>(collideRadius).strength(0.7);

// ----- Chronological -----

/** Width of the chronological layout, in world units, for n works (narrow enough for the works to be seen when it is all in view). */
export function timelineWidth(n: number): number {
	return Math.max(1000, 60 * Math.sqrt(n));
}

/**
 * In the chronological layout, the works are drawn this much bigger (it is
 * wide, so seen from far): three times the radius they had before the radii
 * were doubled for every layout.
 */
export const CHRONOLOGICAL_POINT_SCALE = 1.5;

/**
 * The horizontal place of each year: by the rank of the year among the
 * works' years, so that every stretch of the width holds as many works
 * (otherwise the few old works would take most of the width). Returns a
 * function from a year to x, centered on 0; null years are not placed.
 */
export function yearScale(years: (number | null | undefined)[], width: number): (year: number) => number {
	const known = years.filter((y): y is number => typeof y === 'number' && Number.isFinite(y)).sort((a, b) => a - b);
	if (known.length === 0) return () => 0;
	const first = known[0] ?? 0;
	const last = known[known.length - 1] ?? first;
	if (first === last) return () => 0;
	// Share of works published before a year, halfway through its own works.
	const share = (year: number) => {
		let below = 0;
		let at = 0;
		for (const y of known) {
			if (y < year) below++;
			else if (y === year) at++;
			else break;
		}
		return (below + at / 2) / known.length;
	};
	const cache = new Map<number, number>();
	return (year: number) => {
		const y = Math.min(last, Math.max(first, year));
		let x = cache.get(y);
		if (x === undefined) {
			// Between known years, in proportion.
			const low = Math.floor(y);
			x = (share(low) + (share(low + 1) - share(low)) * (y - low) - 0.5) * width;
			cache.set(y, x);
		}
		return x;
	};
}

/** Where works of unknown year go: a column after the most recent works. */
export const unknownYearX = (width: number) => width / 2 + 150;

export function createChronologicalSimulation(nodes: LayoutNode[], links: LayoutLink[], forces: Forces): Sim {
	countDegrees(nodes, links);
	const width = timelineWidth(nodes.length);
	const x = yearScale(nodes.map((n) => n.year), width);
	const target = (n: LayoutNode) => (typeof n.year === 'number' ? x(n.year) : unknownYearX(width));
	return forceSimulation<LayoutNode, LayoutLink>(nodes)
		.force('link', forceLink<LayoutNode, LayoutLink>(links).distance(forces.linkDistance).strength((l) => 0.1 / weakestDegree(l)))
		.force('charge', forceManyBody<LayoutNode>().strength(repel(forces, 0.5)))
		.force('x', forceX<LayoutNode>(target).strength(0.6))
		.force('y', forceY<LayoutNode>(0).strength(Math.max(0.01, forces.center)))
		.force('collide', forceCollide<LayoutNode>((n) => collideRadius(n) * CHRONOLOGICAL_POINT_SCALE).strength(0.7))
		.stop();
}

// ----- Islands -----

/**
 * Communities of a graph (Louvain method): groups of nodes linked more among
 * themselves than to the rest, found by moving each node to the group of its
 * neighbors that raises the modularity most, then merging each group into
 * one node and starting again. Returns the community of each node (0 for the
 * largest, then by size).
 */
export function detectCommunities(n: number, edges: [number, number][]): Int32Array {
	// Levels of merged graphs: weighted edges between groups.
	let size = n;
	let weights = new Map<number, Map<number, number>>();
	const addWeight = (map: Map<number, Map<number, number>>, a: number, b: number, w: number) => {
		const row = map.get(a) ?? new Map<number, number>();
		row.set(b, (row.get(b) ?? 0) + w);
		map.set(a, row);
	};
	for (const [a, b] of edges) {
		if (a === b || a < 0 || b < 0 || a >= n || b >= n) continue;
		addWeight(weights, a, b, 1);
		addWeight(weights, b, a, 1);
	}
	// Community of each original node.
	let membership = Int32Array.from({ length: n }, (_, i) => i);
	for (let level = 0; level < 8; level++) {
		const degree = new Float64Array(size);
		let total = 0;
		for (const [a, row] of weights) for (const w of row.values()) {
			degree[a] = (degree[a] ?? 0) + w;
			total += w;
		}
		if (total === 0) break;
		const community = Int32Array.from({ length: size }, (_, i) => i);
		const communityDegree = Float64Array.from(degree);
		let moved = false;
		for (let pass = 0; pass < 20; pass++) {
			let changes = 0;
			for (let i = 0; i < size; i++) {
				const row = weights.get(i);
				if (!row) continue;
				const own = community[i] ?? i;
				const k = degree[i] ?? 0;
				// Links from i to each neighboring community.
				const toCommunity = new Map<number, number>();
				for (const [j, w] of row) {
					if (j === i) continue;
					const c = community[j] ?? j;
					toCommunity.set(c, (toCommunity.get(c) ?? 0) + w);
				}
				communityDegree[own] = (communityDegree[own] ?? 0) - k;
				let best = own;
				let bestGain = (toCommunity.get(own) ?? 0) - ((communityDegree[own] ?? 0) * k) / total;
				for (const [c, w] of toCommunity) {
					const gain = w - ((communityDegree[c] ?? 0) * k) / total;
					if (gain > bestGain + 1e-12) {
						bestGain = gain;
						best = c;
					}
				}
				communityDegree[best] = (communityDegree[best] ?? 0) + k;
				if (best !== own) {
					community[i] = best;
					changes++;
				}
			}
			if (changes === 0) break;
			moved = true;
		}
		if (!moved) break;
		// Merge each community into one node of the next level.
		const renumber = new Map<number, number>();
		for (let i = 0; i < size; i++) {
			const c = community[i] ?? i;
			if (!renumber.has(c)) renumber.set(c, renumber.size);
		}
		membership = membership.map((m) => renumber.get(community[m] ?? m) ?? 0);
		const merged = new Map<number, Map<number, number>>();
		for (const [a, row] of weights) {
			for (const [b, w] of row) addWeight(merged, renumber.get(community[a] ?? a) ?? 0, renumber.get(community[b] ?? b) ?? 0, w);
		}
		weights = merged;
		size = renumber.size;
	}
	// Largest community first.
	const counts = new Map<number, number>();
	for (const m of membership) counts.set(m, (counts.get(m) ?? 0) + 1);
	const order = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([c]) => c);
	const rank = new Map(order.map((c, i) => [c, i]));
	return membership.map((m) => rank.get(m) ?? 0);
}

/** Room per work on an island, in world units (its radius grows with the square root of its size). */
const ISLAND_ROOM = 22;

/**
 * Centers of the islands: the largest in the middle, the others around it on
 * a spiral, each far enough from the previous ones for its size.
 */
export function islandCenters(sizes: number[]): { x: number; y: number }[] {
	const golden = Math.PI * (3 - Math.sqrt(5));
	let area = 0;
	return sizes.map((size, i) => {
		const radius = i === 0 ? 0 : Math.sqrt(area) * ISLAND_ROOM * 1.25 + Math.sqrt(size) * ISLAND_ROOM;
		area += size;
		return { x: radius * Math.cos(i * golden), y: radius * Math.sin(i * golden) };
	});
}

export function createIslandsSimulation(nodes: LayoutNode[], links: LayoutLink[], forces: Forces): Sim {
	countDegrees(nodes, links);
	const index = new Map(nodes.map((n, i) => [n, i]));
	const at = (end: LayoutLink['source']) => (typeof end === 'number' ? end : (index.get(end as LayoutNode) ?? -1));
	const community = detectCommunities(
		nodes.length,
		links.map((l) => [at(l.source), at(l.target)]),
	);
	const sizes: number[] = [];
	for (const c of community) sizes[c] = (sizes[c] ?? 0) + 1;
	const centers = islandCenters(sizes.map((s) => s ?? 0));
	const center = (n: LayoutNode) => centers[community[index.get(n) ?? 0] ?? 0] ?? { x: 0, y: 0 };
	const sameIsland = (l: LayoutLink) => community[at(l.source)] === community[at(l.target)];
	return forceSimulation<LayoutNode, LayoutLink>(nodes)
		.force(
			'link',
			forceLink<LayoutNode, LayoutLink>(links)
				.distance((l) => forces.linkDistance * 0.6 + (ends(l)[0].radius + ends(l)[1].radius) * 1.5)
				.strength((l) => (sameIsland(l) ? 0.7 : 0.02) / weakestDegree(l)),
		)
		.force('charge', forceManyBody<LayoutNode>().strength(repel(forces, 0.35)).distanceMax(ISLAND_ROOM * 12))
		.force('x', forceX<LayoutNode>((n) => center(n).x).strength(0.12 + forces.center))
		.force('y', forceY<LayoutNode>((n) => center(n).y).strength(0.12 + forces.center))
		.force('collide', collide())
		.stop();
}

// ----- Layers -----

/** Radius of each depth's ring (0: the disc of the vault's works), for the number of works at each depth. */
export function layerRadii(counts: number[], forces: Forces): number[] {
	const disc = Math.max(120, Math.sqrt(counts[0] ?? 0) * 28);
	const gap = forces.linkDistance * 2 + 120;
	const ring1 = disc + gap + Math.sqrt(counts[1] ?? 0) * 12;
	const ring2 = ring1 + gap + Math.sqrt(counts[2] ?? 0) * 12;
	return [0, ring1, ring2];
}

export function createLayersSimulation(nodes: LayoutNode[], links: LayoutLink[], forces: Forces): Sim {
	countDegrees(nodes, links);
	const counts = [0, 0, 0];
	for (const n of nodes) counts[Math.min(2, n.depth)] = (counts[Math.min(2, n.depth)] ?? 0) + 1;
	const radii = layerRadii(counts, forces);
	const radius = (n: LayoutNode) => radii[Math.min(2, n.depth)] ?? 0;
	return forceSimulation<LayoutNode, LayoutLink>(nodes)
		.force('link', forceLink<LayoutNode, LayoutLink>(links).distance(forces.linkDistance).strength((l) => 0.15 / weakestDegree(l)))
		.force('charge', forceManyBody<LayoutNode>().strength(repel(forces, 0.6)))
		// The vault's works gather in the middle; each other depth on its ring.
		.force('radial', forceRadial<LayoutNode>(radius, 0, 0).strength((n) => (n.depth === 0 ? 0 : 0.5)))
		.force('x', forceX<LayoutNode>(0).strength((n) => (n.depth === 0 ? 0.08 + forces.center : 0)))
		.force('y', forceY<LayoutNode>(0).strength((n) => (n.depth === 0 ? 0.08 + forces.center : 0)))
		.force('collide', collide())
		.stop();
}

// ----- Circle -----

/** Radius of the circle of the vault's works: room for each of them around it. */
export function circleRadius(vaultWorks: number): number {
	return Math.max(300, (vaultWorks * 18) / (2 * Math.PI));
}

/**
 * The place of each work of the vault on the circle, by year of publication
 * (unknown years last), clockwise from the top. Returns null for the others.
 */
export function circlePlaces(nodes: LayoutNode[]): ({ x: number; y: number } | null)[] {
	const vault = nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.depth === 0);
	vault.sort((a, b) => (a.n.year ?? Infinity) - (b.n.year ?? Infinity) || a.i - b.i);
	const R = circleRadius(vault.length);
	const places: ({ x: number; y: number } | null)[] = nodes.map(() => null);
	vault.forEach(({ i }, k) => {
		const angle = -Math.PI / 2 + (2 * Math.PI * k) / Math.max(1, vault.length);
		places[i] = { x: R * Math.cos(angle), y: R * Math.sin(angle) };
	});
	return places;
}

export function createCircleSimulation(nodes: LayoutNode[], links: LayoutLink[], forces: Forces): Sim {
	countDegrees(nodes, links);
	const places = circlePlaces(nodes);
	// The works of the vault pinned at their place (after a drag, the force below brings them back).
	nodes.forEach((n, i) => {
		const place = places[i];
		if (!place) return;
		n.x = n.fx = place.x;
		n.y = n.fy = place.y;
	});
	const index = new Map(nodes.map((n, i) => [n, i]));
	const place = (n: LayoutNode) => places[index.get(n) ?? 0] ?? null;
	const vault = places.filter(Boolean).length;
	const R = circleRadius(vault);
	const count1 = nodes.filter((n) => n.depth === 1).length;
	const ring = (n: LayoutNode) => R + forces.linkDistance + Math.sqrt(count1) * 8 * (n.depth >= 2 ? 1.6 : 1);
	// Links between works of the vault are the chords: no pull, the circle holds them.
	const betweenVault = (l: LayoutLink) => ends(l)[0].depth === 0 && ends(l)[1].depth === 0;
	return forceSimulation<LayoutNode, LayoutLink>(nodes)
		.force(
			'link',
			forceLink<LayoutNode, LayoutLink>(links)
				.distance(forces.linkDistance)
				.strength((l) => (betweenVault(l) ? 0 : 0.3 / weakestDegree(l))),
		)
		.force('charge', forceManyBody<LayoutNode>().strength(repel(forces, 0.3)).distanceMax(400))
		// The works of the vault held at their place on the circle (a drag moves them, a release sends them back).
		.force('x', forceX<LayoutNode>((n) => place(n)?.x ?? 0).strength((n) => (place(n) ? 1 : 0)))
		.force('y', forceY<LayoutNode>((n) => place(n)?.y ?? 0).strength((n) => (place(n) ? 1 : 0)))
		.force('radial', forceRadial<LayoutNode>(ring, 0, 0).strength((n) => (n.depth === 0 ? 0 : 0.6)))
		.force('collide', collide())
		.stop();
}

// ----- Meaning -----

/** How far the works repel each other in the Meaning layout: only their neighbors, so the balls of meaning stay dense. */
const MEANING_REPEL_RANGE = 120;

/** A pull between two works close in meaning (the Meaning layout). */
interface KinLink {
	source: LayoutNode | number;
	target: LayoutNode | number;
	similarity: number;
}

/**
 * The Meaning layout: works close in meaning draw together, the more so the
 * closer they are, through links to their nearest works in meaning (`kin`);
 * every work also leans lightly towards its place in the plane of meaning
 * (`anchor`, the place that gives its color), so distant meanings, and
 * distant colors, end up apart. The usual repulsion, in proportion to the
 * size of the works, keeps the clouds airy rather than dense.
 */
export function createMeaningSimulation(nodes: LayoutNode[], links: LayoutLink[], forces: Forces): Sim {
	countDegrees(nodes, links);
	const placed = (n: LayoutNode) => Array.isArray(n.anchor);
	// Each pair once, the stronger similarity kept.
	const pairs = new Map<string, KinLink>();
	nodes.forEach((n, i) => {
		for (const [j, similarity] of n.kin ?? []) {
			if (j < 0 || j >= nodes.length || j === i) continue;
			const key = i < j ? `${i} ${j}` : `${j} ${i}`;
			const known = pairs.get(key);
			if (!known || known.similarity < similarity) pairs.set(key, { source: i, target: j, similarity });
		}
	});
	const kinLinks = [...pairs.values()];
	const kinCount = new Map<number, number>();
	for (const l of kinLinks) for (const end of [l.source, l.target] as number[]) kinCount.set(end, (kinCount.get(end) ?? 0) + 1);
	const kinEnds = (l: KinLink) => [l.source as LayoutNode, l.target as LayoutNode] as const;
	const attraction = Math.max(0, Number.isFinite(forces.meaning) ? forces.meaning : 1);
	const lean = (n: LayoutNode) => (placed(n) ? Math.min(0.16, 0.08 * attraction) : 0.005);
	// Citations between placed works barely pull (their meaning places them); a
	// work without any text follows the works it is linked to.
	const bothPlaced = (l: LayoutLink) => placed(ends(l)[0]) && placed(ends(l)[1]);
	const sim = forceSimulation<LayoutNode, LayoutLink>(nodes)
		.force('link', forceLink<LayoutNode, LayoutLink>(links).distance(forces.linkDistance).strength((l) => (bothPlaced(l) ? 0.01 : 0.3) / weakestDegree(l)))
		.force(
			'kin',
			forceLink<LayoutNode, KinLink>(kinLinks)
				// Close meanings: short and strong; farther ones: longer and weaker.
				.distance((l) => {
					const [a, b] = kinEnds(l);
					return (collideRadius(a) + collideRadius(b)) * (1.5 + 2 * (1 - l.similarity));
				})
				.strength((l) => {
					const [a, b] = kinEnds(l);
					const count = Math.min(kinCount.get(a.index ?? 0) ?? 1, kinCount.get(b.index ?? 0) ?? 1);
					// Stronger the closer in meaning, times the "Meaning attraction" setting (at most 1, past which d3 overshoots).
					return Math.min(1, (0.6 * attraction * l.similarity * l.similarity) / count);
				}),
		)
		.force('charge', forceManyBody<LayoutNode>().strength(repel(forces, 1)).distanceMax(MEANING_REPEL_RANGE))
		// Each work leans towards its place in the plane of meaning (strength `lean`)
		// and towards the middle (the center force): together, towards the point
		// between them, so a stronger center force draws the whole graph in.
		.force('x', forceX<LayoutNode>((n) => ((n.anchor?.[0] ?? 0) * lean(n)) / (lean(n) + forces.center || 1)).strength((n) => lean(n) + forces.center))
		.force('y', forceY<LayoutNode>((n) => ((n.anchor?.[1] ?? 0) * lean(n)) / (lean(n) + forces.center || 1)).strength((n) => lean(n) + forces.center))
		// Firm collisions: the balls are dense, and their works must not overlap.
		.force('collide', forceCollide<LayoutNode>(collideRadius).strength(1).iterations(3))
		.stop();
	return sim;
}

/**
 * The Meaning tree layout: the semantic tree of the works (see
 * `meaningTree` in `meaningMap.ts`), given as each work's `kin` (the links
 * of the tree). The links of the tree are short and firm, so the works most
 * alike line up in branches and twigs; each work leans a little towards its
 * place on the map of meaning (`anchor`), which keeps the large branches
 * where the map has them; the repulsion only reaches nearby works, so the
 * branches spread without pushing the whole tree apart. Citations barely
 * pull: the tree is about meaning.
 */
export function createTreeSimulation(nodes: LayoutNode[], links: LayoutLink[], forces: Forces): Sim {
	countDegrees(nodes, links);
	const branches: KinLink[] = [];
	nodes.forEach((n, i) => {
		for (const [j, similarity] of n.kin ?? []) {
			if (j >= 0 && j < nodes.length && j !== i) branches.push({ source: i, target: j, similarity });
		}
	});
	const branchEnds = (l: KinLink) => [l.source as LayoutNode, l.target as LayoutNode] as const;
	const lean = (n: LayoutNode) => (Array.isArray(n.anchor) ? 0.02 : 0);
	return forceSimulation<LayoutNode, LayoutLink>(nodes)
		.force('link', forceLink<LayoutNode, LayoutLink>(links).distance(forces.linkDistance).strength((l) => 0.005 / weakestDegree(l)))
		.force(
			'branch',
			forceLink<LayoutNode, KinLink>(branches)
				.distance((l) => {
					const [a, b] = branchEnds(l);
					return (collideRadius(a) + collideRadius(b)) * 1.5;
				})
				.strength(1),
		)
		.force('charge', forceManyBody<LayoutNode>().strength(repel(forces, 1)).distanceMax(TREE_REPEL_RANGE))
		// (The center force barely acts here: the map already holds the tree together.)
		.force('x', forceX<LayoutNode>((n) => n.anchor?.[0] ?? 0).strength((n) => lean(n) + forces.center * 0.1))
		.force('y', forceY<LayoutNode>((n) => n.anchor?.[1] ?? 0).strength((n) => lean(n) + forces.center * 0.1))
		.force('collide', forceCollide<LayoutNode>(collideRadius).strength(0.8))
		.stop();
}

/** Meaning tree: how far the repulsion reaches, so the branches open without pushing the whole tree apart. */
const TREE_REPEL_RANGE = 400;
