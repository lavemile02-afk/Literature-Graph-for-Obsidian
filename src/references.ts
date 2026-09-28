import { App, TFile } from 'obsidian';
import { ApaWork, InTextCitation, apaCitations, compareApa, parseAuthors } from './apa';
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
			.replace(/([.?!]) Dans (?=_)/g, '$1 In ')
			.replace(/\(p\. (\d+\s*[–-])/g, '(pp. $1');
	} else {
		ref = ref
			.replace(/\((\d+)(?:st|nd|rd|th) ed\.\)/g, '($1e éd.)')
			.replace(/\[Doctoral dissertation, ([^\]]+)\]\./g, '(Thèse de doctorat). $1.')
			.replace(/\[Master's thesis, ([^\]]+)\]\./g, '(Mémoire de maîtrise). $1.')
			.replace(/\[Preprint\]/g, '[Prépublication]')
			.replace(/\(n\.d\.\)/g, '(s.d.)')
			.replace(/([.?!]) In (?=_)/g, '$1 Dans ')
			.replace(/\(pp\. /g, '(p. ');
	}
	return ref;
}

export interface ReferenceList {
	/** The references, one paragraph each, in APA order. */
	text: string;
	/** In-text citation of each cited work (without parentheses), by note path, following APA 7. */
	citations: Map<string, string>;
	/** Works whose citation needs more than the usual form: more names, initials or a letter. */
	disambiguated: { path: string; citation: string }[];
	/** Cited works that are not notes of the vault (DOI only, or broken links). */
	skipped: string[];
}

/** The works cited by citation links in a note: notes of the vault, and the rest. */
export function citedWorks(
	app: App,
	noteText: string,
	fileForDoi: (doi: string) => TFile | null,
): { files: TFile[]; skipped: string[] } {
	const files = new Set<TFile>();
	const skipped = new Set<string>();
	for (const link of citationLinksIn(noteText)) {
		const { note, doi } = link.target;
		const cited = (note ? resolveCitedNote(app, note) : null) ?? (doi ? fileForDoi(doi) : null);
		if (cited) files.add(cited);
		else skipped.add(doi ? `https://doi.org/${doi}` : link.text);
	}
	return { files: [...files], skipped: [...skipped] };
}

/** What APA needs about a work, from the note's properties. */
export function apaWorkOf(app: App, file: TFile, settings: LiteratureGraphSettings): ApaWork {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
	const read = (key: string): string => {
		const value: unknown = fm[key];
		return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
	};
	return {
		id: file.path,
		authors: parseAuthors(read(settings.authorsProperty)),
		year: read(settings.yearProperty),
		title: read(settings.titleProperty) || file.basename,
	};
}

/**
 * In-text citations of the works a note cites, following APA 7: the usual
 * citation, or more names, initials or a letter when two works would share it.
 */
export function inTextCitations(
	app: App,
	files: TFile[],
	settings: LiteratureGraphSettings,
): Map<string, InTextCitation & { usual: string }> {
	const works = files.map((f) => apaWorkOf(app, f, settings));
	const apa = apaCitations(works, settings.citationLanguage);
	const result = new Map<string, InTextCitation & { usual: string }>();
	for (const file of files) {
		const computed = apa.get(file.path);
		// Without authors in the properties, keep the stored citation text.
		const usual = citationText(app, file, settings);
		const hasAuthors = (works.find((w) => w.id === file.path)?.authors.length ?? 0) > 0;
		const label = computed && hasAuthors ? computed.label : usual;
		result.set(file.path, { label, letter: computed?.letter ?? '', usual });
	}
	return result;
}

/** Builds the reference list of the works cited by citation links in a note. */
export function buildReferenceList(
	app: App,
	noteText: string,
	settings: LiteratureGraphSettings,
	fileForDoi: (doi: string) => TFile | null,
): ReferenceList {
	const { files, skipped } = citedWorks(app, noteText, fileForDoi);
	const works = new Map(files.map((f) => [f.path, apaWorkOf(app, f, settings)]));
	const citations = inTextCitations(app, files, settings);
	const noDate = settings.citationLanguage === 'fr' ? 's.d.' : 'n.d.';

	const sorted = [...files].sort((a, b) => {
		const x = works.get(a.path);
		const y = works.get(b.path);
		return x && y ? compareApa(x, y) : 0;
	});
	const references = sorted.map((file) => {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const stored: unknown = fm[settings.referenceProperty];
		const work = works.get(file.path);
		let reference =
			typeof stored === 'string' && stored.trim()
				? localizeReference(stored.trim(), settings.citationLanguage)
				: `${(fm[settings.authorsProperty] as string | undefined) ?? file.basename} (${work?.year || noDate}). ${work?.title ?? file.basename}.`;
		const letter = citations.get(file.path)?.letter;
		if (letter) {
			reference = reference.replace(/\((\d{4}|s\.d\.|n\.d\.)\)/, (_m, year: string) =>
				/\d/.test(year) ? `(${year}${letter})` : `(${year}-${letter})`,
			);
		}
		return reference;
	});

	const disambiguated = sorted
		.map((f) => ({ path: f.path, citation: citations.get(f.path)?.label ?? '', usual: citations.get(f.path)?.usual ?? '' }))
		.filter((c) => c.citation !== c.usual)
		.map(({ path, citation }) => ({ path, citation }));
	return {
		text: references.join('\n\n'),
		citations: new Map([...citations].map(([path, c]) => [path, c.label])),
		disambiguated,
		skipped,
	};
}
