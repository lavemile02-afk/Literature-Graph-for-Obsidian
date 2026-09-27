import { App, MarkdownView, Modal, TFile } from 'obsidian';
import { CitationLink, citationLinksIn } from './links';
import { resolveCitedNote } from './navigation';
import { findPassage } from './passage';

export type CitationStatus =
	| 'ok'
	| 'approximate'
	| 'passage-not-found'
	| 'external'
	| 'note-not-found';

export interface CheckedCitation {
	link: CitationLink;
	status: CitationStatus;
	/** The cited note, when it exists. */
	cited: TFile | null;
}

/** Checks that every citation link of a note leads to its note and passage. */
export async function checkCitations(app: App, noteText: string): Promise<CheckedCitation[]> {
	const texts = new Map<TFile, string>();
	const results: CheckedCitation[] = [];
	for (const link of citationLinksIn(noteText)) {
		const { note, q, qe, occ, doi } = link.target;
		const cited = note ? resolveCitedNote(app, note) : null;
		let status: CitationStatus;
		if (!cited) {
			status = doi ? 'external' : 'note-not-found';
		} else if (!q) {
			status = 'ok';
		} else {
			let text = texts.get(cited);
			if (text === undefined) {
				text = await app.vault.cachedRead(cited);
				texts.set(cited, text);
			}
			const match = findPassage(text, q, qe, occ);
			status = !match ? 'passage-not-found' : match.approximate ? 'approximate' : 'ok';
		}
		results.push({ link, status, cited });
	}
	return results;
}

function describe(result: CheckedCitation): string {
	const { note, doi } = result.link.target;
	switch (result.status) {
		case 'approximate':
			return `The passage was changed: only the closest text was found in "${result.cited?.basename ?? ''}".`;
		case 'passage-not-found':
			return `Passage not found in "${result.cited?.basename ?? ''}".`;
		case 'note-not-found':
			return note ? `No note named "${note}", and no DOI.` : 'The link has neither a note nor a DOI.';
		case 'external':
			return `No note for this work; the link opens https://doi.org/${doi ?? ''}.`;
		default:
			return 'OK';
	}
}

/** Lists the citation links of a note that need attention. */
export class CitationCheckModal extends Modal {
	constructor(
		app: App,
		private readonly file: TFile,
		private readonly results: CheckedCitation[],
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle(`Citations in "${this.file.basename}"`);

		const count = (status: CitationStatus) => this.results.filter((r) => r.status === status).length;
		const broken = count('passage-not-found') + count('note-not-found');
		const summary = [
			`${this.results.length} citation links`,
			`${count('ok')} OK`,
			`${count('approximate')} approximate`,
			`${broken} broken`,
			`${count('external')} outside the vault (DOI)`,
		].join(' · ');
		contentEl.createEl('p', { text: summary });

		const shown = this.results.filter((r) => r.status !== 'ok');
		if (shown.length === 0) {
			contentEl.createEl('p', { text: 'Every citation link leads to its passage.' });
			return;
		}
		const list = contentEl.createEl('ul', { cls: 'literature-graph-check-list' });
		for (const result of shown) {
			const item = list.createEl('li', { cls: `literature-graph-check-${result.status}` });
			const jump = item.createEl('a', { text: `Line ${result.link.line + 1}: ${result.link.text}`, href: '#' });
			jump.addEventListener('click', (evt) => {
				evt.preventDefault();
				this.close();
				this.goToLine(result.link.line);
			});
			item.createDiv({ text: describe(result), cls: 'setting-item-description' });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** Shows a line of the checked note in its open view. */
	private goToLine(line: number): void {
		const view = this.app.workspace
			.getLeavesOfType('markdown')
			.map((leaf) => leaf.view)
			.find((v): v is MarkdownView => v instanceof MarkdownView && v.file === this.file);
		if (!view) return;
		this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
		view.setEphemeralState({ line });
		if (view.getMode() === 'source') {
			view.editor.setCursor({ line, ch: 0 });
			view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
		}
	}
}
