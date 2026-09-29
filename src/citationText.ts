import { App, TFile } from 'obsidian';
import type { LiteratureGraphSettings } from './settings';

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
 * The citation of a work, without parentheses, used to label it in the graph
 * and the panel: its citation text property, or else one built from its
 * authors and year, or else the note name.
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
