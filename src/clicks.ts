import { EditorView } from '@codemirror/view';
import { Keymap, PaneType, Plugin, TFile } from 'obsidian';
import { CITE_URL_PREFIX, parseCitationUrl } from './citation';
import { markdownLinksInLine } from './links';
import { openCitation } from './navigation';

/** A citation link found under the pointer. */
export interface CitationLinkAt {
	url: string;
	/** The element to anchor a popover to. */
	element: HTMLElement;
	/** Whether the link is in an editor (else in the reading view). */
	inEditor: boolean;
	/** Whether the link's Markdown is shown (source mode, or the cursor is on it in Live Preview). */
	markdownShown: boolean;
}

/** The citation link under an element of the reading view or of an editor, if any. */
export function citationLinkAt(el: Element): CitationLinkAt | null {
	const anchor = el.closest('a');
	const href = anchor?.getAttribute('href');
	if (anchor instanceof HTMLElement && href?.startsWith(CITE_URL_PREFIX)) {
		return { url: href, element: anchor, inEditor: false, markdownShown: false };
	}
	const editorEl = el.closest('.cm-editor');
	if (!(editorEl instanceof HTMLElement)) return null;
	const linkEl = el.closest('.cm-link, .cm-url, .cm-underline');
	if (!(linkEl instanceof HTMLElement)) return null;
	const view = EditorView.findFromDOM(editorEl);
	if (!view) return null;

	const pos = view.posAtDOM(el);
	const line = view.state.doc.lineAt(pos);
	const offset = pos - line.from;
	const link = markdownLinksInLine(line.text).find(
		(l) => l.from <= offset && offset < l.to && l.url.startsWith(CITE_URL_PREFIX),
	);
	if (!link) return null;
	const livePreview = editorEl.closest('.is-live-preview') !== null;
	const cursorOnLink = view.state.selection.ranges.some(
		(r) => r.from <= line.from + link.to && r.to >= line.from + link.from,
	);
	return { url: link.url, element: linkEl, inEditor: true, markdownShown: !livePreview || cursorOnLink };
}

/**
 * Citation URL of the link under the click, if the click should open it:
 * when the link's Markdown is shown, a plain click only places the cursor,
 * as for any other link, and a modifier click opens it.
 */
function citationUrlAt(evt: MouseEvent): string | null {
	const el = evt.target instanceof Element ? evt.target : null;
	const found = el ? citationLinkAt(el) : null;
	if (!found) return null;
	if (found.markdownShown && !Keymap.isModEvent(evt)) return null;
	return found.url;
}

/**
 * Opens citation links clicked inside Obsidian directly, instead of letting
 * Obsidian hand the obsidian:// URL to the operating system, which sends it
 * back to the protocol handler. This keeps the click in the current vault and
 * lets Ctrl/Cmd-click and middle-click open the note in a new tab.
 */
export function registerCitationClicks(
	plugin: Plugin,
	fileForDoi: (doi: string) => TFile | null,
): void {
	const onClick = (evt: MouseEvent) => {
		if (evt.button !== 0 && evt.button !== 1) return;
		const url = citationUrlAt(evt);
		const target = url ? parseCitationUrl(url) : null;
		if (!target) return;
		evt.preventDefault();
		evt.stopImmediatePropagation();
		const newLeaf: PaneType | boolean = evt.button === 1 ? 'tab' : Keymap.isModEvent(evt);
		void openCitation(plugin.app, target, newLeaf, fileForDoi);
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
