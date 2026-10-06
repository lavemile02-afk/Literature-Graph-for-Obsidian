/**
 * Colors of the works and OpenAlex's topics.
 *
 * A work's color comes from its place in the plane of meaning (see
 * `meaning.ts`): the hue is the angle of the place, all around the color
 * wheel, so the colors are relative to the diversity of the works shown.
 * OpenAlex files every work under up to three topics, in a hierarchy
 * (domain → field → subfield → topic); the topics serve the legend.
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

/** The name to show for a topic id. */
export function topicName(id: string, info: (id: string) => TopicInfo | undefined): string {
	return info(id)?.name ?? id;
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
export function colorOfPlace([x, y]: [number, number], lightness: number, intensity = 1, hueOf: (angle: number) => number = (a) => (a * 180) / Math.PI): number {
	const hue = hueOf(Math.atan2(y, x));
	const saturation = (0.35 + 0.5 * Math.min(1, Math.hypot(x, y) / 1.5)) * intensity;
	return hslColor(hue, Math.min(1, saturation), lightness);
}

/**
 * The hue (degrees) of an angle on the map, so that hues are spread evenly
 * over the works of `angles` (the works the map was learned on): the share
 * of those works at a smaller angle, times 360. Works crowded on one side of
 * the map would otherwise take only part of the color wheel.
 */
export function evenHues(angles: number[]): (angle: number) => number {
	const sorted = [...angles].sort((a, b) => a - b);
	const n = sorted.length;
	if (n < 2) return (a) => (a * 180) / Math.PI;
	return (a) => {
		let lo = 0;
		let hi = n;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if ((sorted[mid] ?? 0) < a) lo = mid + 1;
			else hi = mid;
		}
		// Between the two angles around it, in proportion.
		const before = sorted[lo - 1] ?? (sorted[n - 1] ?? 0) - 2 * Math.PI;
		const after = sorted[lo] ?? (sorted[0] ?? 0) + 2 * Math.PI;
		const share = after > before ? (a - before) / (after - before) : 0;
		return ((lo - 1 + share + 0.5) / n) * 360;
	};
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
