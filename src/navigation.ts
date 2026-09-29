import { App, MarkdownView, PaneType, TFile, WorkspaceLeaf } from 'obsidian';

/** Finds the note a citation link points to: by path first, then like a wikilink. */
export function resolveCitedNote(app: App, note: string): TFile | null {
	const byPath = app.vault.getAbstractFileByPath(note.endsWith('.md') ? note : `${note}.md`);
	if (byPath instanceof TFile) return byPath;
	return app.metadataCache.getFirstLinkpathDest(note, '');
}

/** Workspace event that Better Citations triggers once its API is ready. */
export const BETTER_CITATIONS_READY = 'better-citations:api-ready';

/** What the Better Citations plugin offers to other plugins (see its README). */
export interface BetterCitationsApi {
	openCitation(url: string, newTab?: PaneType | boolean): Promise<void>;
	setDoiTitleProvider(provider: ((doi: string) => Promise<string | null>) | null): void;
}

/**
 * The API of Better Citations, when it is installed and enabled: it opens
 * citation links at the cited passage. Without it, Literature Graph opens
 * cited works at the beginning of their note.
 */
export function betterCitations(app: App): BetterCitationsApi | null {
	const plugins = (app as unknown as { plugins?: { plugins?: Record<string, { api?: unknown } | undefined> } }).plugins;
	const api = plugins?.plugins?.['better-citations']?.api as Partial<BetterCitationsApi> | undefined;
	return api && typeof api.openCitation === 'function' && typeof api.setDoiTitleProvider === 'function'
		? (api as BetterCitationsApi)
		: null;
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
