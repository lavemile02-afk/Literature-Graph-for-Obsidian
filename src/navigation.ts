import { App, MarkdownView, Notice, PaneType, TFile, WorkspaceLeaf } from 'obsidian';
import type { CitationTarget } from './citation';

/** Finds the note a citation link points to: by path first, then like a wikilink. */
export function resolveCitedNote(app: App, note: string): TFile | null {
	const byPath = app.vault.getAbstractFileByPath(note.endsWith('.md') ? note : `${note}.md`);
	if (byPath instanceof TFile) return byPath;
	return app.metadataCache.getFirstLinkpathDest(note, '');
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds the passage in the note text and returns its character range.
 * Prototype: exact match, where any run of whitespace matches any other.
 */
export function findPassage(
	text: string,
	q: string,
	occ = 1,
): { from: number; to: number } | null {
	const words = q.trim().split(/\s+/).map(escapeRegExp);
	if (words.length === 0 || words[0] === '') return null;
	const pattern = new RegExp(words.join('\\s+'), 'g');
	let match: RegExpExecArray | null;
	let count = 0;
	while ((match = pattern.exec(text)) !== null) {
		count++;
		if (count === occ) return { from: match.index, to: match.index + match[0].length };
	}
	return null;
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
	const range = target.q ? findPassage(text, target.q, target.occ) : null;
	const line = range ? text.slice(0, range.from).split('\n').length - 1 : 0;
	if (target.q && !range) new Notice('Passage not found; the note was opened at the beginning.');

	const leaf = app.workspace.getLeaf(newLeaf);
	await leaf.openFile(file, { active: true, eState: { line } });
	const view = await viewShowing(app, file, leaf);
	if (!view) return;
	if (view.leaf !== leaf) view.setEphemeralState({ line });
	if (!range || view.getMode() !== 'source') return;

	const editor = view.editor;
	const from = editor.offsetToPos(range.from);
	const to = editor.offsetToPos(range.to);
	// Focus first: an editor that gains focus later reads the browser's
	// selection and would replace the passage selection with it.
	editor.focus();
	editor.setSelection(from, to);
	editor.scrollIntoView({ from, to }, true);
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
