import { App, TFile } from 'obsidian';
import { citationText, familyNames } from './citationLink';
import { citationLinksIn } from './links';
import { resolveCitedNote } from './navigation';
import type { CitationLanguage, LiteratureGraphSettings } from './settings';

/**
 * Reference lists in APA 7th edition style, from the reference property of
 * each cited work (by default `Citation`), in English or in French (as in the
 * French adaptation used by many Québec universities: "et", "(dir.)",
 * "Dans", "(2e éd.)", "(Thèse de doctorat)").
 */

const ORDINAL_SUFFIX = (n: number): string => {
	if (n % 100 >= 11 && n % 100 <= 13) return 'th';
	return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
};

/** Number of names in a list such as "A. Smith, B. Jones et C. Doe". */
function nameCount(names: string): number {
	return names.split(/,\s*(?:&\s*)?|\s+(?:et|&)\s+/).filter((n) => /\p{L}/u.test(n)).length;
}

/** Joins the last name of a list with "&" (English) or "et" (French). */
function joinNames(names: string, language: CitationLanguage, familyFirst: boolean): string {
	const parts = names
		.split(/,?\s+(?:et|&)\s+/)
		.map((p) => p.trim())
		.filter(Boolean);
	if (parts.length < 2) return names;
	const last = parts.pop() ?? '';
	const head = parts.join(', ');
	if (language === 'fr') return `${head} et ${last}`;
	// APA: "Smith, J., & Jones, M." for authors; "J. Smith & M. Jones" for two editors.
	return familyFirst || nameCount(names) > 2 ? `${head}, & ${last}` : `${head} & ${last}`;
}

/** Converts a reference written in either language to the chosen language. */
export function localizeReference(reference: string, language: CitationLanguage): string {
	let ref = reference;
	const en = language === 'en';

	// Chapter editors: "Dans A. Smith et B. Jones (dir.)," / "In A. Smith & B. Jones (Eds.),"
	ref = ref.replace(
		/\b(?:Dans|In) ([^()]+?) \((?:dir\.|Eds?\.)\)/,
		(_m, editors: string) => {
			const list = joinNames(editors, language, false);
			const tag = en ? (nameCount(editors) > 1 ? 'Eds.' : 'Ed.') : 'dir.';
			return `${en ? 'In' : 'Dans'} ${list} (${tag})`;
		},
	);

	// Authors (or editors of a whole book) at the start, before the year or "(dir.)".
	ref = ref.replace(/^(.+?)(?= \((?:dir\.|Eds?\.|\d{4}|s\.d\.|n\.d\.))/, (authors: string) =>
		joinNames(authors, language, true),
	);
	ref = ref.replace(/^(.+?) \((?:dir\.|Eds?\.)\)/, (_m, authors: string) =>
		`${authors} (${en ? (familyNames(authors).length > 1 ? 'Eds.' : 'Ed.') : 'dir.'})`,
	);

	if (en) {
		ref = ref
			.replace(/\((\d+)e éd\.\)/g, (_m, n: string) => `(${n}${ORDINAL_SUFFIX(Number(n))} ed.)`)
			.replace(/\(Thèse de doctorat\)\. ([^.]+)\./g, '[Doctoral dissertation, $1].')
			.replace(/\(Mémoire de maîtrise\)\. ([^.]+)\./g, "[Master's thesis, $1].")
			.replace(/\[Prépublication\]/g, '[Preprint]')
			.replace(/\(s\.d\.\)/g, '(n.d.)')
			.replace(/\. Dans (?=_)/g, '. In ')
			.replace(/\(p\. (\d+\s*[–-])/g, '(pp. $1');
	} else {
		ref = ref
			.replace(/\((\d+)(?:st|nd|rd|th) ed\.\)/g, '($1e éd.)')
			.replace(/\[Doctoral dissertation, ([^\]]+)\]\./g, '(Thèse de doctorat). $1.')
			.replace(/\[Master's thesis, ([^\]]+)\]\./g, '(Mémoire de maîtrise). $1.')
			.replace(/\[Preprint\]/g, '[Prépublication]')
			.replace(/\(n\.d\.\)/g, '(s.d.)')
			.replace(/\. In (?=_)/g, '. Dans ')
			.replace(/\(pp\. /g, '(p. ');
	}
	return ref;
}

/** Sort key: letters without accents or case, so that APA alphabetical order holds. */
function sortKey(reference: string): string {
	return reference
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.replace(/[_*]/g, '')
		.toLowerCase();
}

export interface ReferenceList {
	/** The references, one paragraph each. */
	text: string;
	/** Citations that share a text and received letters, such as "Smith, 2020" → ["Smith, 2020a", "Smith, 2020b"]. */
	lettered: { citation: string; letters: string[] }[];
	/** Cited works that are not notes of the vault (DOI only, or broken links). */
	skipped: string[];
}

interface Entry {
	file: TFile;
	reference: string;
	citation: string;
}

/** Builds the reference list of the works cited by citation links in a note. */
export function buildReferenceList(
	app: App,
	noteText: string,
	settings: LiteratureGraphSettings,
	fileForDoi: (doi: string) => TFile | null,
): ReferenceList {
	const files = new Set<TFile>();
	const skipped = new Set<string>();
	for (const link of citationLinksIn(noteText)) {
		const { note, doi } = link.target;
		const cited = (note ? resolveCitedNote(app, note) : null) ?? (doi ? fileForDoi(doi) : null);
		if (cited) files.add(cited);
		else skipped.add(doi ? `https://doi.org/${doi}` : link.text);
	}

	const entries: Entry[] = [...files].map((file) => {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const read = (key: string): string => {
			const value: unknown = fm[key];
			return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
		};
		const stored = read(settings.referenceProperty);
		const reference = stored
			? localizeReference(stored, settings.citationLanguage)
			: `${read(settings.authorsProperty) || file.basename} (${read(settings.yearProperty) || (settings.citationLanguage === 'fr' ? 's.d.' : 'n.d.')}). ${read(settings.titleProperty) || file.basename}.`;
		return { file, reference, citation: citationText(app, file, settings) };
	});
	entries.sort((a, b) => (sortKey(a.reference) < sortKey(b.reference) ? -1 : 1));

	// Works with the same in-text citation get letters, in reference-list order.
	const lettered: ReferenceList['lettered'] = [];
	const groups = new Map<string, Entry[]>();
	for (const e of entries) groups.set(e.citation, [...(groups.get(e.citation) ?? []), e]);
	for (const [citation, group] of groups) {
		if (group.length < 2) continue;
		const letters: string[] = [];
		group.forEach((e, i) => {
			const letter = String.fromCharCode(97 + i);
			e.reference = e.reference.replace(/\((\d{4}|s\.d\.|n\.d\.)\)/, (_m, year: string) =>
				/\d/.test(year) ? `(${year}${letter})` : `(${year}-${letter})`,
			);
			letters.push(`${citation}${letter}`);
		});
		lettered.push({ citation, letters });
	}

	return {
		text: entries.map((e) => e.reference).join('\n\n'),
		lettered,
		skipped: [...skipped],
	};
}
