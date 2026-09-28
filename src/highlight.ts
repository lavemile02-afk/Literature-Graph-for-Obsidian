import type { MarkdownView } from 'obsidian';
import { normalizeForSearch } from './passage';

/** Name of the CSS highlight, styled with ::highlight(...) in styles.css. */
export const PASSAGE_HIGHLIGHT = 'literature-graph-passage';

/** How long the cited passage stays highlighted in the reading view (setting). */
let highlightDurationMs = 5000;

/** Sets how long the passage stays highlighted, in seconds (0: until the next highlight). */
export function setHighlightDuration(seconds: number): void {
	highlightDurationMs = Math.max(0, seconds) * 1000;
}

const BLOCKS = 'p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, pre, figcaption, div';

let clearTimer: number | null = null;
/** A window with the globals of the CSS Custom Highlight API. */
type GlobalWindow = Window & { CSS: typeof CSS; Highlight: typeof Highlight };

let highlightedWindow: GlobalWindow | null = null;

/** Removes the passage highlight. */
export function clearPassageHighlight(): void {
	if (clearTimer !== null) window.clearTimeout(clearTimer);
	clearTimer = null;
	highlightedWindow?.CSS.highlights.delete(PASSAGE_HIGHLIGHT);
	highlightedWindow = null;
}

/** Whether the passage highlight is still visible in this view (a re-render drops it). */
export function isPassageHighlightShown(view: MarkdownView): boolean {
	const highlight = highlightedWindow?.CSS.highlights.get(PASSAGE_HIGHLIGHT);
	if (!highlight) return false;
	for (const range of highlight) {
		if (!range.collapsed && view.previewMode.containerEl.contains(range.startContainer)) return true;
	}
	return false;
}

/**
 * Highlights a passage in the reading view of a note, without changing its
 * DOM (CSS Custom Highlight API), and scrolls it to the middle of the view.
 *
 * The rendered text is compared with the passage after the same normalization
 * as the passage search, so Markdown marks and line breaks do not matter.
 * When the passage occurs more than once in the rendered part of the note,
 * the occurrence closest to the middle of the view is used: the view has
 * already been scrolled to the passage's line.
 *
 * @returns true if the passage was found in the rendered text.
 */
export function highlightInReadingView(view: MarkdownView, passage: string): boolean {
	const root = view.previewMode.containerEl;
	const win = root.win as GlobalWindow;
	if (typeof win.Highlight !== 'function') return false;
	const wanted = normalizeForSearch(passage).text;
	if (!wanted) return false;

	// Join the rendered text nodes, with a line break between blocks and at <br>.
	const nodes: Text[] = [];
	const starts: number[] = [];
	let joined = '';
	let lastBlock: Element | null = null;
	const walker = root.doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.nodeType !== Node.TEXT_NODE) {
			if (node.nodeName === 'BR') joined += '\n';
			continue;
		}
		const text = node as Text;
		const block = text.parentElement?.closest(BLOCKS) ?? null;
		if (block !== lastBlock) joined += '\n';
		lastBlock = block;
		starts.push(joined.length);
		nodes.push(text);
		joined += text.data;
	}
	const norm = normalizeForSearch(joined);

	/** Text node and offset of a position in `joined`. */
	const locate = (pos: number): [Text, number] | null => {
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if ((starts[mid] ?? 0) <= pos) lo = mid;
			else hi = mid - 1;
		}
		const node = nodes[lo];
		return node ? [node, Math.min(pos - (starts[lo] ?? 0), node.length)] : null;
	};

	const viewRect = root.getBoundingClientRect();
	const middle = viewRect.top + viewRect.height / 2;
	let best: Range | null = null;
	let bestDistance = Infinity;
	for (let at = norm.text.indexOf(wanted); at >= 0; at = norm.text.indexOf(wanted, at + 1)) {
		const start = locate(norm.offsets[at] ?? 0);
		const end = locate((norm.offsets[at + wanted.length - 1] ?? 0) + 1);
		if (!start || !end) continue;
		const range = root.doc.createRange();
		range.setStart(start[0], start[1]);
		range.setEnd(end[0], end[1]);
		const rect = range.getBoundingClientRect();
		const distance = Math.abs(rect.top + rect.height / 2 - middle);
		if (distance < bestDistance) {
			best = range;
			bestDistance = distance;
		}
	}
	if (!best) return false;

	clearPassageHighlight();
	win.CSS.highlights.set(PASSAGE_HIGHLIGHT, new win.Highlight(best));
	highlightedWindow = win;
	if (highlightDurationMs > 0) clearTimer = window.setTimeout(clearPassageHighlight, highlightDurationMs);
	best.startContainer.parentElement?.scrollIntoView({ block: 'center' });
	return true;
}
