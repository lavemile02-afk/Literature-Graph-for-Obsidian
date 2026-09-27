import { Editor, MarkdownFileInfo, MarkdownView, Notice, Plugin } from 'obsidian';
import { CITE_ACTION, parseCitationParams } from './citation';
import { buildCitationLink } from './citationLink';
import { registerCitationClicks } from './clicks';
import { openCitation } from './navigation';
import {
	DEFAULT_SETTINGS,
	LiteratureGraphSettings,
	LiteratureGraphSettingTab,
} from './settings';

export default class LiteratureGraphPlugin extends Plugin {
	settings!: LiteratureGraphSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new LiteratureGraphSettingTab(this.app, this));

		this.registerObsidianProtocolHandler(CITE_ACTION, (params) => {
			void openCitation(this.app, parseCitationParams(params));
		});
		registerCitationClicks(this);

		this.addCommand({
			id: 'copy-citation-link',
			name: 'Copy citation link to selection',
			editorCheckCallback: (checking, editor, info) => {
				if (!editor.somethingSelected() || !info.file) return false;
				if (!checking) void this.copyCitationLink(editor, info);
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
