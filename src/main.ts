import { Editor, MarkdownFileInfo, MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { CitationCheckModal, checkCitations } from './check';
import { CitationIndex } from './citationIndex';
import { CITE_ACTION, parseCitationParams } from './citation';
import { buildCitationLink } from './citationLink';
import { registerCitationClicks } from './clicks';
import { withoutCitationLinks } from './links';
import { buildReferenceList } from './references';
import { updateLinksAfterRename } from './rename';
import { openCitation } from './navigation';
import {
	DEFAULT_SETTINGS,
	LiteratureGraphSettings,
	LiteratureGraphSettingTab,
} from './settings';

export default class LiteratureGraphPlugin extends Plugin {
	settings!: LiteratureGraphSettings;
	index!: CitationIndex;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new LiteratureGraphSettingTab(this.app, this));

		this.index = new CitationIndex(this.app, () => this.settings.doiProperty);
		const fileForDoi = (doi: string) => this.index.fileForDoi(doi);
		this.app.workspace.onLayoutReady(() => void this.startIndex());

		this.registerObsidianProtocolHandler(CITE_ACTION, (params) => {
			void openCitation(this.app, parseCitationParams(params), false, fileForDoi);
		});
		registerCitationClicks(this, fileForDoi);

		this.addCommand({
			id: 'copy-citation-link',
			name: 'Copy citation link to selection',
			editorCheckCallback: (checking, editor, info) => {
				if (!editor.somethingSelected() || !info.file) return false;
				if (!checking) void this.copyCitationLink(editor, info);
				return true;
			},
		});
		this.addCommand({
			id: 'insert-reference-list',
			name: 'Insert reference list',
			editorCallback: (editor) => this.insertReferenceList(editor),
		});
		this.addCommand({
			id: 'check-citations',
			name: 'Check citations in this note',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'md') return false;
				if (!checking) void this.checkNote(file);
				return true;
			},
		});
		this.addCommand({
			id: 'copy-without-citation-links',
			name: 'Copy note without citation links',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'md') return false;
				if (!checking) void this.copyWithoutCitationLinks(file);
				return true;
			},
		});
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor, info) => {
				if (!editor.somethingSelected() || !info.file) return;
				menu.addItem((item) =>
					item
						.setSection('selection')
						.setTitle('Copy citation link')
						.setIcon('quote')
						.onClick(() => void this.copyCitationLink(editor, info)),
				);
			}),
		);
	}

	/** Copies a citation link to the selected passage to the clipboard. */
	async copyCitationLink(editor: Editor, info: MarkdownView | MarkdownFileInfo) {
		const file = info.file;
		if (!file) return;
		const text = editor.getValue();
		const from = editor.posToOffset(editor.getCursor('from'));
		const to = editor.posToOffset(editor.getCursor('to'));
		const link = buildCitationLink(this.app, file, text, from, to, this.settings);
		if (!link) return;
		await navigator.clipboard.writeText(link);
		new Notice('Citation link copied.');
	}

	/** Builds the citation index, then keeps it up to date. */
	private async startIndex() {
		await this.index.build();
		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => void this.index.indexFile(file)),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile) this.index.removeFile(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile && file.extension === 'md') this.index.renameFile(file, oldPath);
				if (this.settings.updateLinksOnRename) {
					void updateLinksAfterRename(this.app, this.index, file, oldPath);
				}
			}),
		);
	}

	/**
	 * Inserts, at the cursor, the reference list of the works cited in the note,
	 * and says which in-text citations need a letter (2020a, 2020b).
	 */
	insertReferenceList(editor: Editor) {
		const list = buildReferenceList(this.app, editor.getValue(), this.settings, (doi) =>
			this.index.fileForDoi(doi),
		);
		if (!list.text) {
			new Notice('This note cites no work of the vault.');
			return;
		}
		editor.replaceSelection(`${list.text}\n`);
		const messages: string[] = [];
		for (const { citation, letters } of list.lettered) {
			messages.push(`"${citation}" is shared by several works: write ${letters.join(', ')} in the text, as in the list.`);
		}
		if (list.skipped.length > 0) {
			messages.push(`Not in the list (no note in the vault): ${list.skipped.join('; ')}.`);
		}
		if (messages.length > 0) new Notice(messages.join('\n\n'), 15000);
	}

	/** Checks the citation links of a note and lists those that need attention. */
	async checkNote(file: TFile) {
		const results = await checkCitations(this.app, await this.app.vault.read(file), (doi) =>
			this.index.fileForDoi(doi),
		);
		if (results.length === 0) {
			new Notice('This note has no citation links.');
			return;
		}
		new CitationCheckModal(this.app, file, results).open();
	}

	/** Copies the note with each citation link replaced by its text, for export. */
	async copyWithoutCitationLinks(file: TFile) {
		await navigator.clipboard.writeText(withoutCitationLinks(await this.app.vault.read(file)));
		new Notice('Note copied without citation links.');
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<LiteratureGraphSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
