import { CITE_URL_PREFIX, CitationTarget, parseCitationUrl } from './citation';

/** A Markdown link found in a line of text: `[text](url)` or `[text](<url>)`. */
export interface LineLink {
	/** Offset of the opening "[" in the line. */
	from: number;
	/** Offset just after the closing ")". */
	to: number;
	/** The link text, between the brackets. */
	text: string;
	url: string;
}

/** Finds the inline Markdown links of one line of text. */
export function markdownLinksInLine(line: string): LineLink[] {
	const links: LineLink[] = [];
	let searchFrom = 0;
	while (searchFrom < line.length) {
		const middle = line.indexOf('](', searchFrom);
		if (middle < 0) break;
		const from = line.lastIndexOf('[', middle);
		const destStart = middle + 2;
		let url: string;
		let to: number;
		if (line[destStart] === '<') {
			const close = line.indexOf('>', destStart + 1);
			if (close < 0) break;
			url = line.slice(destStart + 1, close);
			to = close + 2;
		} else {
			// A bare destination ends at whitespace or at an unbalanced ")". A
			// citation URL written readable without angle brackets (not valid
			// Markdown, but easy to type) is read up to its unbalanced ")", so
			// that it can be checked and converted.
			const lenient = line.startsWith(CITE_URL_PREFIX, destStart);
			let depth = 0;
			let end = destStart;
			for (; end < line.length; end++) {
				const ch = line.charAt(end);
				if (/\s/.test(ch) && !lenient) break;
				if (ch === '(') depth++;
				if (ch === ')') {
					if (depth === 0) break;
					depth--;
				}
			}
			url = line.slice(destStart, end);
			to = end + 1;
		}
		if (from >= searchFrom) links.push({ from, to, text: line.slice(from + 1, middle), url });
		searchFrom = Math.max(to, middle + 2);
	}
	return links;
}

/** A citation link found in a note. */
export interface CitationLink {
	/** Line number, starting at 0. */
	line: number;
	/** Offsets of the whole Markdown link in the note text. */
	from: number;
	to: number;
	/** Link text, such as "Smith et al., 2020". */
	text: string;
	url: string;
	target: CitationTarget;
}

/** Finds every citation link of a note, outside fenced code blocks. */
export function citationLinksIn(noteText: string): CitationLink[] {
	const found: CitationLink[] = [];
	let offset = 0;
	let inCode = false;
	noteText.split('\n').forEach((line, index) => {
		if (/^\s*(```|~~~)/.test(line)) inCode = !inCode;
		if (!inCode && line.includes(CITE_URL_PREFIX)) {
			for (const link of markdownLinksInLine(line)) {
				const target = parseCitationUrl(link.url);
				if (!target) continue;
				found.push({
					line: index,
					from: offset + link.from,
					to: offset + link.to,
					text: link.text,
					url: link.url,
					target,
				});
			}
		}
		offset += line.length + 1;
	});
	return found;
}

/**
 * The note text with every citation link written in its canonical encoded
 * form (readable links between angle brackets are converted), and how many
 * links changed.
 */
export function withCanonicalCitationLinks(
	noteText: string,
	canonical: (link: CitationLink) => string,
): { text: string; changed: number } {
	let result = '';
	let last = 0;
	let changed = 0;
	for (const link of citationLinksIn(noteText)) {
		const url = canonical(link);
		if (url === link.url && noteText.charAt(link.from + link.text.length + 3) !== '<') continue;
		result += `${noteText.slice(last, link.from)}[${link.text}](${url})`;
		last = link.to;
		changed++;
	}
	return { text: result + noteText.slice(last), changed };
}

/**
 * The note text with every citation link replaced by its text, so that
 * "([Smith et al., 2020](obsidian://cite?...))" becomes "(Smith et al., 2020)".
 */
export function withoutCitationLinks(noteText: string): string {
	let result = '';
	let last = 0;
	for (const link of citationLinksIn(noteText)) {
		result += noteText.slice(last, link.from) + link.text.replace(/\\([[\]])/g, '$1');
		last = link.to;
	}
	return result + noteText.slice(last);
}
