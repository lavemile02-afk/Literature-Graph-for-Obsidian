/**
 * The note of a work that is not in the vault yet (its "ghost note"): the
 * values of its properties, from OpenAlex or from a reference-list entry,
 * and a template (written in the settings) that they fill.
 *
 * Nothing here knows about Obsidian: it turns data into text.
 */
import type { WorkDetails } from './openalex';
import { surnameOf } from './openalex';

export type Language = 'en' | 'fr';

/** What a template can use, as {{name}}. */
export interface WorkValues {
	title: string;
	/** In-text citation with its parentheses: "(Robert et al., 1999)". */
	citationText: string;
	/** Full reference, APA 7 (English, or the French adaptation of the FSAA). */
	citation: string;
	/** "Robert, É. C., Rochefort, L., Garneau, M." */
	authors: string;
	year: string;
	type: string;
	journal: string;
	volume: string;
	issue: string;
	pages: string;
	publisher: string;
	issn: string;
	doi: string;
	/** A link to the work, only when it has no DOI. */
	url: string;
	language: string;
	abstract: string;
	/** Its topics on OpenAlex, most relevant first (a list property; empty when unknown). */
	topics: string[];
	/** Its keywords on OpenAlex, most relevant first (a list property; empty when unknown). */
	keywords: string[];
	/** Name for the note's file: the in-text citation without parentheses. */
	fileName: string;
}

/** Initials of given names: "Élisabeth Claire" → "É. C.", "Jean-Pierre" → "J.-P.". */
export function initials(given: string): string {
	return given
		.split(/\s+/)
		.filter(Boolean)
		.map((name) =>
			name
				.split('-')
				.filter(Boolean)
				.map((part) => `${[...part][0]?.toUpperCase() ?? ''}.`)
				.join('-'),
		)
		.join(' ');
}

/** "Élisabeth Claire Robert" → { family: "Robert", initials: "É. C." }. */
export function splitName(fullName: string): { family: string; initials: string } {
	const family = surnameOf(fullName);
	const given = fullName.trim().slice(0, Math.max(0, fullName.trim().length - family.length)).trim();
	return { family, initials: initials(given) };
}

/** "(Robert, 1999)", "(Robert et Rochefort, 1999)", "(Robert et al., 1999)". */
export function inTextCitation(families: string[], year: string, language: Language): string {
	const y = year || (language === 'fr' ? 's.d.' : 'n.d.');
	if (families.length === 0) return `(${y})`;
	if (families.length === 1) return `(${families[0]}, ${y})`;
	if (families.length === 2) return `(${families[0]} ${language === 'fr' ? 'et' : '&'} ${families[1]}, ${y})`;
	return `(${families[0]} et al., ${y})`;
}

/**
 * Authors of a reference, APA 7: "Robert, É. C., Rochefort, L. et Garneau, M."
 * in French (FSAA), "Robert, É. C., Rochefort, L., & Garneau, M." in English;
 * the first 19 and the last when there are more than 20.
 */
export function referenceAuthors(names: { family: string; initials: string }[], language: Language): string {
	const each = names.map((n) => (n.initials ? `${n.family}, ${n.initials}` : n.family));
	if (each.length === 0) return '';
	if (each.length === 1) return each[0] ?? '';
	if (each.length > 20) return `${each.slice(0, 19).join(', ')}, … ${each[each.length - 1] ?? ''}`;
	const last = each[each.length - 1] ?? '';
	const rest = each.slice(0, -1).join(', ');
	return language === 'fr' ? `${rest} et ${last}` : `${rest}, & ${last}`;
}

const TYPES: Record<string, { en: string; fr: string }> = {
	article: { en: 'Article', fr: 'Article' },
	review: { en: 'Article', fr: 'Article' },
	letter: { en: 'Article', fr: 'Article' },
	book: { en: 'Book', fr: 'Livre' },
	'book-chapter': { en: 'Chapter', fr: 'Chapitre' },
	dissertation: { en: 'Thesis', fr: 'Thèse' },
	report: { en: 'Report', fr: 'Rapport' },
	preprint: { en: 'Preprint', fr: 'Prépublication' },
};

/** The values of a work known to OpenAlex. */
export function valuesFromDetails(work: WorkDetails, language: Language): WorkValues {
	const names = work.authors.map(splitName);
	const year = work.year ? String(work.year) : '';
	const pages = work.firstPage ? (work.lastPage && work.lastPage !== work.firstPage ? `${work.firstPage}-${work.lastPage}` : work.firstPage) : '';
	const citationText = inTextCitation(
		names.map((n) => n.family),
		year,
		language,
	);
	const isBook = work.type === 'book' || work.type === 'dissertation' || work.type === 'report';
	// The reference: authors (year). Title. Journal, volume(issue), pages. DOI.
	const parts: string[] = [];
	const authors = referenceAuthors(names, language);
	parts.push(`${authors ? `${authors} ` : ''}(${year || (language === 'fr' ? 's.d.' : 'n.d.')}).`);
	parts.push(isBook ? `_${work.title}_.` : `${work.title}.`);
	if (!isBook && work.journal) {
		let source = `_${work.journal}_`;
		if (work.volume) source += `, _${work.volume}_`;
		if (work.issue) source += `(${work.issue})`;
		if (pages) source += `, ${pages.replace('-', '–')}`;
		parts.push(`${source}.`);
	} else if (work.publisher) {
		parts.push(`${work.publisher}.`);
	}
	if (work.doi) parts.push(`https://doi.org/${work.doi}`);
	else if (work.openAccessUrl) parts.push(work.openAccessUrl);
	return {
		title: work.title,
		citationText,
		citation: parts.join(' '),
		authors: names.map((n) => (n.initials ? `${n.family}, ${n.initials}` : n.family)).join(', '),
		year,
		type: work.type ? (TYPES[work.type]?.[language] ?? '') : '',
		journal: isBook ? '' : (work.journal ?? ''),
		volume: work.volume ?? '',
		issue: work.issue ?? '',
		pages,
		publisher: work.publisher ?? '',
		issn: work.issn ?? '',
		doi: work.doi ?? '',
		url: work.doi ? '' : (work.openAccessUrl ?? work.pdfUrl ?? ''),
		language: work.language ?? '',
		abstract: work.abstract ?? '',
		topics: [],
		keywords: [],
		fileName: fileNameOf(citationText),
	};
}

/**
 * The values of a work known only from a reference list (no DOI): its title,
 * year and label, and the entry itself as its reference.
 */
export function valuesFromEntry(entry: { text: string; title: string; label: string; year: string }): WorkValues {
	return {
		title: entry.title,
		citationText: `(${entry.label})`,
		citation: entry.text,
		authors: '',
		year: entry.year,
		type: '',
		journal: '',
		volume: '',
		issue: '',
		pages: '',
		publisher: '',
		issn: '',
		doi: '',
		url: '',
		language: '',
		abstract: '',
		topics: [],
		keywords: [],
		fileName: fileNameOf(`(${entry.label})`),
	};
}

/** A file name from an in-text citation: no parentheses, nor characters a file name cannot have. */
export function fileNameOf(citationText: string): string {
	return citationText
		.replace(/^\(|\)$/g, '')
		.replace(/[\\/:*?"<>|#^[\]]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** A value inside a YAML string between double quotes. */
function yamlQuoted(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s*\n\s*/g, ' ');
}

/**
 * The note's text from its template. In a property line such as
 * `Titre: "{{title}}"`, the value is written as a YAML string, and an empty
 * value leaves the property empty (`Journal:`); elsewhere, {{name}} is
 * replaced as it is. Unknown names are left empty.
 */
export function fillTemplate(template: string, values: WorkValues): string {
	const raw = (name: string): unknown => (values as unknown as Record<string, unknown>)[name];
	const value = (name: string) => {
		const v = raw(name);
		return typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : '';
	};
	let inFrontmatter = false;
	return template
		.split('\n')
		.map((line, i) => {
			if (line.trim() === '---') {
				inFrontmatter = i === 0 ? true : false;
				return line;
			}
			const property = inFrontmatter ? /^(\s*[^:#]+:)\s*"?\{\{(\w+)\}\}"?\s*$/.exec(line) : null;
			if (property) {
				// A list (the topics): one item per line, or an empty property.
				const list = raw(property[2] ?? '');
				if (Array.isArray(list)) {
					const items = list.map((item) => `  - "${yamlQuoted(String(item))}"`);
					return [property[1] ?? '', ...items].join('\n');
				}
				const v = value(property[2] ?? '');
				return v ? `${property[1]} "${yamlQuoted(v)}"` : (property[1] ?? '');
			}
			return line.replace(/\{\{(\w+)\}\}/g, (_, name: string) => value(name));
		})
		.join('\n');
}

/** The default template, with the property names of the settings. */
export function defaultTemplate(names: { title: string; citationText: string; authors: string; year: string; doi: string; keywords: string }): string {
	return [
		'---',
		`${names.title}: "{{title}}"`,
		`${names.citationText}: "{{citationText}}"`,
		'citation: "{{citation}}"',
		`${names.authors}: "{{authors}}"`,
		`${names.year}: "{{year}}"`,
		'type: "{{type}}"',
		'journal: "{{journal}}"',
		`${names.doi}: "{{doi}}"`,
		'url: "{{url}}"',
		`${names.keywords}: {{keywords}}`,
		'---',
		'',
		'{{abstract}}',
		'',
	].join('\n');
}
