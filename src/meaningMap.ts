import { UMAP } from 'umap-js';

/**
 * The map of meaning: where each work goes in the plane, from its vector of
 * meaning (see `meaning.ts`). The plane is a UMAP map (Uniform Manifold
 * Approximation and Projection, McInnes et al., 2018), which keeps each
 * work next to the works most alike in meaning, rather than the two main
 * directions of the vectors (which kept 3 % of each work's ten nearest
 * works, against 27 % for UMAP, on 9,700 works). The map is learned once on
 * a fixed corpus (the literature of the vault and the works it cites);
 * other works are placed among their nearest works of the corpus. Also
 * here: the meaning a work outside the vault takes from the works of the
 * vault it is linked to, and the semantic tree of the "Meaning tree" layout.
 *
 * No Obsidian or Pixi here.
 */

/** A vector scaled to length 1 (null for a zero vector). */
export function normalized(v: ArrayLike<number>): Float32Array | null {
	let s = 0;
	for (let i = 0; i < v.length; i++) s += (v[i] ?? 0) ** 2;
	if (s === 0) return null;
	const out = new Float32Array(v.length);
	const n = Math.sqrt(s);
	for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) / n;
	return out;
}

function dot(a: Float32Array, b: Float32Array): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
	return s;
}

/**
 * A work's vector, with the meaning of the works it is linked to by citation
 * (works of the vault, whose whole text is known): its own vector plus
 * `weight` times their mean, of length 1. A work known only by a title and an
 * abstract says little; the works of the vault citing it say what it is cited
 * for. A work without any text of its own takes their meaning alone.
 */
export function blendWithNeighbors(own: Float32Array | null, neighbors: Float32Array[], weight = 1): Float32Array | null {
	if (neighbors.length === 0) return own;
	const d = own?.length ?? neighbors[0]?.length ?? 0;
	const sum = new Float32Array(d);
	for (const v of neighbors) for (let i = 0; i < d; i++) sum[i] = (sum[i] ?? 0) + (v[i] ?? 0) / neighbors.length;
	const mean = normalized(sum);
	if (!mean) return own;
	if (!own) return mean;
	const out = new Float32Array(d);
	for (let i = 0; i < d; i++) out[i] = (own[i] ?? 0) + weight * (mean[i] ?? 0);
	return normalized(out);
}

/**
 * The `k` vectors most alike each vector (cosine, by comparing every pair:
 * about 3 s for 6,000 vectors), as [index, similarity], most alike first.
 * `breathe` is awaited now and then, to give Obsidian the hand back.
 */
export async function nearestVectors(vectors: Float32Array[], k: number, breathe: () => Promise<void> = () => Promise.resolve()): Promise<[number, number][][]> {
	const n = vectors.length;
	const out: [number, number][][] = [];
	for (let i = 0; i < n; i++) {
		const a = vectors[i];
		const best: [number, number][] = [];
		if (a) {
			for (let j = 0; j < n; j++) {
				const b = vectors[j];
				if (j === i || !b) continue;
				const s = dot(a, b);
				if (best.length < k) {
					best.push([j, s]);
					if (best.length === k) best.sort((x, y) => y[1] - x[1]);
				} else if (s > (best[k - 1]?.[1] ?? -Infinity)) {
					// Insert in order (k is small).
					let p = k - 1;
					while (p > 0 && (best[p - 1]?.[1] ?? 0) < s) {
						best[p] = best[p - 1] as [number, number];
						p--;
					}
					best[p] = [j, s];
				}
			}
		}
		best.sort((x, y) => y[1] - x[1]);
		out.push(best);
		await breathe();
	}
	return out;
}

/** A small seeded random generator (mulberry32): the same map each time for the same works. */
function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Neighbors per work for UMAP (its usual value). */
export const MAP_NEIGHBORS = 15;

/**
 * The UMAP map of vectors of length 1, centered and scaled so the places
 * spread about 1 from the middle (root mean square). Deterministic. Takes
 * about 10 s for 6,000 works, giving the hand back between the steps.
 */
export async function mapOfMeaning(vectors: Float32Array[], breathe: () => Promise<void> = () => Promise.resolve()): Promise<[number, number][]> {
	const n = vectors.length;
	if (n === 0) return [];
	if (n <= MAP_NEIGHBORS + 1) return vectors.map((_, i) => [Math.cos((2 * Math.PI * i) / n), Math.sin((2 * Math.PI * i) / n)]);
	const knn = await nearestVectors(vectors, MAP_NEIGHBORS, breathe);
	const umap = new UMAP({ nComponents: 2, nNeighbors: MAP_NEIGHBORS, minDist: 0.1, random: seeded(20261006) });
	// UMAP counts each point among its own neighbors, at distance 0.
	umap.setPrecomputedKNN(
		knn.map((list, i) => [i, ...list.map(([j]) => j)]),
		knn.map((list) => [0, ...list.map(([, s]) => Math.sqrt(Math.max(0, 2 - 2 * s)))]),
	);
	const epochs = umap.initializeFit(vectors.map((v) => Array.from(v)));
	for (let e = 0; e < epochs; e++) {
		umap.step();
		await breathe();
	}
	return centered(umap.getEmbedding().map((p): [number, number] => [p[0] ?? 0, p[1] ?? 0]));
}

/** Places moved so their mean is the middle, and scaled to spread 1 (root mean square). */
export function centered(places: [number, number][]): [number, number][] {
	const n = places.length || 1;
	const mx = places.reduce((s, p) => s + p[0], 0) / n;
	const my = places.reduce((s, p) => s + p[1], 0) / n;
	const rms = Math.sqrt(places.reduce((s, p) => s + (p[0] - mx) ** 2 + (p[1] - my) ** 2, 0) / n) || 1;
	return places.map(([x, y]) => [(x - mx) / rms, (y - my) / rms]);
}

/**
 * Turns (and mirrors, if better) a new map so that the works it shares with
 * the previous one are where they were, as much as possible (orthogonal
 * Procrustes in the plane): a map learned again after the notes changed
 * keeps its orientation, so the works keep their colors. Both maps are
 * centered and of spread 1. With fewer than 3 works in common, the map is
 * left as it is.
 */
export function alignTo(places: [number, number][], previous: ([number, number] | null)[]): [number, number][] {
	const pairs = places.flatMap((p, i) => {
		const q = previous[i];
		return q ? [[p, q] as const] : [];
	});
	if (pairs.length < 3) return places;
	let best: { flip: boolean; angle: number; error: number } | null = null;
	for (const flip of [false, true]) {
		let sxx = 0;
		let sxy = 0;
		for (const [[px, py0], [qx, qy]] of pairs) {
			const py = flip ? -py0 : py0;
			sxx += px * qx + py * qy;
			sxy += px * qy - py * qx;
		}
		const angle = Math.atan2(sxy, sxx);
		const c = Math.cos(angle);
		const s = Math.sin(angle);
		let error = 0;
		for (const [[px, py0], [qx, qy]] of pairs) {
			const py = flip ? -py0 : py0;
			error += (c * px - s * py - qx) ** 2 + (s * px + c * py - qy) ** 2;
		}
		if (!best || error < best.error) best = { flip, angle, error };
	}
	const { flip, angle } = best ?? { flip: false, angle: 0 };
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	return places.map(([x, y0]) => {
		const y = flip ? -y0 : y0;
		return [c * x - s * y, s * x + c * y];
	});
}

/**
 * The place of a work that is not in the corpus of the map: among its
 * nearest works of the corpus, mostly the nearest one (the weights fall
 * fast with the difference of similarity, so a work between two islands
 * does not land in the empty sea between them).
 */
export function placeAmong(vector: Float32Array, corpus: Float32Array[], places: [number, number][], k = 8): [number, number] | null {
	const best: [number, number][] = [];
	for (let j = 0; j < corpus.length; j++) {
		const b = corpus[j];
		if (!b) continue;
		best.push([j, dot(vector, b)]);
		if (best.length > 4 * k) {
			best.sort((x, y) => y[1] - x[1]);
			best.length = k;
		}
	}
	best.sort((x, y) => y[1] - x[1]);
	const near = best.slice(0, k);
	const top = near[0]?.[1];
	if (top === undefined) return null;
	let x = 0;
	let y = 0;
	let total = 0;
	for (const [j, s] of near) {
		const w = Math.exp(20 * (s - top));
		const p = places[j];
		if (!p) continue;
		x += w * p[0];
		y += w * p[1];
		total += w;
	}
	return total > 0 ? [x / total, y / total] : null;
}

/** A vector of meaning in a short string, for the cache: each value on one signed byte, in base 64 (88 characters for 64 values). */
export function packVector(v: Float32Array): string {
	const bytes = new Uint8Array(v.length);
	for (let i = 0; i < v.length; i++) bytes[i] = Math.max(-127, Math.min(127, Math.round((v[i] ?? 0) * 127))) & 0xff;
	let text = '';
	for (const b of bytes) text += String.fromCharCode(b);
	return btoa(text);
}

/** The vector packed by `packVector`, of length 1 again. */
export function unpackVector(packed: string): Float32Array | null {
	const text = atob(packed);
	const v = new Float32Array(text.length);
	for (let i = 0; i < text.length; i++) v[i] = ((text.charCodeAt(i) << 24) >> 24) / 127;
	return normalized(v);
}

/**
 * The semantic tree of works (as TMAP does, Probst and Reymond, 2020): each
 * work joined to the works most alike it among `candidates` (indices: for
 * example its nearest works on the map), then only the links of the minimum
 * spanning tree of that graph are kept, so similar works form branches and
 * twigs. Returns the links [a, b, similarity]; works in parts with no link
 * between them stay separate trees.
 */
export function meaningTree(vectors: (Float32Array | null)[], candidates: number[][], k = 10): [number, number, number][] {
	const edges: [number, number, number][] = [];
	candidates.forEach((list, i) => {
		const a = vectors[i];
		if (!a) return;
		const scored = list.flatMap((j): [number, number][] => {
			const b = vectors[j];
			return b && j !== i ? [[j, dot(a, b)]] : [];
		});
		scored.sort((x, y) => y[1] - x[1]);
		for (const [j, s] of scored.slice(0, k)) edges.push([i, j, s]);
	});
	edges.sort((x, y) => y[2] - x[2]);
	const parent = vectors.map((_, i) => i);
	const find = (x: number): number => {
		while (parent[x] !== x) {
			const up = parent[parent[x] ?? x] ?? x;
			parent[x] = up;
			x = up;
		}
		return x;
	};
	const tree: [number, number, number][] = [];
	for (const [a, b, s] of edges) {
		const ra = find(a);
		const rb = find(b);
		if (ra === rb) continue;
		parent[ra] = rb;
		tree.push([a, b, s]);
	}
	return tree;
}

/**
 * A note's text without its reference lists, for its meaning: the lines of
 * the entries (`entryLines`, 0-based) and what lies between two entries a
 * few lines apart (an entry cut in two by the conversion), and up to two
 * lines going on after the last entry of a run. The authors and journals of the
 * references would otherwise weigh in the meaning of the note.
 */
export function withoutLines(text: string, entryLines: number[]): string {
	if (entryLines.length === 0) return text;
	const lines = text.split('\n');
	const drop = new Set<number>();
	const sorted = [...new Set(entryLines)].sort((a, b) => a - b);
	sorted.forEach((line, i) => {
		const next = sorted[i + 1];
		if (next !== undefined && next - line <= 4) {
			for (let l = line; l < next; l++) drop.add(l);
			return;
		}
		drop.add(line);
		// The rest of the last entry, if it goes on (never a heading or past a blank line).
		for (let l = line + 1; l <= line + 2; l++) {
			const rest = (lines[l] ?? '').trim();
			if (!rest || rest.startsWith('#')) break;
			drop.add(l);
		}
	});
	return lines.filter((_, i) => !drop.has(i)).join('\n');
}

/** A radial dendrogram of works (see `radialDendrogram`). */
export interface RadialDendrogram {
	/** The place of each work on the outer circle (null: a work without meaning). */
	places: ([number, number] | null)[];
	/** The inner nodes: the groups (level 1, one per group, in the order of the groups) and their subgroups (level 2). */
	hubs: { x: number; y: number; level: 1 | 2; group: number }[];
	/** The branches: [from, to], each a hub (index into `hubs`), the middle (-1), or a work (`work`; `end`: the first or last work of its subgroup on the circle). */
	links: { from: number; to: number; work: boolean; end?: boolean }[];
	/** Radius of the inner row of works. */
	radius: number;
}

/**
 * A radial dendrogram of the works: the middle branches into the groups of
 * meaning (`group`, from `meaningGroups`), each group into subgroups
 * (k-means of its works on the map), and each subgroup into its works, which
 * stand on a circle, in the order of the map (the groups, their subgroups
 * and their works by angle around the middle of the map), so neighbor
 * meanings are neighbors on the circle. `spacing` is the room of one work
 * along the circle; `gap` (in works) separates two groups, a quarter of it
 * two subgroups.
 */
export function radialDendrogram(
	places: ([number, number] | null)[],
	group: number[],
	groupCount: number,
	subgroupsOf: (works: number[]) => number[][],
	spacing: number,
	gap: number,
): RadialDendrogram {
	const angle = (p: [number, number] | null | undefined) => (p ? Math.atan2(p[1], p[0]) : 0);
	const mean = (list: number[]): [number, number] => {
		let x = 0;
		let y = 0;
		for (const i of list) {
			x += places[i]?.[0] ?? 0;
			y += places[i]?.[1] ?? 0;
		}
		return [x / (list.length || 1), y / (list.length || 1)];
	};
	const members: number[][] = Array.from({ length: groupCount }, () => []);
	places.forEach((p, i) => {
		const g = group[i] ?? -1;
		if (p && g >= 0 && g < groupCount) members[g]?.push(i);
	});
	const order = members.map((list, g) => ({ g, list, a: angle(mean(list)) })).filter((o) => o.list.length > 0).sort((x, y) => x.a - y.a);
	// The works in order, with the gaps, as slots along the circle.
	type Slot = { work: number; group: number; sub: number } | null;
	const slots: Slot[] = [];
	const subgroups: { group: number; works: number[] }[] = [];
	for (const { g, list } of order) {
		if (slots.length > 0) for (let k = 0; k < gap; k++) slots.push(null);
		const subs = subgroupsOf(list)
			.filter((s) => s.length > 0)
			.map((s) => ({ s, a: angle(mean(s)) }))
			.sort((x, y) => x.a - y.a);
		subs.forEach(({ s }, k) => {
			if (k > 0) for (let q = 0; q < Math.max(1, Math.round(gap / 4)); q++) slots.push(null);
			const sub = subgroups.length;
			const sorted = [...s].sort((x, y) => angle(places[x]) - angle(places[y]));
			subgroups.push({ group: g, works: sorted });
			for (const w of sorted) slots.push({ work: w, group: g, sub });
		});
	}
	// Several rows of works, so the circle stays of a size one can take in
	// (one row of 10,000 works would be very wide): consecutive works fill a
	// column across the rows, then the next column.
	const rows = Math.max(1, Math.round(Math.sqrt(slots.length / 400)));
	const columns = Math.ceil(slots.length / rows);
	const radius = Math.max(1, (columns * spacing) / (2 * Math.PI));
	const out: ([number, number] | null)[] = places.map(() => null);
	const slotAngle = (k: number) => (2 * Math.PI * Math.floor(k / rows)) / Math.max(1, columns) - Math.PI / 2;
	const angles = new Map<number, number[]>();
	const subAngles = new Map<number, number[]>();
	slots.forEach((slot, k) => {
		if (!slot) return;
		const a = slotAngle(k);
		const r = radius + (k % rows) * spacing;
		out[slot.work] = [r * Math.cos(a), r * Math.sin(a)];
		angles.set(slot.group, [...(angles.get(slot.group) ?? []), a]);
		subAngles.set(slot.sub, [...(subAngles.get(slot.sub) ?? []), a]);
	});
	// The middle angle of a run of angles (they follow each other along the circle).
	const middle = (list: number[]) => ((list[0] ?? 0) + (list[list.length - 1] ?? 0)) / 2;
	const hubs: RadialDendrogram['hubs'] = [];
	const links: RadialDendrogram['links'] = [];
	const groupHub = new Map<number, number>();
	for (const { g } of order) {
		const a = middle(angles.get(g) ?? [0]);
		groupHub.set(g, hubs.length);
		links.push({ from: -1, to: hubs.length, work: false });
		hubs.push({ x: 0.35 * radius * Math.cos(a), y: 0.35 * radius * Math.sin(a), level: 1, group: g });
	}
	subgroups.forEach((sub, k) => {
		const a = middle(subAngles.get(k) ?? [0]);
		const hub = hubs.length;
		links.push({ from: groupHub.get(sub.group) ?? -1, to: hub, work: false });
		hubs.push({ x: 0.7 * radius * Math.cos(a), y: 0.7 * radius * Math.sin(a), level: 2, group: sub.group });
		sub.works.forEach((w, i) => links.push({ from: hub, to: w, work: true, end: i === 0 || i === sub.works.length - 1 }));
	});
	return { places: out, hubs, links, radius };
}

/** The commonest small words of English and French, which tell the language of a text. */
const FUNCTION_WORDS: Record<string, Set<string>> = {
	en: new Set('the and of to in is for with that are was by this from which be as on it not were have'.split(' ')),
	fr: new Set('le la les des une est pour dans avec que qui sur par pas ont aux cette sont du au en se ne il elle'.split(' ')),
};

/**
 * The language of a text ("en" or "fr"), from its commonest small words, or
 * "" when it is too short or not clearly one of them. Its meaning then
 * comes partly from the works it cites (see `meaningModel`): words of two
 * languages have nothing in common, so a note in the minority language of
 * the vault would stand apart from works on the same subject.
 */
export function languageOf(text: string): string {
	const counts: Record<string, number> = { en: 0, fr: 0 };
	for (const word of text.slice(0, 50_000).toLowerCase().split(/[^a-zàâçéèêëîïôûùüÿœ]+/)) {
		for (const [lang, words] of Object.entries(FUNCTION_WORDS)) if (words.has(word)) counts[lang] = (counts[lang] ?? 0) + 1;
	}
	const [best, second] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
	if (!best || best[1] < 30 || best[1] < 1.5 * (second?.[1] ?? 0)) return '';
	return best[0];
}
