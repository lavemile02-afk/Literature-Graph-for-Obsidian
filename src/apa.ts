/**
 * APA 7th edition rules for in-text citations and reference-list order,
 * applied to the works cited by one document.
 *
 * - Order of the reference list (APA 9.44–9.47): letter by letter on the
 *   surnames ("nothing precedes something": Brown before Browning), then
 *   initials; a one-author work before multi-author works that start with the
 *   same author; then the year (no date first); then the title, without a
 *   leading article.
 * - In-text citations (APA 8.17–8.20): one or two authors are always named;
 *   three or more give "First et al.". When two different works would have the
 *   same citation, as many names are written as needed to tell them apart
 *   (all of them if only the last differs); only works with the same authors
 *   and year get letters (2016a, 2016b), in reference-list order. When two
 *   different first authors share a surname, their initials are added.
 */

export interface Author {
	family: string;
	/** Initials as written, such as "J. S." (may be empty). */
	initials: string;
}

export interface ApaWork {
	id: string;
	authors: Author[];
	/** "2016", or "" / "n.d." / "s.d." for no date. */
	year: string;
	title: string;
}

export interface InTextCitation {
	/** Citation without parentheses, such as "Bourgeois, Vanasse, et al., 2016" or "Smith, 2020a". */
	label: string;
	/** Letter added to the year ("" if none). */
	letter: string;
}

export type Language = 'en' | 'fr';

// Initials have dots ("J.", "M.-C.", "Ch.") or are one or two capitals ("J", "JS");
// "Li" or "Ng" are surnames.
const INITIALS = /^(?:(?:\p{Lu}\p{Ll}?\.[\s-]*)+|\p{Lu}{1,2})$/u;

/** Reads "Bourgeois, B., Vanasse, A., Poulin, M.-C." (or with "&" / "et") into authors. */
export function parseAuthors(text: string): Author[] {
	const authors: Author[] = [];
	for (const raw of text.split(/\s*(?:,|;|&|\bet\b|\band\b)\s*/)) {
		const part = raw.trim();
		if (!part) continue;
		const last = authors[authors.length - 1];
		if (last && INITIALS.test(part)) {
			last.initials = `${last.initials} ${part}`.trim();
		} else {
			authors.push({ family: part, initials: '' });
		}
	}
	return authors;
}

/** Letters only, without accents or case, for letter-by-letter comparison. */
function letters(text: string): string {
	return text
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}\d]/gu, '');
}

const NO_DATE = /^(|n\.?\s?d\.?|s\.?\s?d\.?)$/i;
const IN_PRESS = /press|presse/i;

/** Sort value of a year: no date first, "in press" last. */
function yearValue(year: string): number {
	const y = year.trim();
	if (NO_DATE.test(y)) return -Infinity;
	if (IN_PRESS.test(y)) return Infinity;
	const n = Number.parseInt(y, 10);
	return Number.isFinite(n) ? n : -Infinity;
}

/** A title without its leading article, for sorting. */
function titleKey(title: string): string {
	return letters(title.replace(/^\s*(?:a|an|the|le|la|les|l'|l’|un|une|des)\s+/i, '').replace(/^\s*l['’]/i, ''));
}

/** APA reference-list order. */
export function compareApa(a: ApaWork, b: ApaWork): number {
	const n = Math.max(a.authors.length, b.authors.length);
	for (let i = 0; i < n; i++) {
		const x = a.authors[i];
		const y = b.authors[i];
		if (!x) return -1; // a one-author work before those with more authors
		if (!y) return 1;
		const byFamily = letters(x.family).localeCompare(letters(y.family));
		if (byFamily !== 0) return byFamily;
		const byInitials = letters(x.initials).localeCompare(letters(y.initials));
		if (byInitials !== 0) return byInitials;
	}
	const byYear = yearValue(a.year) - yearValue(b.year);
	if (byYear !== 0 && !Number.isNaN(byYear)) return byYear;
	return titleKey(a.title).localeCompare(titleKey(b.title));
}

function joinNames(names: string[], language: Language): string {
	if (names.length === 1) return names[0] ?? '';
	const and = language === 'fr' ? 'et' : '&';
	if (names.length === 2) return `${names[0]} ${and} ${names[1]}`;
	const head = names.slice(0, -1).join(', ');
	return language === 'fr' ? `${head} et ${names[names.length - 1]}` : `${head}, & ${names[names.length - 1]}`;
}

/**
 * In-text citations for the works of one document, following APA 7.
 * Works are identified by `id`; returns a citation for each.
 */
export function apaCitations(works: ApaWork[], language: Language): Map<string, InTextCitation> {
	const sorted = [...works].sort(compareApa);
	const noDate = language === 'fr' ? 's.d.' : 'n.d.';

	// Initials before the surname when different first authors share it (APA 8.20).
	const firstByFamily = new Map<string, Set<string>>();
	for (const w of sorted) {
		const first = w.authors[0];
		if (!first) continue;
		const key = letters(first.family);
		firstByFamily.set(key, (firstByFamily.get(key) ?? new Set<string>()).add(letters(first.initials)));
	}
	const nameOf = (w: ApaWork, i: number): string => {
		const author = w.authors[i];
		if (!author) return '';
		const ambiguous = i === 0 && (firstByFamily.get(letters(author.family))?.size ?? 0) > 1 && author.initials;
		return ambiguous ? `${author.initials} ${author.family}` : author.family;
	};

	// How many names each citation shows (three authors or more start with one).
	const shown = new Map(sorted.map((w) => [w.id, w.authors.length >= 3 ? 1 : w.authors.length]));
	const yearOf = (w: ApaWork) => (NO_DATE.test(w.year.trim()) ? noDate : w.year.trim());
	const namesPart = (w: ApaWork): string => {
		const n = w.authors.length;
		if (n === 0) return w.title.split(/[.:?!]/)[0]?.trim() ?? w.id;
		const k = shown.get(w.id) ?? n;
		const names = w.authors.slice(0, k).map((_, i) => nameOf(w, i));
		// "Smith et al." with one name; "Smith, Jones, et al." with more (APA); no comma in French.
		if (n >= 3 && k < n) return k === 1 || language === 'fr' ? `${names.join(', ')} et al.` : `${names.join(', ')}, et al.`;
		return joinNames(w.authors.map((_, i) => nameOf(w, i)), language);
	};
	const labelOf = (w: ApaWork) => `${namesPart(w)}, ${yearOf(w)}`;

	// Write more names while different works share a citation.
	for (let round = 0; round < 50; round++) {
		const groups = new Map<string, ApaWork[]>();
		for (const w of sorted) groups.set(labelOf(w), [...(groups.get(labelOf(w)) ?? []), w]);
		let changed = false;
		for (const group of groups.values()) {
			if (group.length < 2) continue;
			const expandable = group.filter((w) => (shown.get(w.id) ?? 0) < w.authors.length);
			// Only when the authors differ: identical lists get letters instead.
			const distinctLists = new Set(group.map((w) => w.authors.map((a) => letters(a.family)).join('|')));
			if (distinctLists.size < 2 || expandable.length === 0) continue;
			for (const w of expandable) shown.set(w.id, (shown.get(w.id) ?? 0) + 1);
			changed = true;
		}
		if (!changed) break;
	}

	// Same citation left: same authors and year, told apart by letters.
	const result = new Map<string, InTextCitation>();
	const groups = new Map<string, ApaWork[]>();
	for (const w of sorted) groups.set(labelOf(w), [...(groups.get(labelOf(w)) ?? []), w]);
	for (const [label, group] of groups) {
		group.forEach((w, i) => {
			const letter = group.length > 1 ? String.fromCharCode(97 + i) : '';
			const year = yearOf(w);
			const withLetter = !letter ? label : /\d/.test(year) ? `${label}${letter}` : `${label}-${letter}`;
			result.set(w.id, { label: withLetter, letter });
		});
	}
	return result;
}
