import { App, MarkdownView, Notice, PaneType, TFile, WorkspaceLeaf } from 'obsidian';
import type { CitationTarget } from './citation';
import { highlightInReadingView, isPassageHighlightShown } from './highlight';
import { findPassage } from './passage';

/** Finds the note a citation link points to: by path first, then like a wikilink. */
export function resolveCitedNote(app: App, note: string): TFile | null {
	const byPath = app.vault.getAbstractFileByPath(note.endsWith('.md') ? note : `${note}.md`);
	if (byPath instanceof TFile) return byPath;
	return app.metadataCache.getFirstLinkpathDest(note, '');
}

/**
 * Opens what a citation link points to: the note at the passage, the DOI, or
 * a notice. `newLeaf` is passed to `workspace.getLeaf` (false = current tab);
 * `fileForDoi` finds the note of a work cited only by its DOI.
 */
export async function openCitation(
	app: App,
	target: CitationTarget,
	newLeaf: PaneType | boolean = false,
	fileForDoi?: (doi: string) => TFile | null,
): Promise<void> {
	const file =
		(target.note ? resolveCitedNote(app, target.note) : null) ??
		(target.doi && fileForDoi ? fileForDoi(target.doi) : null);

	if (!file) {
		if (target.doi) {
			window.open(`https://doi.org/${target.doi}`);
		} else {
			new Notice(`Cited work not found: ${target.note ?? '(no note or DOI in the link)'}`);
		}
		return;
	}

	const text = await app.vault.cachedRead(file);
	const range = target.q ? findPassage(text, target.q, target.qe, target.occ) : null;
	const line = range ? text.slice(0, range.from).split('\n').length - 1 : 0;
	if (target.q && !range) {
		new Notice('Passage not found; the note was opened at the beginning.');
	} else if (range?.approximate) {
		new Notice('Exact passage not found; the closest text is shown.');
	}

	const view = await openFileAtLine(app, file, line, newLeaf);
	if (!view || !range) return;

	if (view.getMode() === 'preview') {
		await highlightWhenRendered(view, file, line, text.slice(range.from, range.to));
		return;
	}
	const editor = view.editor;
	const { from: start, to: end } = withAdjacentMarks(text, range);
	const from = editor.offsetToPos(start);
	const to = editor.offsetToPos(end);
	editor.setSelection(from, to);
	editor.scrollIntoView({ from, to }, true);
}

/** Emphasis marks right at the edges of a passage, so that a selection keeps them paired. */
const MARKS = '*_~=';

/** A passage range extended over the emphasis marks that touch its ends ("**term**" whole). */
export function withAdjacentMarks(text: string, range: { from: number; to: number }): { from: number; to: number } {
	let from = range.from;
	let to = range.to;
	while (from > 0 && MARKS.includes(text.charAt(from - 1))) from--;
	while (to < text.length && MARKS.includes(text.charAt(to))) to++;
	return { from, to };
}

/**
 * Opens a note with a line at the top of the view (and the cursor on it, in
 * the editing view), even when a plugin switches to another tab where the
 * note is already open. Line 0 opens the note at the beginning.
 */
export async function openFileAtLine(
	app: App,
	file: TFile,
	line: number,
	newLeaf: PaneType | boolean = false,
): Promise<MarkdownView | null> {
	const leaf = app.workspace.getLeaf(newLeaf);
	await leaf.openFile(file, { active: true, eState: { line } });
	const view = await viewShowing(app, file, leaf);
	if (!view) return null;
	if (view.leaf !== leaf) view.setEphemeralState({ line });
	if (view.getMode() === 'source') {
		// Focus first: an editor that gains focus later reads the browser's
		// selection and would replace the cursor set here with it.
		view.editor.focus();
		view.editor.setCursor({ line, ch: 0 });
		view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
	}
	return view;
}

/** How long to wait for the reading view to render a long note. */
const READING_VIEW_TIMEOUT_MS = 20000;

/**
 * Scrolls the reading view to the passage and highlights it once it is
 * rendered. The reading view renders a note progressively, and for a very long
 * note it may show nothing for several seconds, then render the top of the
 * note and ignore the requested line; a re-render may also drop the highlight.
 * So keep scrolling and highlighting until the highlight has held for a
 * moment, as long as the note stays in that view.
 */
async function highlightWhenRendered(
	view: MarkdownView,
	file: TFile,
	line: number,
	passage: string,
): Promise<void> {
	const deadline = Date.now() + READING_VIEW_TIMEOUT_MS;
	let steady = 0;
	while (Date.now() < deadline && view.file === file && view.getMode() === 'preview') {
		await sleep(150);
		if (isPassageHighlightShown(view)) {
			if (++steady >= 3) return;
			continue;
		}
		steady = 0;
		if (highlightInReadingView(view, passage)) continue;
		if (Math.abs(view.previewMode.getScroll() - line) > 2) view.setEphemeralState({ line });
	}
}

/**
 * The Markdown view that shows `file` after it was opened in `leaf`. Usually
 * `leaf` itself, but some plugins (such as those that keep one tab per file)
 * switch to a tab where the file is already open, shortly after `openFile`
 * returns (up to about 600 ms when the click comes from a sidebar); so wait
 * up to 2 s for it.
 */
async function viewShowing(
	app: App,
	file: TFile,
	leaf: WorkspaceLeaf,
): Promise<MarkdownView | null> {
	for (let attempt = 0; attempt < 40; attempt++) {
		for (const view of [leaf.view, app.workspace.getActiveViewOfType(MarkdownView)]) {
			if (view instanceof MarkdownView && view.file === file && view.leaf === app.workspace.getMostRecentLeaf()) {
				return view;
			}
		}
		await sleep(50);
	}
	return null;
}
