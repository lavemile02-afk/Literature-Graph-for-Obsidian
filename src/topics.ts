/**
 * Colors by topic. OpenAlex files every work under up to three topics, each
 * with a score, in a hierarchy: domain → field → subfield → topic (for
 * example Physical Sciences → Environmental Science → Ecology → "Peatlands and
 * Wetlands Ecology"). The topics present in the graph are put in an order
 * where related ones follow each other (by field, then subfield), then laid
 * along a color gradient: works on related topics get related hues, and a
 * work on several topics gets their colors mixed by score.
 *
 * No Obsidian or Pixi here: colors are numbers (0xrrggbb).
 */

import { mixColor } from './colors';

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

/**
 * OpenAlex's 26 fields, in an order where neighbors are related: social
 * sciences and humanities, health, life sciences, the environment and the
 * Earth, then the physical sciences, engineering and mathematics.
 */
export const FIELD_ORDER = [12, 33, 32, 20, 14, 18, 36, 29, 35, 27, 28, 34, 30, 24, 13, 11, 23, 19, 21, 15, 16, 25, 31, 22, 17, 26];

/** The gradients offered, as lists of colors ("custom": the user's colors). */
export const GRADIENTS: Record<string, { name: string; stops: string[] }> = {
	spectrum: { name: 'Soft spectrum', stops: ['#e15759', '#f28e2b', '#edc948', '#59a14f', '#76b7b2', '#4e79a7', '#b07aa1'] },
	viridis: { name: 'Viridis', stops: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'] },
	earth: { name: 'Earth', stops: ['#8c510a', '#bf812d', '#dfc27d', '#80cdc1', '#35978f', '#01665e'] },
	sunset: { name: 'Sunset', stops: ['#5c2a9d', '#9c3587', '#e53f71', '#f89c5b', '#f9e07f'] },
	ocean: { name: 'Ocean', stops: ['#1a2a6c', '#2166ac', '#4393c3', '#92c5de', '#a6dba0', '#5aae61'] },
};

/** The number in an OpenAlex id ("fields/23" → 23), or Infinity. */
function idNumber(id: string): number {
	const match = /(\d+)$/.exec(id);
	return match ? Number(match[1]) : Infinity;
}

/** Topics in an order where related ones follow each other: by field (see FIELD_ORDER), subfield, then id. */
export function orderTopics(ids: string[], info: (id: string) => TopicInfo | undefined): string[] {
	const fieldRank = (id: string) => {
		const field = info(id)?.field;
		const rank = field ? FIELD_ORDER.indexOf(idNumber(field)) : -1;
		return rank === -1 ? FIELD_ORDER.length : rank;
	};
	const key = (id: string): [number, number, number] => [fieldRank(id), idNumber(info(id)?.subfield ?? ''), idNumber(id)];
	return [...ids].sort((a, b) => {
		const ka = key(a);
		const kb = key(b);
		return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2] || a.localeCompare(b);
	});
}

/** The color at `t` (0 to 1) along a gradient of colors. */
export function sampleGradient(stops: number[], t: number): number {
	if (stops.length === 0) return 0x888888;
	if (stops.length === 1) return stops[0] ?? 0x888888;
	const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
	const i = Math.min(stops.length - 2, Math.floor(x));
	return mixColor(stops[i] ?? 0, stops[i + 1] ?? 0, x - i);
}

/**
 * A color for each topic present (`topics`: one entry per work having it).
 * The topics, in order, share the whole gradient, whatever the topics: each
 * gets a stretch that grows with the square root of its number of works, so
 * that the topics of a field of research are told apart rather than crowded
 * into one hue, and rare topics still get their own color.
 */
export function topicPalette(topics: Iterable<string>, info: (id: string) => TopicInfo | undefined, stops: number[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const id of topics) counts.set(id, (counts.get(id) ?? 0) + 1);
	const ordered = orderTopics([...counts.keys()], info);
	const weight = (id: string) => Math.sqrt(counts.get(id) ?? 1);
	const total = ordered.reduce((sum, id) => sum + weight(id), 0);
	let before = 0;
	const palette = new Map<string, number>();
	for (const id of ordered) {
		palette.set(id, sampleGradient(stops, (before + weight(id) / 2) / total));
		before += weight(id);
	}
	return palette;
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

/** A work's color: the colors of its topics mixed by score; null if none is in the palette. */
export function workColor(topics: WorkTopics | undefined, palette: Map<string, number>): number | null {
	if (!topics) return null;
	return blendColors(topics.flatMap(([id, score]) => {
		const color = palette.get(id);
		return color === undefined ? [] : [{ color, weight: score }];
	}));
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
