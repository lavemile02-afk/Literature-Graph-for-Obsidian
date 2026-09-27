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
 * a notice. `newLeaf` is passed to `workspace.getLeaf` (false = current tab).
 */
export async function openCitation(
	app: App,
	target: CitationTarget,
	newLeaf: PaneType | boolean = false,
): Promise<void> {
	const file = target.note ? resolveCitedNote(app, target.note) : null;

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

	const leaf = app.workspace.getLeaf(newLeaf);
	await leaf.openFile(file, { active: true, eState: { line } });
	const view = await viewShowing(app, file, leaf);
	if (!view) return;
	if (view.leaf !== leaf) view.setEphemeralState({ line });
	if (!range) return;

	if (view.getMode() === 'preview') {
		await highlightWhenRendered(view, file, line, text.slice(range.from, range.to));
		return;
	}

	const editor = view.editor;
	const from = editor.offsetToPos(range.from);
	const to = editor.offsetToPos(range.to);
	// Focus first: an editor that gains focus later reads the browser's
	// selection and would replace the passage selection with it.
	editor.focus();
	editor.setSelection(from, to);
	editor.scrollIntoView({ from, to }, true);
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
 * returns; so wait a little for it.
 */
async function viewShowing(
	app: App,
	file: TFile,
	leaf: WorkspaceLeaf,
): Promise<MarkdownView | null> {
	for (let attempt = 0; attempt < 10; attempt++) {
		for (const view of [leaf.view, app.workspace.getActiveViewOfType(MarkdownView)]) {
			if (view instanceof MarkdownView && view.file === file && view.leaf === app.workspace.getMostRecentLeaf()) {
				return view;
			}
		}
		await sleep(50);
	}
	return null;
}
