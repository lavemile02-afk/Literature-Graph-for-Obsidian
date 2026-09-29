import { App, getAllTags, TFile, TFolder } from 'obsidian';

/**
 * What the queries of color groups can name, taken from the notes of the
 * graph: their tags, their properties with their values, and their folders.
 */
export interface QueryData {
	/** Tags, without "#". */
	tags: string[];
	/** Property names, with the values the notes give them. */
	properties: Map<string, string[]>;
	/** Folder paths. */
	folders: string[];
}

/** Values of a property that are worth offering: short strings and numbers. */
function propertyValues(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(propertyValues);
	if (typeof value === 'string') {
		const text = value.trim();
		return text && text.length <= 60 && !text.includes('\n') ? [text] : [];
	}
	if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
	return [];
}

/** The tags, properties and folders of the given notes, sorted. */
export function collectQueryData(app: App, files: TFile[]): QueryData {
	const tags = new Set<string>();
	const properties = new Map<string, Set<string>>();
	const folders = new Set<string>();
	for (const file of files) {
		const cache = app.metadataCache.getFileCache(file);
		for (const tag of cache ? (getAllTags(cache) ?? []) : []) tags.add(tag.replace(/^#/, ''));
		for (const [key, value] of Object.entries(cache?.frontmatter ?? {})) {
			if (key === 'position') continue;
			const values = properties.get(key) ?? new Set<string>();
			for (const v of propertyValues(value)) values.add(v);
			properties.set(key, values);
		}
		let folder: TFolder | null = file.parent;
		while (folder && !folder.isRoot()) {
			folders.add(folder.path);
			folder = folder.parent;
		}
	}
	const sorted = (values: Iterable<string>) => [...values].sort((a, b) => a.localeCompare(b));
	return {
		tags: sorted(tags),
		properties: new Map(sorted(properties.keys()).map((k) => [k, sorted(properties.get(k) ?? [])])),
		folders: sorted(folders),
	};
}

/** At most this many suggestions are offered. */
const MAX_SUGGESTIONS = 50;

/**
 * Completions of a color-group query being typed:
 * - "tag:" (or "tag:#pe") → the tags ("tag:#peat");
 * - "[" or "[Ty" → the properties ("[Type" and "[Type:" to go on);
 * - "[Type:" or "[Type:Li" → the values of the property ("[Type:Livre]");
 * - "path:" → the folders;
 * - anything else → the kinds of queries that start like it.
 * Matching ignores case and accents, and a part typed anywhere in a name.
 */
export function querySuggestions(input: string, data: QueryData): string[] {
	const norm = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
	const pick = (values: string[], typed: string, make: (v: string) => string) => {
		const t = norm(typed);
		const starts = values.filter((v) => norm(v).startsWith(t));
		const inside = values.filter((v) => !norm(v).startsWith(t) && norm(v).includes(t));
		return [...starts, ...inside].slice(0, MAX_SUGGESTIONS).map(make);
	};

	const tag = /^tag:\s*#?(.*)$/i.exec(input);
	if (tag) return pick(data.tags, tag[1] ?? '', (t) => `tag:#${t}`);

	const value = /^\[([^\]:]+):\s*([^\]]*)$/.exec(input);
	if (value) {
		const key = [...data.properties.keys()].find((k) => norm(k) === norm((value[1] ?? '').trim()));
		if (!key) return [];
		return pick(data.properties.get(key) ?? [], value[2] ?? '', (v) => `[${key}:${v}]`);
	}

	const property = /^\[([^\]:]*)$/.exec(input);
	if (property) {
		const keys = pick([...data.properties.keys()], property[1] ?? '', (k) => k);
		// Each property twice: to pick a value ("[Type:"), or any value ("[Type]").
		return keys.flatMap((k) => [`[${k}:`, `[${k}]`]).slice(0, MAX_SUGGESTIONS);
	}

	const path = /^path:\s*(.*)$/i.exec(input);
	if (path) return pick(data.folders, path[1] ?? '', (f) => `path:${f}`);

	const kinds = ['tag:#', '[', 'path:', 'file:'];
	return kinds.filter((k) => k.startsWith(norm(input)) && k !== input);
}
