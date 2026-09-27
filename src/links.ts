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
			// A bare destination ends at whitespace or at an unbalanced ")".
			let depth = 0;
			let end = destStart;
			for (; end < line.length; end++) {
				const ch = line.charAt(end);
				if (/\s/.test(ch)) break;
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
