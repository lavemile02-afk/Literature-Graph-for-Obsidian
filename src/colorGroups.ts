import { App, getAllTags, TFile } from 'obsidian';

/**
 * Color groups of the literature graph, like the groups of Obsidian's graph
 * view: each group has a query and a color, and a note takes the color of the
 * first group it matches.
 *
 * Written one per line, "query = color", for example:
 *   tag:#litterature = #d9a441
 *   [Type:Livre] = rgb(120, 170, 220)
 *   path:Documents/Thèses = hsl(140, 40%, 55%)
 * Queries: tag:NAME (with or without #, nested tags included), path:TEXT
 * (text in the path), file:TEXT (text in the name), [PROPERTY:VALUE] (the
 * property contains the value), [PROPERTY] (the property is not empty), or
 * plain text (in the name or the title).
 */
export interface ColorGroup {
	query: string;
	color: string;
}

/** Reads the groups from their text form; lines starting with // are comments. */
export function parseColorGroups(text: string): ColorGroup[] {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('//'))
		.flatMap((line) => {
			const at = line.lastIndexOf('=');
			if (at <= 0) return [];
			const query = line.slice(0, at).trim();
			const color = line.slice(at + 1).trim();
			return query && color ? [{ query, color }] : [];
		});
}

/** Text of a property value, whatever its type, in lower case. */
function propertyText(value: unknown): string {
	if (Array.isArray(value)) return value.map(propertyText).join(' ');
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return String(value).toLowerCase();
	}
	return '';
}

/** A test for one query. */
export function queryMatcher(app: App, query: string, titleProperty: string): (file: TFile) => boolean {
	const q = query.trim();
	const lower = q.toLowerCase();
	const cacheOf = (file: TFile) => app.metadataCache.getFileCache(file);

	if (lower.startsWith('tag:')) {
		const tag = `#${lower.slice(4).replace(/^#/, '')}`;
		return (file) => {
			const cache = cacheOf(file);
			const tags = cache ? (getAllTags(cache) ?? []) : [];
			return tags.some((t) => {
				const x = t.toLowerCase();
				return x === tag || x.startsWith(`${tag}/`);
			});
		};
	}
	if (lower.startsWith('path:')) {
		const text = lower.slice(5);
		return (file) => file.path.toLowerCase().includes(text);
	}
	if (lower.startsWith('file:')) {
		const text = lower.slice(5);
		return (file) => file.basename.toLowerCase().includes(text);
	}
	const property = /^\[([^:\]]+)(?::([^\]]*))?\]$/.exec(q);
	if (property) {
		const key = (property[1] ?? '').trim();
		const value = property[2]?.trim().toLowerCase();
		return (file) => {
			const text = propertyText(cacheOf(file)?.frontmatter?.[key]);
			return value === undefined ? text !== '' : text.includes(value);
		};
	}
	return (file) => {
		const title = propertyText(cacheOf(file)?.frontmatter?.[titleProperty]);
		return file.basename.toLowerCase().includes(lower) || title.includes(lower);
	};
}

/** The color of the first group a note matches, or null. */
export function colorFor(
	app: App,
	groups: ColorGroup[],
	titleProperty: string,
): (file: TFile) => string | null {
	const tests = groups.map((g) => ({ test: queryMatcher(app, g.query, titleProperty), color: g.color }));
	return (file) => tests.find((t) => t.test(file))?.color ?? null;
}
