/**
 * Reading the reference list of a literature note converted to Markdown
 * (papers or books converted from PDF), without changing the note.
 *
 * A reference section is found by its heading ("References", "Literature
 * cited", "Références bibliographiques"...); a book may have one per chapter.
 * Each line of the section that has a year is an entry, from which the first
 * author, the year and the DOI are read when present.
 */

/** One entry of a reference list. */
export interface BibEntry {
	/** Line number in the note, starting at 0. */
	line: number;
	/** The entry as written, without its list marker. */
	text: string;
	/** Family name of the first author, as written ("Van den Brink"). */
	firstAuthor: string | null;
	/** Year, without a letter ("2016" for "2016b"). */
	year: string | null;
	/** DOI, lower case, when the entry has one. */
	doi: string | null;
	/** Family names of the authors, reduced by `nameKey`; "et al." ends the list. */
	authors: string[];
	/** Whether the author list ends with "et al." (so it is incomplete). */
	etAl: boolean;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const SECTION_TITLE =
	/^(?:\d+(?:\.\d+)*\.?\s+)?(references(?: cited)?|literature cited|cited literature|works cited|bibliography|bibliographie|references and notes|références(?: bibliographiques| citées)?|liste des références|literatur(?:verzeichnis)?)\s*:?$/i;
const BOLD_TITLE = /^\*\*([^*]+)\*\*\s*:?\s*$/;
const LIST_MARKER = /^(?:[-*+]\s+|\d{1,4}[.)]\s+|\[\d{1,4}\]\s*)/;
// A DOI may contain balanced parentheses: 10.1016/s0022-1694(97)00037-1.
const DOI = /\b10\.\d{4,9}\/(?:[^\s"'<>[\],;()]+|\([^\s()<>]*\))+/i;
const YEAR_IN_PARENS = /\((1[5-9]\d{2}|20\d{2})[a-z]?[),]/;
const YEAR = /\b(1[5-9]\d{2}|20\d{2})[a-z]?\b/;

/** Heading text without HTML tags, emphasis marks or anchors. */
function plainHeading(text: string): string {
	return text
		.replace(/<[^<>]*>/g, '')
		.replace(/[*_`]/g, '')
		.replace(/\{#[^}]*\}\s*$/, '')
		.trim();
}

/** Whether a heading (or a bold line) opens a reference section. */
export function isReferenceHeading(text: string): boolean {
	return SECTION_TITLE.test(plainHeading(text));
}

/** An initial or a group of initials: "J", "AK", "J.", "J.E.P.", "M.-A.". */
const INITIALS = /^(?:\p{Lu}{1,3}|(?:\p{Lu}\.[\s-]*)+\p{Lu}?\.?)$/u;

/**
 * The family name in one author of a reference list, whatever the style:
 * "Keller J", "Keller, J.", "J. Keller", "Heikkinen J. E. P.", "Van den Brink".
 * Initials before and after the name are dropped; returns '' for initials alone.
 */
export function familyOf(author: string): string {
	const all = author.replace(/[()]/g, ' ').trim().split(/\s+/).filter(Boolean);
	const tokens = [...all];
	while (tokens.length > 0 && INITIALS.test(tokens[0] ?? '')) tokens.shift();
	while (tokens.length > 0 && INITIALS.test(tokens[tokens.length - 1] ?? '')) tokens.pop();
	const name = tokens.join(' ');
	if (name) return name;
	// A short all-capitals author is initials; a longer one is a group (WHO, FAO).
	const whole = all.join(' ');
	return /^\p{Lu}{3,}$/u.test(whole) ? whole : '';
}

/** Reads one entry; null when the line does not look like a reference. */
export function parseEntry(raw: string, line: number): BibEntry | null {
	let text = raw.trim();
	for (let i = 0; i < 2; i++) text = text.replace(LIST_MARKER, '').trim();
	if (text.length < 20 || text.startsWith('![') || text.startsWith('|') || text.startsWith('<')) return null;
	const head = text.slice(0, 200);
	const year = (YEAR_IN_PARENS.exec(head) ?? YEAR.exec(head))?.[1] ?? null;
	const doiMatch = DOI.exec(text);
	const doi = doiMatch ? doiMatch[0].replace(/[.]+$/, '').toLowerCase() : null;
	if (!year && !doi) return null;

	// The first author is what comes before the first comma (or before the
	// year when there is no comma), if it looks like a name.
	const plain = text.replace(/[*_]/g, '');
	const cut = plain.search(/,|\s\(|\s(?:1[5-9]|20)\d{2}\b/);
	const candidate = familyOf(cut > 0 ? plain.slice(0, cut) : '');
	const firstAuthor = /^[\p{L}][\p{L}'’. -]{0,40}$/u.test(candidate) && !/\d/.test(candidate) ? candidate : null;

	// Authors: the part before the year, split on commas, "&", "and", "et".
	const yearAt = year ? plain.indexOf(year) : -1;
	const authorPart = yearAt > 0 ? plain.slice(0, yearAt) : '';
	const etAl = /\bet al\b/i.test(authorPart);
	const authors = firstAuthor
		? authorPart
				.replace(/\bet al\b.*$/i, '')
				.split(/\s*(?:,|;|&|\band\b|\bet\b)\s*/)
				.map(familyOf)
				.filter((p) => /\p{L}{2}/u.test(p))
				.map(nameKey)
				.filter(Boolean)
		: [];
	return { line, text, firstAuthor, year, doi, authors, etAl };
}

/** What is known of a work of the vault, to match reference entries against. */
export interface VaultWork {
	/** Family names of the authors, reduced by `nameKey`. */
	authors: string[];
	year: string;
	title: string;
	doi: string | null;
}

/** Words of a title that are worth comparing (four letters or more). */
function titleWords(text: string): string[] {
	return text
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.split(/[^\p{L}]+/u)
		.filter((w) => w.length >= 4);
}

/** Share of a title's words (four letters or more) found in a text. */
export function titleOverlap(title: string, text: string): number {
	const words = titleWords(title);
	if (words.length === 0) return 0;
	const inText = new Set(titleWords(text));
	return words.filter((w) => inText.has(w)).length / words.length;
}

/** Share of the title's words that the entry must contain to match by author and year. */
const MIN_TITLE_OVERLAP = 0.6;

/**
 * Whether an entry is this work of the vault: same DOI, or same first author
 * and year and, to rule out other works of the same author and year, most of
 * the title's words (or, without a title, the same list of authors).
 */
export function entryMatches(entry: BibEntry, work: VaultWork): boolean {
	if (entry.doi && work.doi) return entry.doi === work.doi;
	if (!entry.year || entry.year !== work.year) return false;
	if (entry.authors.length === 0 || work.authors.length === 0 || entry.authors[0] !== work.authors[0]) return false;
	if (work.title) return titleOverlap(work.title, entry.text) >= MIN_TITLE_OVERLAP;
	if (entry.etAl) return work.authors.length >= 3;
	return entry.authors.length === work.authors.length && entry.authors.every((a, i) => a === work.authors[i]);
}

/** The entries of every reference section of a note, outside code blocks. */
export function bibliographyEntries(noteText: string): BibEntry[] {
	const entries: BibEntry[] = [];
	let sectionLevel: number | null = null;
	let inCode = false;
	noteText.split('\n').forEach((raw, index) => {
		const line = raw.trimEnd();
		if (/^\s*(```|~~~)/.test(line)) inCode = !inCode;
		if (inCode) return;
		const heading = HEADING.exec(line);
		if (heading) {
			const level = heading[1]?.length ?? 1;
			if (isReferenceHeading(heading[2] ?? '')) sectionLevel = level;
			else if (sectionLevel !== null && level <= sectionLevel) sectionLevel = null;
			return;
		}
		const bold = BOLD_TITLE.exec(line.trim());
		if (bold && isReferenceHeading(bold[1] ?? '')) {
			sectionLevel = 7; // ends at the next heading of any level
			return;
		}
		if (sectionLevel === null) return;
		const entry = parseEntry(line, index);
		if (entry) entries.push(entry);
	});
	return entries;
}

/** A family name reduced for comparison: no accents, case, spaces or punctuation. */
export function nameKey(name: string): string {
	return name
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}]/gu, '');
}
