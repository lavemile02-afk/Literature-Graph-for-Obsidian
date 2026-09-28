import { App, Editor, FuzzySuggestModal, TFile } from 'obsidian';
import { citationText, citationUrl, noteParam } from './citationLink';
import type { CitationIndex } from './citationIndex';
import type { LiteratureGraphSettings } from './settings';

interface Choice {
	file: TFile;
	citation: string;
	title: string;
}

/**
 * Picks a work of the literature folder and inserts a citation link to it at
 * the cursor: "([Smith et al., 2020](obsidian://cite?note=...))". The link
 * cites the whole work; copy a link from a selection to cite a passage.
 */
export class InsertCitationModal extends FuzzySuggestModal<Choice> {
	constructor(
		app: App,
		private readonly editor: Editor,
		private readonly index: CitationIndex,
		private readonly settings: LiteratureGraphSettings,
	) {
		super(app);
		this.setPlaceholder('Cite a work: type an author, a year or words of the title');
	}

	getItems(): Choice[] {
		return this.app.vault
			.getMarkdownFiles()
			.filter((file) => this.index.isLiterature(file))
			.map((file) => {
				const title: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.[this.settings.titleProperty];
				return {
					file,
					citation: citationText(this.app, file, this.settings),
					title: typeof title === 'string' && title ? title : file.basename,
				};
			})
			.sort((a, b) => a.citation.localeCompare(b.citation));
	}

	getItemText(choice: Choice): string {
		return `${choice.citation} — ${choice.title}`;
	}

	onChooseItem(choice: Choice): void {
		const label = choice.citation.replace(/([[\]])/g, '\\$1');
		this.editor.replaceSelection(`([${label}](${citationUrl({ note: noteParam(this.app, choice.file) })}))`);
	}
}
