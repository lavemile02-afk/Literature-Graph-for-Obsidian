/**
 * Finding a cited passage in a note.
 *
 * Literature notes are often converted from PDF, so the Markdown text and the
 * passage written in a link rarely match character for character: line breaks,
 * hyphenation ("arrange- ment"), emphasis marks, HTML tags such as <sup>, and
 * typographic quotes get in the way. Both texts are therefore normalized the
 * same way before comparing them, keeping a map back to the original offsets.
 */

/** A normalized text, with the offset in the original text of each character. */
export interface NormalizedText {
	text: string;
	/** `offsets[i]` is the offset in the original text of `text[i]`. */
	offsets: Int32Array;
}

/** A character range in the original text. */
export interface TextRange {
	from: number;
	to: number;
}

export interface PassageMatch extends TextRange {
	/** True when the passage was not found exactly and this is the closest text. */
	approximate: boolean;
}

// Dashes and hyphens: removed together with any whitespace around them, so that
// "arrange- ment", "arrange-\nment" and "arrangement" all compare equal.
const DASHES = /[-­‐-―−]/;
// Emphasis and code marks, and Markdown escapes.
const MARKUP = /[*_`~\\]/;
const HTML_TAG = /^<\/?([A-Za-z][A-Za-z0-9]*)\b[^<>]*>/;
const HTML_ENTITY = /^&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/;
const ENTITY_TEXT: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
};
const QUOTES: Record<string, string> = {
	'‘': "'",
	'’': "'",
	'‚': "'",
	'′': "'",
	'“': '"',
	'”': '"',
	'„': '"',
	'«': '"',
	'»': '"',
};
// HTML tags that separate words when rendered.
const BREAKING_TAGS = new Set(['br', 'p', 'div', 'li', 'td', 'th', 'tr', 'hr']);

// ASCII characters that need more than lower-casing: markup, tags, entities, dashes.
const SPECIAL_ASCII = new Set([...'<&*_`~\\-'].map((c) => c.charCodeAt(0)));

const folded = new Map<string, string>();
/** Lower case, without accents, with compatibility characters (ligatures...) expanded. */
function foldChar(ch: string): string {
	if (ch.length === 1 && ch.charCodeAt(0) < 128) return ch;
	let f = folded.get(ch);
	if (f === undefined) {
		f = ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
		folded.set(ch, f);
	}
	return f;
}

function decodeEntity(name: string): string {
	if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
	if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
	return ENTITY_TEXT[name] ?? '';
}

/**
 * Normalizes a text for passage search: lower case, no accents, no emphasis
 * marks or HTML tags, typographic quotes made straight, dashes removed with
 * the whitespace around them, and every run of whitespace turned into one space.
 */
export function normalizeForSearch(source: string): NormalizedText {
	let text = '';
	let offsets = new Int32Array(source.length + 16);
	let length = 0;
	let pendingSpace = false;
	let afterDash = false;

	const emit = (c: string, offset: number) => {
		if (length === offsets.length) {
			const grown = new Int32Array(offsets.length * 2);
			grown.set(offsets);
			offsets = grown;
		}
		text += c;
		offsets[length++] = offset;
	};
	const pushChar = (ch: string, offset: number) => {
		if (pendingSpace && !afterDash && length > 0) emit(' ', offset);
		pendingSpace = false;
		afterDash = false;
		const f = foldChar(ch);
		for (let k = 0; k < f.length; k++) emit(f.charAt(k), offset);
	};

	let i = 0;
	while (i < source.length) {
		const code = source.charCodeAt(i);
		// Fast path for plain ASCII letters, digits and punctuation.
		if (code > 32 && code < 127 && !SPECIAL_ASCII.has(code)) {
			pushChar(code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : source.charAt(i), i);
			i++;
			continue;
		}
		const ch = source.charAt(i);
		if (ch === '<') {
			const tag = HTML_TAG.exec(source.slice(i, i + 200));
			if (tag) {
				if (BREAKING_TAGS.has((tag[1] ?? '').toLowerCase())) pendingSpace = true;
				i += tag[0].length;
				continue;
			}
		}
		if (ch === '&') {
			const entity = HTML_ENTITY.exec(source.slice(i, i + 12));
			if (entity) {
				const decoded = decodeEntity(entity[1] ?? '');
				if (/\s/.test(decoded)) pendingSpace = true;
				else if (decoded) pushChar(decoded, i);
				i += entity[0].length;
				continue;
			}
		}
		if (/\s/.test(ch)) {
			pendingSpace = true;
		} else if (DASHES.test(ch)) {
			pendingSpace = false;
			afterDash = true;
		} else if (!MARKUP.test(ch)) {
			pushChar(QUOTES[ch] ?? ch, i);
		}
		i += ch.length;
	}
	return { text, offsets: offsets.subarray(0, length) };
}

/** Maps a range of a normalized text back to the original text. */
function toOriginal(norm: NormalizedText, from: number, to: number): TextRange {
	return {
		from: norm.offsets[from] ?? 0,
		to: (norm.offsets[to - 1] ?? 0) + 1,
	};
}

/** Start offsets (in the normalized text) of every occurrence of `needle`. */
function occurrences(haystack: string, needle: string): number[] {
	const found: number[] = [];
	if (!needle) return found;
	let at = haystack.indexOf(needle);
	while (at >= 0) {
		found.push(at);
		at = haystack.indexOf(needle, at + 1);
	}
	return found;
}

/** Longest distance (in normalized characters) searched for the end of a passage. */
const MAX_PASSAGE_LENGTH = 5000;
/** Share of the passage's words that the closest text must contain. */
const MIN_APPROXIMATE_SCORE = 0.6;
/** Passages shorter than this many words are only matched exactly. */
const MIN_APPROXIMATE_WORDS = 4;

/**
 * Finds the text window whose words best match the passage's words (same
 * number of words, compared as bags of words), for a passage that was changed
 * slightly or split by a figure in the note.
 */
function approximateMatch(norm: NormalizedText, passage: string): TextRange | null {
	const wanted = passage.split(' ').filter(Boolean);
	if (wanted.length < MIN_APPROXIMATE_WORDS) return null;
	const words: { word: string; from: number; to: number }[] = [];
	const wordPattern = /\S+/g;
	let m: RegExpExecArray | null;
	while ((m = wordPattern.exec(norm.text)) !== null) {
		words.push({ word: m[0], from: m.index, to: m.index + m[0].length });
	}
	if (words.length === 0) return null;

	const need = new Map<string, number>();
	for (const w of wanted) need.set(w, (need.get(w) ?? 0) + 1);
	const have = new Map<string, number>();
	let matched = 0;
	const add = (w: string) => {
		const n = (have.get(w) ?? 0) + 1;
		have.set(w, n);
		if (n <= (need.get(w) ?? 0)) matched++;
	};
	const remove = (w: string) => {
		const n = have.get(w) ?? 0;
		if (n <= (need.get(w) ?? 0)) matched--;
		have.set(w, n - 1);
	};

	const size = Math.min(wanted.length, words.length);
	let best = -1;
	let bestStart = 0;
	for (let i = 0; i < words.length; i++) {
		add(words[i]?.word ?? '');
		if (i >= size) remove(words[i - size]?.word ?? '');
		if (i >= size - 1 && matched > best) {
			best = matched;
			bestStart = i - size + 1;
		}
	}
	if (best / wanted.length < MIN_APPROXIMATE_SCORE) return null;

	// Trim words at both ends that are not part of the passage.
	let start = bestStart;
	let end = bestStart + size - 1;
	while (start < end && !need.has(words[start]?.word ?? '')) start++;
	while (end > start && !need.has(words[end]?.word ?? '')) end--;
	return toOriginal(norm, words[start]?.from ?? 0, words[end]?.to ?? 0);
}

/** Exact matches of a normalized passage in a whole text, in text order. */
function exactMatchesInFullText(norm: NormalizedText, passage: string): TextRange[] {
	return occurrences(norm.text, passage).map((at) => toOriginal(norm, at, at + passage.length));
}

/** Anchor words occurring more often than this make the fast search pointless. */
const MAX_ANCHOR_HITS = 2000;

/** Exact matches of a normalized passage in the windows of text around some hits. */
function exactMatchesAround(text: string, passage: string, hits: number[]): TextRange[] {
	// Windows around the hits, merged when they overlap.
	const reach = passage.length * 3 + 200;
	const windows: TextRange[] = [];
	for (const hit of hits) {
		const from = Math.max(0, hit - reach);
		const to = Math.min(text.length, hit + reach);
		const last = windows[windows.length - 1];
		if (last && from <= last.to) last.to = to;
		else windows.push({ from, to });
	}
	const found: TextRange[] = [];
	for (const w of windows) {
		const norm = normalizeForSearch(text.slice(w.from, w.to));
		for (const r of exactMatchesInFullText(norm, passage)) {
			found.push({ from: r.from + w.from, to: r.to + w.from });
		}
	}
	return found;
}

/**
 * Exact matches found without normalizing the whole text: look for one of the
 * passage's words in the raw text, then normalize only a window around each
 * hit. The rarest of the longest words is tried first; a word may be missing
 * or misleading because the text splits it where the passage is
 * ("arrange- ment", "software<sup>1</sup>"), so a few words are tried.
 * Returns an empty list when nothing is found this way: the full search must
 * then decide.
 */
function exactMatchesNearAnchor(text: string, passage: string): TextRange[] {
	const lower = text.toLowerCase();
	if (lower.length !== text.length) return [];
	const anchors = [...new Set(passage.split(' '))]
		.filter((w) => /^[a-z0-9]{4,}$/.test(w))
		.sort((a, b) => b.length - a.length)
		.slice(0, 5)
		.map((word) => occurrences(lower, word))
		.filter((hits) => hits.length > 0 && hits.length <= MAX_ANCHOR_HITS)
		.sort((a, b) => a.length - b.length)
		.slice(0, 3);
	for (const hits of anchors) {
		const found = exactMatchesAround(text, passage, hits);
		if (found.length > 0) return found;
	}
	return [];
}

/**
 * Every exact occurrence of a passage start in a text, in text order, found
 * the same way as `findPassage` does, so that `occ` means the same thing when
 * a link is created and when it is opened.
 */
export function findExactPassages(text: string, q: string): TextRange[] {
	const nq = normalizeForSearch(q).text;
	if (!nq) return [];
	const exact = exactMatchesNearAnchor(text, nq);
	return exact.length > 0 ? exact : exactMatchesInFullText(normalizeForSearch(text), nq);
}

/**
 * Finds a cited passage in a text.
 *
 * @param q   start of the passage
 * @param qe  end of the passage (optional); the match then runs from `q` to `qe`
 * @param occ which occurrence of `q` to use, starting at 1
 */
export function findPassage(text: string, q: string, qe?: string, occ = 1): PassageMatch | null {
	const nq = normalizeForSearch(q).text;
	if (!nq) return null;

	let norm: NormalizedText | null = null;
	let exact = exactMatchesNearAnchor(text, nq);
	if (exact.length === 0) {
		norm = normalizeForSearch(text);
		exact = exactMatchesInFullText(norm, nq);
	}

	let match: PassageMatch;
	const chosen = exact[occ - 1] ?? exact[0];
	if (chosen) {
		match = { ...chosen, approximate: false };
	} else {
		const closest = approximateMatch(norm ?? normalizeForSearch(text), nq);
		if (!closest) return null;
		match = { ...closest, approximate: true };
	}

	if (qe) {
		const nqe = normalizeForSearch(qe).text;
		const after = normalizeForSearch(text.slice(match.from, match.from + MAX_PASSAGE_LENGTH * 2));
		const end = nqe ? after.text.indexOf(nqe) : -1;
		if (end >= 0 && end + nqe.length <= MAX_PASSAGE_LENGTH) {
			match.to = Math.max(match.to, toOriginal(after, end, end + nqe.length).to + match.from);
		}
	}
	return match;
}

