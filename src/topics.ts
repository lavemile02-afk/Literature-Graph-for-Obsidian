/**
 * Colors by topic. OpenAlex files every work under up to three topics, each
 * with a score, in a hierarchy: domain → field → subfield → topic (for
 * example Physical Sciences → Environmental Science → Ecology → "Peatlands and
 * Wetlands Ecology").
 *
 * Each work becomes a vector of meaning: its topics and their subfields,
 * fields and domains, weighted by score. The two directions in which the
 * works of the graph differ most (principal component analysis), each scaled
 * to its own spread, make a plane; a work's hue is its angle in that plane,
 * all around the color wheel. The colors are thus relative to the diversity
 * of the graph: works on neighboring topics get neighboring hues, and a few
 * works from another domain altogether take the opposite hues, while the
 * nuances within one domain get the whole wheel when it is alone.
 *
 * No Obsidian or Pixi here: colors are numbers (0xrrggbb).
 */

/** A topic's place in OpenAlex's hierarchy. */
export interface TopicInfo {
	name: string;
	/** OpenAlex ids without their URL: "subfields/2303", "fields/23". */
	subfield: string;
	subfieldName: string;
	field: string;
	fieldName: string;
}

/** The topics of a work: OpenAlex topic id ("T12091") and score (0 to 1). */
export type WorkTopics = [string, number][];

/** OpenAlex's four domains, by field: 1 Life, 2 Social, 3 Physical, 4 Health Sciences. */
const DOMAIN_OF_FIELD: Record<number, number> = {
	11: 1, 13: 1, 24: 1, 28: 1, 30: 1,
	12: 2, 14: 2, 18: 2, 20: 2, 32: 2, 33: 2,
	15: 3, 16: 3, 17: 3, 19: 3, 21: 3, 22: 3, 23: 3, 25: 3, 26: 3, 31: 3,
	27: 4, 29: 4, 34: 4, 35: 4, 36: 4,
};

/**
 * Weight of each level of the hierarchy in the vector of meaning: two works
 * of different domains differ at every level, two works on neighboring
 * topics only at the last ones.
 */
const LEVEL_WEIGHTS = { domain: 2, field: 1.5, subfield: 1, topic: 0.7 };

/**
 * A keyword the user wrote in a note's topics property that is not one of
 * OpenAlex's topics: a feature of its own, "kw:" + the keyword in lower case,
 * weighing as much as a field (notes sharing it draw together).
 */
export const KEYWORD_PREFIX = 'kw:';
const KEYWORD_WEIGHT = 1.5;

/**
 * The topics of a work from the names written in its note (the user's word
 * wins over OpenAlex's): each name is OpenAlex's topic of that name if there
 * is one (with the score OpenAlex gave the work, if it did), otherwise a
 * keyword of its own.
 */
export function topicsFromNames(names: string[], openAlexTopics: WorkTopics | undefined, idOfName: (name: string) => string | undefined): WorkTopics {
	const scores = new Map(openAlexTopics ?? []);
	return names.map((name): [string, number] => {
		const id = idOfName(name);
		return id ? [id, scores.get(id) ?? 1] : [KEYWORD_PREFIX + name.trim().toLowerCase(), 1];
	});
}

/** The name to show for a topic id (OpenAlex's name, or the keyword itself). */
export function topicName(id: string, info: (id: string) => TopicInfo | undefined): string {
	return id.startsWith(KEYWORD_PREFIX) ? id.slice(KEYWORD_PREFIX.length) : (info(id)?.name ?? id);
}

/** The number in an OpenAlex id ("fields/23" → 23), or NaN. */
function idNumber(id: string): number {
	const match = /(\d+)$/.exec(id);
	return match ? Number(match[1]) : NaN;
}

/** A work's vector of meaning: feature ("T12091", "subfields/2303", "fields/23", "domains/3") → weight, of length 1. */
export function topicVector(topics: WorkTopics | undefined, info: (id: string) => TopicInfo | undefined): Map<string, number> {
	const vector = new Map<string, number>();
	const add = (feature: string, weight: number) => {
		if (feature) vector.set(feature, (vector.get(feature) ?? 0) + weight);
	};
	for (const [id, score] of topics ?? []) {
		if (id.startsWith(KEYWORD_PREFIX)) {
			add(id, KEYWORD_WEIGHT * score);
			continue;
		}
		const place = info(id);
		add(id, LEVEL_WEIGHTS.topic * score);
		if (!place) continue;
		add(place.subfield, LEVEL_WEIGHTS.subfield * score);
		add(place.field, LEVEL_WEIGHTS.field * score);
		const domain = DOMAIN_OF_FIELD[idNumber(place.field)];
		if (domain) add(`domains/${domain}`, LEVEL_WEIGHTS.domain * score);
	}
	const length = Math.sqrt([...vector.values()].reduce((sum, w) => sum + w * w, 0));
	if (length > 0) for (const [k, w] of vector) vector.set(k, w / length);
	return vector;
}

/**
 * The plane of meaning of a set of vectors: their mean and the two
 * directions in which they differ most (principal components, by power
 * iteration), each with its spread. Deterministic: the sign of each
 * direction is chosen so that the most common feature leans positive.
 */
export interface MeaningPlane {
	features: string[];
	mean: Float64Array;
	axes: [Float64Array, Float64Array];
	spreads: [number, number];
}

export function meaningPlane(vectors: Map<string, number>[]): MeaningPlane | null {
	const index = new Map<string, number>();
	for (const v of vectors) for (const k of v.keys()) if (!index.has(k)) index.set(k, index.size);
	const d = index.size;
	const n = vectors.length;
	if (n < 2 || d === 0) return null;
	// Sparse rows (a work has a dozen features at most); the centering by the
	// mean m is done in the products: Xc·v = X·v − (m·v), Xcᵀ·u = Xᵀ·u − m·Σu.
	const rows = vectors.map((v) => [...v].map(([k, w]) => [index.get(k) ?? 0, w] as const));
	const mean = new Float64Array(d);
	for (const row of rows) for (const [j, w] of row) mean[j] = (mean[j] ?? 0) + w / n;
	const dot = (a: Float64Array, b: Float64Array) => {
		let s = 0;
		for (let j = 0; j < d; j++) s += (a[j] ?? 0) * (b[j] ?? 0);
		return s;
	};
	/** The centered works projected on an axis. */
	const scores = (axis: Float64Array) => {
		const shift = dot(mean, axis);
		return rows.map((row) => row.reduce((s, [j, w]) => s + w * (axis[j] ?? 0), 0) - shift);
	};
	// Most common feature, to fix the signs.
	let common = 0;
	for (let j = 0; j < d; j++) if ((mean[j] ?? 0) > (mean[common] ?? 0)) common = j;
	const axes: Float64Array[] = [];
	const spreads: number[] = [];
	for (let c = 0; c < 2; c++) {
		let axis = Float64Array.from({ length: d }, (_, j) => 1 + ((j * 7919) % 13) / 13);
		for (let iteration = 0; iteration < 80; iteration++) {
			const u = scores(axis);
			const next = new Float64Array(d);
			let total = 0;
			rows.forEach((row, i) => {
				const ui = u[i] ?? 0;
				total += ui;
				for (const [j, w] of row) next[j] = (next[j] ?? 0) + w * ui;
			});
			for (let j = 0; j < d; j++) next[j] = (next[j] ?? 0) - (mean[j] ?? 0) * total;
			// Deflation: remove the directions already found.
			for (const found of axes) {
				const overlap = dot(next, found);
				for (let j = 0; j < d; j++) next[j] = (next[j] ?? 0) - overlap * (found[j] ?? 0);
			}
			const length = Math.sqrt(dot(next, next));
			if (length === 0) break;
			axis = next.map((x) => x / length);
		}
		if ((axis[common] ?? 0) < 0) axis = axis.map((x) => -x);
		axes.push(axis);
		spreads.push(Math.sqrt(scores(axis).reduce((s, x) => s + x * x, 0) / n));
	}
	return { features: [...index.keys()], mean, axes: [axes[0] ?? new Float64Array(d), axes[1] ?? new Float64Array(d)], spreads: [spreads[0] ?? 0, spreads[1] ?? 0] };
}

/** A vector's place in the plane, each axis in units of its spread. */
export function placeInPlane(vector: Map<string, number>, plane: MeaningPlane): [number, number] {
	const coordinate = (c: 0 | 1) => {
		const axis = plane.axes[c];
		let s = 0;
		plane.features.forEach((feature, j) => {
			s += ((vector.get(feature) ?? 0) - (plane.mean[j] ?? 0)) * (axis[j] ?? 0);
		});
		const spread = plane.spreads[c];
		return spread > 1e-9 ? s / spread : 0;
	};
	return [coordinate(0), coordinate(1)];
}

/** A color from hue (degrees), saturation and lightness (0 to 1). */
export function hslColor(hue: number, saturation: number, lightness: number): number {
	const h = (((hue % 360) + 360) % 360) / 60;
	const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
	const x = c * (1 - Math.abs((h % 2) - 1));
	const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
	const m = lightness - c / 2;
	const to = (v: number) => Math.round((v + m) * 255);
	return (to(r) << 16) | (to(g) << 8) | to(b);
}

/**
 * The color of a place in the plane: its angle gives the hue, all around
 * the wheel; works near the middle (a mix of everything) are paler.
 */
export function colorOfPlace([x, y]: [number, number], lightness: number, intensity = 1): number {
	const hue = (Math.atan2(y, x) * 180) / Math.PI;
	const saturation = (0.35 + 0.5 * Math.min(1, Math.hypot(x, y) / 1.5)) * intensity;
	return hslColor(hue, Math.min(1, saturation), lightness);
}

/**
 * Colors of the works by topic, relative to the works given (the graph):
 * `topics[i]` → color, or null for a work without topics.
 */
export function topicColors(topics: (WorkTopics | undefined)[], info: (id: string) => TopicInfo | undefined, lightness = 0.6, intensity = 1): (number | null)[] {
	const vectors = topics.map((t) => (t && t.length > 0 ? topicVector(t, info) : null));
	const plane = meaningPlane(vectors.filter((v): v is Map<string, number> => v !== null));
	return vectors.map((v) => (v === null ? null : plane ? colorOfPlace(placeInPlane(v, plane), lightness, intensity) : hslColor(210, 0.6 * intensity, lightness)));
}

/**
 * The place of each work in the plane of meaning of the works given (in
 * units of the spread of each axis), or null for a work without topics: the
 * targets of the "topics" layout.
 */
export function meaningPlaces(topics: (WorkTopics | undefined)[], info: (id: string) => TopicInfo | undefined): ([number, number] | null)[] {
	const vectors = topics.map((t) => (t && t.length > 0 ? topicVector(t, info) : null));
	const plane = meaningPlane(vectors.filter((v): v is Map<string, number> => v !== null));
	return vectors.map((v) => (v && plane ? placeInPlane(v, plane) : null));
}

/** The color a single topic gets in the same plane (for the legend). */
export function topicLegendColors(ids: string[], works: (WorkTopics | undefined)[], info: (id: string) => TopicInfo | undefined, lightness = 0.6, intensity = 1): Map<string, number> {
	const plane = meaningPlane(works.filter((t) => t && t.length > 0).map((t) => topicVector(t, info)));
	return new Map(ids.map((id) => [id, plane ? colorOfPlace(placeInPlane(topicVector([[id, 1]], info), plane), lightness, intensity) : hslColor(210, 0.6 * intensity, lightness)]));
}

/** Colors mixed by weight (their average in RGB); null without any weight. */
export function blendColors(colors: { color: number; weight: number }[]): number | null {
	let total = 0;
	let r = 0;
	let g = 0;
	let b = 0;
	for (const { color, weight } of colors) {
		if (!(weight > 0)) continue;
		total += weight;
		r += ((color >> 16) & 0xff) * weight;
		g += ((color >> 8) & 0xff) * weight;
		b += (color & 0xff) * weight;
	}
	if (total === 0) return null;
	return (Math.round(r / total) << 16) | (Math.round(g / total) << 8) | Math.round(b / total);
}

/**
 * Colors for works without topics (notes OpenAlex does not know: books,
 * reports, laws) from the works that share their keywords: each colored work
 * counts as many times as the keywords (links) they share.
 */
export function colorsFromSharedKeywords<K>(keywords: Map<K, Set<string>>, colored: Map<K, number>): Map<K, number> {
	const result = new Map<K, number>();
	for (const [work, own] of keywords) {
		if (colored.has(work) || own.size === 0) continue;
		const mix: { color: number; weight: number }[] = [];
		for (const [other, color] of colored) {
			const theirs = keywords.get(other);
			if (!theirs) continue;
			let shared = 0;
			for (const k of own) if (theirs.has(k)) shared++;
			if (shared > 0) mix.push({ color, weight: shared });
		}
		const color = blendColors(mix);
		if (color !== null) result.set(work, color);
	}
	return result;
}

/** The topics most present, with their share of the works: the legend of the graph. */
export function mainTopics(works: (WorkTopics | undefined)[], limit: number): { id: string; works: number }[] {
	const counts = new Map<string, number>();
	for (const topics of works) {
		const main = topics?.[0]?.[0];
		if (main) counts.set(main, (counts.get(main) ?? 0) + 1);
	}
	return [...counts].map(([id, works]) => ({ id, works })).sort((a, b) => b.works - a.works).slice(0, limit);
}
