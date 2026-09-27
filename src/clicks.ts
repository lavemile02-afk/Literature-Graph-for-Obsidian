import { EditorView } from '@codemirror/view';
import { Keymap, PaneType, Plugin } from 'obsidian';
import { CITE_URL_PREFIX, parseCitationUrl } from './citation';
import { openCitation } from './navigation';

/** A Markdown link found in a line of text: `[text](url)` or `[text](<url>)`. */
export interface LineLink {
	/** Offset of the opening "[" in the line. */
	from: number;
	/** Offset just after the closing ")". */
	to: number;
	url: string;
}

/** Finds the inline Markdown links of one line of text. */
export function markdownLinksInLine(text: string): LineLink[] {
	const links: LineLink[] = [];
	let searchFrom = 0;
	while (searchFrom < text.length) {
		const middle = text.indexOf('](', searchFrom);
		if (middle < 0) break;
		const from = text.lastIndexOf('[', middle);
		const destStart = middle + 2;
		let url: string;
		let to: number;
		if (text[destStart] === '<') {
			const close = text.indexOf('>', destStart + 1);
			if (close < 0) break;
			url = text.slice(destStart + 1, close);
			to = close + 2;
		} else {
			// A bare destination ends at whitespace or at an unbalanced ")".
			let depth = 0;
			let end = destStart;
			for (; end < text.length; end++) {
				const ch = text.charAt(end);
				if (/\s/.test(ch)) break;
				if (ch === '(') depth++;
				if (ch === ')') {
					if (depth === 0) break;
					depth--;
				}
			}
			url = text.slice(destStart, end);
			to = end + 1;
		}
		if (from >= searchFrom) links.push({ from, to, url });
		searchFrom = Math.max(to, middle + 2);
	}
	return links;
}

/** Citation URL of the link under the click in a Markdown editor, if any. */
function citationUrlInEditor(evt: MouseEvent, el: Element): string | null {
	const editorEl = el.closest('.cm-editor');
	if (!(editorEl instanceof HTMLElement)) return null;
	if (!el.closest('.cm-link, .cm-url, .cm-underline')) return null;
	const view = EditorView.findFromDOM(editorEl);
	if (!view) return null;

	const pos = view.posAtDOM(el);
	const line = view.state.doc.lineAt(pos);
	const offset = pos - line.from;
	const link = markdownLinksInLine(line.text).find(
		(l) => l.from <= offset && offset < l.to && l.url.startsWith(CITE_URL_PREFIX),
	);
	if (!link) return null;

	// When the link's Markdown is shown (source mode, or the cursor is on the
	// link in Live Preview), a plain click only places the cursor, as for any
	// other link; a modifier click opens it.
	const livePreview = editorEl.closest('.is-live-preview') !== null;
	const cursorOnLink = view.state.selection.ranges.some(
		(r) => r.from <= line.from + link.to && r.to >= line.from + link.from,
	);
	if ((!livePreview || cursorOnLink) && !Keymap.isModEvent(evt)) return null;
	return link.url;
}

/** Citation URL of the link under the click (reading view or editor), if any. */
function citationUrlAt(evt: MouseEvent): string | null {
	const el = evt.target instanceof Element ? evt.target : null;
	if (!el) return null;
	const href = el.closest('a')?.getAttribute('href');
	if (href?.startsWith(CITE_URL_PREFIX)) return href;
	return citationUrlInEditor(evt, el);
}

/**
 * Opens citation links clicked inside Obsidian directly, instead of letting
 * Obsidian hand the obsidian:// URL to the operating system, which sends it
 * back to the protocol handler. This keeps the click in the current vault and
 * lets Ctrl/Cmd-click and middle-click open the note in a new tab.
 */
export function registerCitationClicks(plugin: Plugin): void {
	const onClick = (evt: MouseEvent) => {
		if (evt.button !== 0 && evt.button !== 1) return;
		const url = citationUrlAt(evt);
		const target = url ? parseCitationUrl(url) : null;
		if (!target) return;
		evt.preventDefault();
		evt.stopImmediatePropagation();
		const newLeaf: PaneType | boolean = evt.button === 1 ? 'tab' : Keymap.isModEvent(evt);
		void openCitation(plugin.app, target, newLeaf);
	};
	// The editor starts a mouse selection on mousedown; if it saw the press, it
	// would move the cursor of the newly opened note to the clicked position.
	const onMouseDown = (evt: MouseEvent) => {
		if (evt.button !== 0 && evt.button !== 1) return;
		if (citationUrlAt(evt)?.startsWith(CITE_URL_PREFIX)) {
			evt.preventDefault();
			evt.stopImmediatePropagation();
		}
	};
	const listen = (doc: Document) => {
		plugin.registerDomEvent(doc, 'mousedown', onMouseDown, { capture: true });
		plugin.registerDomEvent(doc, 'click', onClick, { capture: true });
		plugin.registerDomEvent(doc, 'auxclick', onClick, { capture: true });
	};
	listen(document);
	plugin.registerEvent(plugin.app.workspace.on('window-open', (win) => listen(win.doc)));
}
