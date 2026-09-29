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
	/^(?:\d+(?:\.\d+)*\.?\s+)?(references(?: cited)?|literature cited|cited literature|works cited|bibliography|bibliographie|references and notes|further readings?|suggested readings?|sources|références(?: bibliographiques| citées| directes)?|liste des références|lectures suggérées|lectures complémentaires|literatur(?:verzeichnis)?)\s*:?$/i;
const BOLD_TITLE = /^\*\*([^*]+)\*\*\s*:?\s*$/;
// List markers and numbering: "- ", "12. ", "12) ", "[12]", "**30** ", and "12 " before a capital ("1 IUCN (1980)").
const LIST_MARKER = /^(?:[-*+]\s+|\d{1,4}[.)]\s+|\[\d{1,4}\]\s*|\*\*\d{1,4}\*\*\s+|\d{1,3}\s+(?=\p{Lu}))/u;
// Editor marks after a name: "(ed)", "(eds.)", "(dir.)", "(Hrsg.)".
const EDITOR_MARK = /\((?:eds?|dir|hrsg)\.?\)/gi;
// A DOI may contain balanced parentheses: 10.1016/s0022-1694(97)00037-1.
const DOI = /\b10\.\d{4,9}\/(?:[^\s"'<>[\],;()]+|\([^\s()<>]*\))+/i;
const YEAR_IN_PARENS = /\((1[5-9]\d{2}|20\d{2})[a-z]?[),]/;
const YEAR = /\b(1[5-9]\d{2}|20\d{2})[a-z]?\b/;

/**
 * Heading text without HTML tags, emphasis marks or anchors. HTML tags are
 * written in lower case; a word in capitals between angle brackets is text
 * ("<BIBLIOGRAPHIE>").
 */
function plainHeading(text: string): string {
	return text
		.replace(/<(\/?)([^<>]*)>/g, (tag: string, _slash: string, inner: string) => (/^\p{Lu}+$/u.test(inner) ? inner : ''))
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
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

/**
 * The text of an entry with what hides the characters of a DOI undone:
 * Markdown escapes left by the conversion ("10.1016/s0022-1694\(97\)…") and
 * percent-encoding copied from a URL ("…10:10%3c1263::aid-hyp458%3e3.0.co").
 */
export function unescapeDoiText(text: string): string {
	return text
		.replace(/\\([()[\]_<>;])/g, '$1')
		.replace(/%(2[89]|3[bcde]|5[bd]|2f)/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Reads one entry; null when the line does not look like a reference. */
export function parseEntry(raw: string, line: number): BibEntry | null {
	let text = raw.trim();
	for (let i = 0; i < 2; i++) text = text.replace(LIST_MARKER, '').trim();
	// Anchors left by the PDF conversion: <span id="page-14-2"></span>Autio, A.…
	text = text.replace(/^(?:<(?:span|a)\b[^<>]*>\s*<\/(?:span|a)>\s*)+/i, '').trim();
	for (let i = 0; i < 2; i++) text = text.replace(LIST_MARKER, '').trim();
	if (text.length < 20 || text.startsWith('![') || text.startsWith('|') || text.startsWith('<')) return null;
	const head = text.slice(0, 200);
	const year = (YEAR_IN_PARENS.exec(head) ?? YEAR.exec(head))?.[1] ?? null;
	const doiMatch = DOI.exec(unescapeDoiText(text));
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
	const authorPart = yearAt > 0 ? plain.slice(0, yearAt).replace(EDITOR_MARK, ' ') : '';
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
	/**
	 * Other titles of the work, from the note's aliases: the original title of
	 * a translation, for example, which the reference lists of other works cite.
	 */
	otherTitles?: string[];
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

/**
 * Share of a title's words (four letters or more) found in a text. A word
 * also counts when the conversion glued a short word (one to three letters)
 * in front of it, as in "The biology ofpeatlands"; never when it is only a
 * part of a longer word ("peat" in "peatlands"), which would match other works.
 */
export function titleOverlap(title: string, text: string): number {
	const words = titleWords(title);
	if (words.length === 0) return 0;
	const tokens = titleWords(text);
	const inText = new Set(tokens);
	const glued = (w: string) => tokens.some((t) => t.length > w.length && t.length - w.length <= 3 && t.endsWith(w));
	return words.filter((w) => inText.has(w) || glued(w)).length / words.length;
}

/** Share of the title's words that the entry must contain to match by author and year. */
const MIN_TITLE_OVERLAP = 0.6;

/**
 * Whether an entry is this work of the vault: same DOI, or same first author
 * and year and, to rule out other works of the same author and year, most of
 * the title's words (or, without a title, the same list of authors).
 *
 * Two different DOIs rule the match out. But a DOI of a reference list is
 * often cut short (at a line break, or at the "<" or "[" of old DOIs such as
 * 10.1002/(sici)1099-1085(199610)10:10<1263::aid-hyp458>3.0.co;2-1): when one
 * DOI is the beginning of the other, author, year and title decide.
 */
export function entryMatches(entry: BibEntry, work: VaultWork): boolean {
	if (entry.doi && work.doi) {
		if (entry.doi === work.doi) return true;
		if (!work.doi.startsWith(entry.doi) && !entry.doi.startsWith(work.doi)) return false;
	}
	if (!entry.year || entry.year !== work.year) return false;
	if (entry.authors.length === 0 || work.authors.length === 0 || entry.authors[0] !== work.authors[0]) return false;
	const titles = [work.title, ...(work.otherTitles ?? [])].filter((t) => t.trim() !== '');
	if (titles.length > 0) return titles.some((t) => titleOverlap(t, entry.text) >= MIN_TITLE_OVERLAP);
	if (entry.etAl) return work.authors.length >= 3;
	return entry.authors.length === work.authors.length && entry.authors.every((a, i) => a === work.authors[i]);
}

/**
 * The entries of every reference section of a note, outside code blocks.
 * When a note has no reference heading (lost in the conversion), the runs of
 * lines that look like references are read instead.
 */
export function bibliographyEntries(noteText: string): BibEntry[] {
	const lines = noteText.split('\n');
	const entries = sectionEntries(lines);
	return entries.length > 0 ? entries : unheadedEntries(lines);
}

/** How many of the few lines after a line are reference entries. */
function entriesAfter(lines: string[], index: number): number {
	let seen = 0;
	let found = 0;
	for (let i = index + 1; i < lines.length && seen < LOOKAHEAD; i++) {
		const line = (lines[i] ?? '').trim();
		if (!line || HEADING.test(line)) continue;
		seen++;
		if (looksLikeReference(line, i)) found++;
	}
	return found;
}

/**
 * Whether a line is surely a reference, not a sentence that has a year: it
 * starts like one (a family name, then a comma or initials), or its first
 * author is a short name ("Environment Canada. 1993.").
 */
function looksLikeReference(line: string, index: number): BibEntry | null {
	const entry = parseEntry(line, index);
	if (!entry?.firstAuthor) return null;
	const text = line.trim().replace(LIST_MARKER, '').trim();
	return REFERENCE_START.test(text) || entry.firstAuthor.split(/\s+/).length <= 2 ? entry : null;
}

/** Lines looked at after a heading inside a reference section, and how many must be entries. */
const LOOKAHEAD = 4;
const MIN_ENTRIES_AFTER = 2;

function sectionEntries(lines: string[]): BibEntry[] {
	const entries: BibEntry[] = [];
	let sectionLevel: number | null = null;
	let inCode = false;
	/** Line of the last entry, or of the last line joined to it. */
	let lastLine = -Infinity;
	lines.forEach((raw, index) => {
		const line = raw.trimEnd();
		if (/^\s*(```|~~~)/.test(line)) inCode = !inCode;
		if (inCode) return;
		const heading = HEADING.exec(line);
		if (heading) {
			const level = heading[1]?.length ?? 1;
			if (isReferenceHeading(heading[2] ?? '')) sectionLevel = level;
			else if (sectionLevel !== null && level <= sectionLevel) {
				// A heading of the same level inside the section ("General",
				// "Laws", or a page header of the converted PDF) keeps it open
				// when references follow; another section closes it.
				if (entriesAfter(lines, index) < MIN_ENTRIES_AFTER) sectionLevel = null;
			}
			return;
		}
		const bold = BOLD_TITLE.exec(line.trim());
		if (bold && isReferenceHeading(bold[1] ?? '')) {
			sectionLevel = 7; // ends at the next heading of any level
			return;
		}
		if (sectionLevel === null) return;
		const entry = parseEntry(line, index);
		if (entry) {
			entries.push(entry);
			lastLine = index;
			return;
		}
		// The conversion sometimes breaks one entry into two list items
		// ("- Gorham, E. 1991. Northern peatlands: role in the carbon", a blank
		// line, "- cycle and probable responses…"). A line that is not an entry
		// by itself, right after one, is the rest of it.
		const previous = entries[entries.length - 1];
		const rest = line.trim().replace(LIST_MARKER, '').trim();
		if (!previous || index - lastLine > MAX_CONTINUATION_GAP || !rest || /^[![|<]/.test(rest)) return;
		const joined = `${previous.text} ${rest}`;
		if (joined.length > MAX_ENTRY_LENGTH) return;
		const merged = parseEntry(joined, previous.line);
		if (!merged) return;
		entries[entries.length - 1] = merged;
		lastLine = index;
	});
	return entries;
}

/**
 * A line that starts like a reference: a family name followed by a comma or
 * initials ("Gorham, E. 1991.", "**Bragg, O. M. 1995.**", "Waddington JM,").
 */
const REFERENCE_START = /^(?:\*\*)?\p{Lu}[\p{L}'’-]+(?:\s\p{Lu}[\p{L}'’-]+)?(?:,\s*\p{Lu}|\s\p{Lu}{1,3}[,.\s])/u;
/** Lines of a note without a reference heading are read as references in runs of at least this many. */
const MIN_UNHEADED_RUN = 5;

/**
 * References of a note whose reference heading was lost: runs of at least
 * MIN_UNHEADED_RUN lines that start like a reference and read as entries,
 * with blank lines (and at most one other line, such as a page header)
 * between them.
 */
function unheadedEntries(lines: string[]): BibEntry[] {
	const found: BibEntry[] = [];
	let run: BibEntry[] = [];
	let others = 0;
	const close = () => {
		if (run.length >= MIN_UNHEADED_RUN) found.push(...run);
		run = [];
		others = 0;
	};
	let inCode = false;
	lines.forEach((raw, index) => {
		const line = raw.trim();
		if (/^(```|~~~)/.test(line)) inCode = !inCode;
		if (inCode || !line) return;
		const text = line.replace(LIST_MARKER, '').trim();
		const entry = REFERENCE_START.test(text) ? parseEntry(line, index) : null;
		if (entry?.firstAuthor) {
			// (Here only lines that start like a reference count: without a
			// heading, a short name followed by a year is too often a sentence.)
			run.push(entry);
			others = 0;
		} else if (++others > 1) close();
	});
	close();
	return found;
}

/** A continuation of an entry is at most this many lines after it (one blank line between). */
const MAX_CONTINUATION_GAP = 2;
/** Longer "entries" are not joined further: a paragraph, not a reference. */
const MAX_ENTRY_LENGTH = 1500;

/** A family name reduced for comparison: no accents, case, spaces or punctuation. */
export function nameKey(name: string): string {
	return name
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}]/gu, '');
}
