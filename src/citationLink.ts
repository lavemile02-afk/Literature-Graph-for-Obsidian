import { App, TFile } from 'obsidian';
import { CITE_URL_PREFIX, CitationTarget } from './citation';
import { findExactPassages } from './passage';
import type { LiteratureGraphSettings } from './settings';

/** Selections up to this many words are cited whole in `q`. */
const MAX_WORDS_IN_Q = 15;
/** Words kept at the start (`q`) and end (`qe`) of a longer selection. */
const START_WORDS = 12;
const END_WORDS = 6;

/**
 * Percent-encodes a URL parameter value, including the characters that
 * encodeURIComponent keeps but that would end a Markdown link: ( ) ! ' *.
 */
export function encodeParam(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

/** Family names from an authors string such as "Bourgeois, B., Vanasse, A.". */
export function familyNames(authors: string): string[] {
	return authors
		.split(/\s*[,;]\s*/)
		.map((part) => part.trim())
		.filter((part) => part !== '' && !/^(\p{Lu}\.[\s-]*)+$|^\p{Lu}$/u.test(part));
}

/** Adapts an in-text citation to the chosen language: "Smith & Jones" or "Smith et Jones". */
function localizeCitation(text: string, settings: LiteratureGraphSettings): string {
	if (settings.citationLanguage === 'fr') {
		return text.replace(/ (?:&|and) /g, ' et ').replace(/\bn\.d\./g, 's.d.');
	}
	return text.replace(/ et (?!al\.)/g, ' & ').replace(/\bs\.d\./g, 'n.d.');
}

/**
 * The citation text of a work, without parentheses: its citation text
 * property, or else one built from its authors and year, or else the note name.
 */
export function citationText(app: App, file: TFile, settings: LiteratureGraphSettings): string {
	if (settings.useNoteNameAsCitation) return file.basename;
	const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
	const read = (key: string): string => {
		const value: unknown = frontmatter[key];
		return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
	};

	const stored = read(settings.citationTextProperty).replace(/^\((.*)\)$/, '$1').trim();
	if (stored) return localizeCitation(stored, settings);

	const families = familyNames(read(settings.authorsProperty));
	if (families.length === 0) return file.basename;
	const fr = settings.citationLanguage === 'fr';
	const year = read(settings.yearProperty) || (fr ? 's.d.' : 'n.d.');
	const names =
		families.length === 1
			? families[0]
			: families.length === 2
				? `${families[0]} ${fr ? 'et' : '&'} ${families[1]}`
				: `${families[0]} et al.`;
	return `${names}, ${year}`;
}

/**
 * A selected passage without the marks that passage search ignores anyway
 * (emphasis marks, HTML tags), so that links stay readable.
 */
function plainPassage(markdown: string): string {
	return markdown
		.replace(/<\/?(?:br|p|div|li|td|th|tr|hr)\b[^<>]*>/gi, ' ')
		.replace(/<\/?[A-Za-z][^<>]*>/g, '')
		.replace(/[*_`~\\]/g, '');
}

/**
 * The `note` parameter for a file: its name when that name resolves to it
 * from anywhere in the vault, else its path without the extension.
 */
export function noteParam(app: App, file: TFile): string {
	return app.metadataCache.getFirstLinkpathDest(file.basename, '') === file
		? file.basename
		: file.path.replace(/\.md$/, '');
}

/**
 * Builds a citation link to the passage `text.slice(from, to)` of `file`:
 * `([Author et al., 2016](obsidian://cite?note=...&qe=...&q=...))`, with the
 * parentheses outside the link so that only the citation is clickable.
 */
export function buildCitationLink(
	app: App,
	file: TFile,
	text: string,
	from: number,
	to: number,
	settings: LiteratureGraphSettings,
): string | null {
	const words = plainPassage(text.slice(from, to)).trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return null;
	const long = words.length > MAX_WORDS_IN_Q;
	const q = (long ? words.slice(0, START_WORDS) : words).join(' ');
	const qe = long ? words.slice(-END_WORDS).join(' ') : undefined;

	// If the start of the passage occurs more than once, say which occurrence.
	const matches = findExactPassages(text, q);
	let occ: number | undefined;
	if (matches.length > 1) {
		let best = 0;
		matches.forEach((m, i) => {
			if (Math.abs(m.from - from) < Math.abs((matches[best]?.from ?? 0) - from)) best = i;
		});
		occ = best + 1;
	}

	const label = citationText(app, file, settings).replace(/([[\]])/g, '\\$1');
	return `([${label}](${citationUrl({ note: noteParam(app, file), occ, qe, q })}))`;
}

/**
 * The canonical (encoded) URL of a citation target, with its parameters in
 * the order note, doi, occ, qe, q; `q` is always last.
 */
export function citationUrl(target: CitationTarget): string {
	const params: string[] = [];
	if (target.note) params.push(`note=${encodeParam(target.note)}`);
	if (target.doi) params.push(`doi=${encodeParam(target.doi)}`);
	if (target.occ) params.push(`occ=${target.occ}`);
	if (target.qe) params.push(`qe=${encodeParam(target.qe)}`);
	if (target.q) params.push(`q=${encodeParam(target.q)}`);
	return CITE_URL_PREFIX + params.join('&');
}
