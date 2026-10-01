/**
 * Vectors of meaning of the works, by latent semantic analysis (LSA): each
 * work's text (the whole note for a work of the vault; title, topics,
 * keywords and abstract from OpenAlex for the others) becomes a vector of
 * weighted words (TF-IDF), and the corpus is condensed to a few dozen
 * dimensions of meaning (a truncated singular value decomposition, by
 * randomized subspace iteration). Works using the same words, or words that
 * occur together, get close vectors.
 *
 * The vocabulary, the directions and the plane can be learned from one
 * corpus (the notes of the vault) and applied to other texts, so a work's
 * meaning does not depend on which works are shown with it.
 *
 * No dependency and no model to download: plain arithmetic on sparse
 * vectors, deterministic (seeded), and cooperative (it yields between the
 * steps, so Obsidian stays responsive). No Obsidian or Pixi here.
 */

/** Common words of English and French that say nothing about a subject. */
const STOP_WORDS = new Set(
	(
		'the and for are but not you all any can had her was one our out day get has him his how man new now old see two way who ' +
		'boy did its let put say she too use that with have this will your from they know want been good much some time very when ' +
		'come here just like long make many more only over such take than them well were what where which while would there their ' +
		'these those into also then than other about after again under upon each both between through during before above below ' +
		'could should might must shall being does done doing having however therefore thus within without among although because ' +
		'figure fig et al data results result study studies used using use based may however les des une est pour par dans ' +
		'sur avec qui que aux ces ses sont pas plus ete etre cette leur leurs ont ainsi entre comme mais nous vous elle ils elles ' +
		'dont tout tous toute toutes fait faire peut peuvent sans sous chez vers selon lors aussi donc alors encore tres bien'
	).split(' '),
);

/** Words of a text: lower case, without accents, three letters or more, without the stop words; a plural "s" dropped. */
export function tokenize(text: string): string[] {
	const plain = text
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase();
	const words = plain.match(/[a-z]{3,}/g) ?? [];
	const out: string[] = [];
	for (let word of words) {
		if (STOP_WORDS.has(word)) continue;
		if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) word = word.slice(0, -1);
		out.push(word);
	}
	return out;
}

/** A sparse vector: term indices and their weights. */
export interface SparseVector {
	terms: Int32Array;
	weights: Float64Array;
}

/** The words kept and their weights (IDF), learned from a corpus. */
export interface Vocabulary {
	index: Map<string, number>;
	idf: Float64Array;
}

/**
 * The vocabulary of a corpus (documents given as their words): a term's
 * weight is log(documents / documents with it). Terms in fewer than
 * `minDocuments` documents or in more than `maxShare` of them are left out
 * (typos, and words everyone uses); at most `maxTerms` terms are kept, the
 * most widespread first.
 */
export function vocabularyOf(documents: string[][], options: { minDocuments?: number; maxShare?: number; maxTerms?: number } = {}): Vocabulary {
	const minDocuments = options.minDocuments ?? 2;
	const maxShare = options.maxShare ?? 0.5;
	const maxTerms = options.maxTerms ?? 30000;
	const df = new Map<string, number>();
	for (const words of documents) for (const w of new Set(words)) df.set(w, (df.get(w) ?? 0) + 1);
	const n = documents.length;
	const kept = [...df]
		.filter(([, d]) => d >= minDocuments && d <= Math.max(minDocuments, maxShare * n))
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
		.slice(0, maxTerms);
	return { index: new Map(kept.map(([w], i) => [w, i])), idf: Float64Array.from(kept, ([, d]) => Math.log(n / d)) };
}

/** The TF-IDF vector of a document: (1 + log of each kept word's count) × its IDF, of length 1. */
export function vectorize(words: string[], vocabulary: Vocabulary): SparseVector {
	const counts = new Map<number, number>();
	for (const w of words) {
		const t = vocabulary.index.get(w);
		if (t !== undefined) counts.set(t, (counts.get(t) ?? 0) + 1);
	}
	const terms = Int32Array.from([...counts.keys()].sort((a, b) => a - b));
	const weights = Float64Array.from(terms, (t) => (1 + Math.log(counts.get(t) ?? 1)) * (vocabulary.idf[t] ?? 0));
	const length = Math.sqrt(weights.reduce((s, x) => s + x * x, 0)) || 1;
	for (let i = 0; i < weights.length; i++) weights[i] = (weights[i] ?? 0) / length;
	return { terms, weights };
}

/** TF-IDF vectors of documents, with the vocabulary of these same documents (see `vocabularyOf`). */
export function tfidf(documents: string[][], options: { minDocuments?: number; maxShare?: number; maxTerms?: number } = {}): { vectors: SparseVector[]; terms: number } {
	const vocabulary = vocabularyOf(documents, options);
	return { vectors: documents.map((words) => vectorize(words, vocabulary)), terms: vocabulary.idf.length };
}

/** A small seeded random generator (mulberry32), so the vectors are the same each time. */
function random(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Orthonormalizes the k columns of a matrix stored by rows (rows × k), in
 * place: Gram-Schmidt column by column, each projection done twice for
 * stability, reading the matrix row by row (faster than column by column).
 */
function orthonormalize(m: Float64Array, rows: number, k: number): void {
	const dots = new Float64Array(k);
	for (let c = 0; c < k; c++) {
		for (let pass = 0; pass < 2 && c > 0; pass++) {
			dots.fill(0);
			for (let r = 0; r < rows; r++) {
				const row = r * k;
				const x = m[row + c] ?? 0;
				for (let p = 0; p < c; p++) dots[p] = (dots[p] ?? 0) + x * (m[row + p] ?? 0);
			}
			for (let r = 0; r < rows; r++) {
				const row = r * k;
				let x = m[row + c] ?? 0;
				for (let p = 0; p < c; p++) x -= (dots[p] ?? 0) * (m[row + p] ?? 0);
				m[row + c] = x;
			}
		}
		let norm = 0;
		for (let r = 0; r < rows; r++) norm += (m[r * k + c] ?? 0) ** 2;
		norm = Math.sqrt(norm) || 1;
		for (let r = 0; r < rows; r++) m[r * k + c] = (m[r * k + c] ?? 0) / norm;
	}
}

/** The main directions of meaning among the terms: an orthonormal basis (terms × k, by rows). */
export interface MeaningBasis {
	basis: Float64Array;
	k: number;
}

/**
 * The `dimensions` main directions of a corpus (truncated SVD by randomized
 * subspace iteration, seeded). `pause` is awaited between the heavy steps.
 */
export async function meaningBasis(vectors: SparseVector[], terms: number, dimensions = 64, pause: () => Promise<void> = () => Promise.resolve()): Promise<MeaningBasis> {
	const n = vectors.length;
	const k = Math.max(1, Math.min(dimensions, terms, n));
	const rand = random(20260930);
	// Z (terms × k): spans the main directions among the terms.
	let z: Float64Array = Float64Array.from({ length: terms * k }, () => rand() - 0.5);
	const aTimes = (basis: Float64Array): Float64Array => {
		const y = new Float64Array(n * k);
		vectors.forEach((v, i) => {
			for (let e = 0; e < v.terms.length; e++) {
				const t = v.terms[e] ?? 0;
				const w = v.weights[e] ?? 0;
				for (let c = 0; c < k; c++) y[i * k + c] = (y[i * k + c] ?? 0) + w * (basis[t * k + c] ?? 0);
			}
		});
		return y;
	};
	const aTransposeTimes = (y: Float64Array): Float64Array => {
		const out = new Float64Array(terms * k);
		vectors.forEach((v, i) => {
			for (let e = 0; e < v.terms.length; e++) {
				const t = v.terms[e] ?? 0;
				const w = v.weights[e] ?? 0;
				for (let c = 0; c < k; c++) out[t * k + c] = (out[t * k + c] ?? 0) + w * (y[i * k + c] ?? 0);
			}
		});
		return out;
	};
	// Only the documents' side (n × k) is orthonormalized at each
	// iteration; the terms' side once, at the end.
	for (let iteration = 0; iteration < 5; iteration++) {
		const y = aTimes(z);
		orthonormalize(y, n, k);
		await pause();
		z = aTransposeTimes(y);
		await pause();
	}
	orthonormalize(z, terms, k);
	return { basis: z, k };
}

/** The vector of meaning of a document: its TF-IDF vector on the main directions, of length 1; null without any kept word. */
export function project(vector: SparseVector, { basis, k }: MeaningBasis): Float32Array | null {
	if (vector.terms.length === 0) return null;
	const out = new Float32Array(k);
	for (let e = 0; e < vector.terms.length; e++) {
		const t = vector.terms[e] ?? 0;
		const w = vector.weights[e] ?? 0;
		for (let c = 0; c < k; c++) out[c] = (out[c] ?? 0) + w * (basis[t * k + c] ?? 0);
	}
	let norm = 0;
	for (let c = 0; c < k; c++) norm += (out[c] ?? 0) ** 2;
	norm = Math.sqrt(norm);
	if (norm === 0) return null;
	for (let c = 0; c < k; c++) out[c] = (out[c] ?? 0) / norm;
	return out;
}

/** The vectors of meaning of a corpus, from its own main directions (see `meaningBasis` and `project`). */
export async function lsa(vectors: SparseVector[], terms: number, dimensions = 64, pause?: () => Promise<void>): Promise<(Float32Array | null)[]> {
	const basis = await meaningBasis(vectors, terms, dimensions, pause);
	return vectors.map((v) => project(v, basis));
}

/** Cosine similarity of two vectors of meaning (both of length 1). */
export function similarity(a: Float32Array, b: Float32Array): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
	return s;
}

/** A plane of meaning: the mean of the vectors, their two main directions, and the spread along each. */
export interface Plane {
	mean: Float64Array;
	axes: Float64Array[];
	spreads: number[];
}

/**
 * The plane of a set of vectors: their two main directions (principal
 * components), each axis in units of its own spread, so the places are
 * relative to the diversity of the vectors given. Null without two vectors.
 */
export function fitPlane(vectors: (Float32Array | null)[]): Plane | null {
	const present = vectors.filter((v): v is Float32Array => v !== null);
	const d = present[0]?.length ?? 0;
	if (present.length < 2 || d === 0) return null;
	const mean = new Float64Array(d);
	for (const v of present) for (let j = 0; j < d; j++) mean[j] = (mean[j] ?? 0) + (v[j] ?? 0) / present.length;
	// Covariance (d × d, small), then its two main eigenvectors by power iteration.
	const cov = new Float64Array(d * d);
	for (const v of present) {
		for (let a = 0; a < d; a++) {
			const x = (v[a] ?? 0) - (mean[a] ?? 0);
			for (let b = a; b < d; b++) cov[a * d + b] = (cov[a * d + b] ?? 0) + x * ((v[b] ?? 0) - (mean[b] ?? 0));
		}
	}
	for (let a = 0; a < d; a++) for (let b = 0; b < a; b++) cov[a * d + b] = cov[b * d + a] ?? 0;
	const axes: Float64Array[] = [];
	for (let c = 0; c < 2; c++) {
		let axis = Float64Array.from({ length: d }, (_, j) => 1 + ((j * 7919) % 13) / 13);
		for (let it = 0; it < 100; it++) {
			const next = new Float64Array(d);
			for (let a = 0; a < d; a++) {
				let s = 0;
				for (let b = 0; b < d; b++) s += (cov[a * d + b] ?? 0) * (axis[b] ?? 0);
				next[a] = s;
			}
			for (const found of axes) {
				let dot = 0;
				for (let j = 0; j < d; j++) dot += (next[j] ?? 0) * (found[j] ?? 0);
				for (let j = 0; j < d; j++) next[j] = (next[j] ?? 0) - dot * (found[j] ?? 0);
			}
			const norm = Math.sqrt(next.reduce((s, x) => s + x * x, 0)) || 1;
			axis = next.map((x) => x / norm);
		}
		// A stable sign: the largest component positive.
		let largest = 0;
		for (let j = 0; j < d; j++) if (Math.abs(axis[j] ?? 0) > Math.abs(axis[largest] ?? 0)) largest = j;
		if ((axis[largest] ?? 0) < 0) axis = axis.map((x) => -x);
		axes.push(axis);
	}
	const plane: Plane = { mean, axes, spreads: [1, 1] };
	const coordinates = present.map((v) => placeIn(plane, v));
	plane.spreads = [0, 1].map((c) => Math.sqrt(coordinates.reduce((s, p) => s + (p[c] ?? 0) ** 2, 0) / present.length) || 1);
	return plane;
}

/** The place of a vector in a plane. */
export function placeIn(plane: Plane, v: Float32Array): [number, number] {
	const d = plane.mean.length;
	const [a, b] = plane.axes.map((axis) => {
		let s = 0;
		for (let j = 0; j < d; j++) s += ((v[j] ?? 0) - (plane.mean[j] ?? 0)) * (axis[j] ?? 0);
		return s;
	});
	return [(a ?? 0) / (plane.spreads[0] ?? 1), (b ?? 0) / (plane.spreads[1] ?? 1)];
}

/** Places of the vectors in their own plane (see `fitPlane`); null vectors stay null. */
export function planeOf(vectors: (Float32Array | null)[]): ([number, number] | null)[] {
	const plane = fitPlane(vectors);
	return vectors.map((v) => (v ? (plane ? placeIn(plane, v) : [0, 0]) : null));
}

/**
 * The `k` works nearest to each work in the plane of meaning (so the
 * nearest in color), with a closeness from 1 (same place) towards 0, most
 * alike first. Found through a grid of the plane: only the works of the
 * nearby cells are compared, so it takes a few milliseconds for tens of
 * thousands of works (comparing every pair took minutes). Works without a
 * place get none.
 */
export function nearestInPlane(places: ([number, number] | null)[], k: number): [number, number][][] {
	const placed = places.flatMap((p, i) => (p ? [i] : []));
	const out: [number, number][][] = places.map(() => []);
	if (placed.length < 2) return out;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const i of placed) {
		const [x, y] = places[i] ?? [0, 0];
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	}
	// About k works per cell.
	const cells = Math.max(1, Math.ceil(Math.sqrt(placed.length / Math.max(1, k))));
	const size = Math.max(maxX - minX, maxY - minY, 1e-9) / cells;
	const cellOf = (v: number, min: number) => Math.min(cells - 1, Math.floor((v - min) / size));
	const grid = new Map<number, number[]>();
	for (const i of placed) {
		const [x, y] = places[i] ?? [0, 0];
		const key = cellOf(x, minX) * cells + cellOf(y, minY);
		const list = grid.get(key);
		if (list) list.push(i);
		else grid.set(key, [i]);
	}
	// Closeness: 1 at the same place, 0.5 at a typical distance between neighbors.
	const scale = size / 2;
	for (const i of placed) {
		const [x, y] = places[i] ?? [0, 0];
		const cx = cellOf(x, minX);
		const cy = cellOf(y, minY);
		const found: [number, number][] = [];
		// Rings of cells around the work's own, until enough works are found (one more ring then, for the corners).
		for (let ring = 0, extra = 0; ring < cells && extra < 2; ring++) {
			for (let gx = cx - ring; gx <= cx + ring; gx++) {
				for (let gy = cy - ring; gy <= cy + ring; gy++) {
					if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== ring || gx < 0 || gy < 0 || gx >= cells || gy >= cells) continue;
					for (const j of grid.get(gx * cells + gy) ?? []) {
						if (j === i) continue;
						const [qx, qy] = places[j] ?? [0, 0];
						found.push([j, Math.hypot(qx - x, qy - y)]);
					}
				}
			}
			if (found.length >= k) extra++;
		}
		found.sort((a, b) => a[1] - b[1]);
		out[i] = found.slice(0, k).map(([j, d]) => [j, 1 / (1 + d / scale)]);
	}
	return out;
}

/** A short fingerprint of a text (FNV-1a, 32 bits, in hexadecimal), to know whether it changed. */
export function fingerprint(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}
