import { Editor, MarkdownFileInfo, MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { CitationCheckModal, checkCitations } from './check';
import { CitationIndex } from './citationIndex';
import { CITE_ACTION, parseCitationParams } from './citation';
import { buildCitationLink } from './citationLink';
import { registerCitationClicks } from './clicks';
import { setHighlightDuration } from './highlight';
import { withoutCitationLinks } from './links';
import { findExactPassages, findPassage } from './passage';
import { buildReferenceList } from './references';
import { updateLinksAfterRename } from './rename';
import { openCitation } from './navigation';
import { OpenAlexClient } from './openalex';
import { GRAPH_VIEW, LiteratureGraphView } from './graphView';
import { CITATIONS_VIEW, CitationsView } from './panel';
import {
	DEFAULT_SETTINGS,
	LiteratureGraphSettings,
	LiteratureGraphSettingTab,
} from './settings';

export default class LiteratureGraphPlugin extends Plugin {
	settings!: LiteratureGraphSettings;
	index!: CitationIndex;
	openAlex!: OpenAlexClient;

	async onload() {
		await this.loadSettings();
		setHighlightDuration(Number(this.settings.highlightSeconds));
		this.addSettingTab(new LiteratureGraphSettingTab(this.app, this));

		this.index = new CitationIndex(this.app, () => this.settings);
		this.openAlex = new OpenAlexClient(this.app, `${this.manifest.dir ?? ''}/openalex-cache.json`, () => ({
			enabled: this.settings.openAlexEnabled,
			email: this.settings.openAlexEmail,
		}));
		const fileForDoi = (doi: string) => this.index.fileForDoi(doi);
		this.app.workspace.onLayoutReady(() => void this.startIndex());

		this.registerObsidianProtocolHandler(CITE_ACTION, (params) => {
			void openCitation(this.app, parseCitationParams(params), false, fileForDoi);
		});
		registerCitationClicks(this, fileForDoi);

		this.registerView(CITATIONS_VIEW, (leaf) => new CitationsView(leaf, this.index, () => this.settings, this.openAlex));
		this.addRibbonIcon('quote', 'Open citations panel', () => void this.openCitationsPanel());
		this.registerView(GRAPH_VIEW, (leaf) => new LiteratureGraphView(leaf, this.index, this.openAlex, () => this.settings));
		this.addRibbonIcon('network', 'Open literature graph', () => void this.openGraph());
		this.addCommand({
			id: 'open-literature-graph',
			name: 'Open literature graph',
			callback: () => void this.openGraph(),
		});
		this.addCommand({
			id: 'open-local-literature-graph',
			name: 'Open local literature graph',
			callback: () => void this.openLocalGraph(),
		});
		this.addCommand({
			id: 'open-citations-panel',
			name: 'Open citations panel',
			callback: () => void this.openCitationsPanel(),
		});

		this.addCommand({
			id: 'copy-citation-link',
			name: 'Copy citation link to selection',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;
				if (view.getMode() === 'source') {
					if (!view.editor.somethingSelected()) return false;
					if (!checking) void this.copyCitationLink(view.editor, view);
					return true;
				}
				// Reading view: the selected text is rendered text.
				const selected = activeWindow.getSelection()?.toString().trim() ?? '';
				if (!selected) return false;
				if (!checking) void this.copyCitationLinkFromReading(view, selected);
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

	/**
	 * Copies a citation link to a passage selected in the reading view. The
	 * rendered text is found back in the note's Markdown by the same
	 * normalized search that opens links; when it occurs more than once, the
	 * occurrence nearest to the part of the note on screen is used.
	 */
	async copyCitationLinkFromReading(view: MarkdownView, selected: string) {
		const file = view.file;
		if (!file) return;
		const text = await this.app.vault.cachedRead(file);
		const words = selected.split(/\s+/).filter(Boolean);
		const q = words.slice(0, 12).join(' ');
		const qe = words.length > 15 ? words.slice(-6).join(' ') : undefined;
		const matches = findExactPassages(text, q);
		if (matches.length === 0) {
			new Notice('The selection was not found in the note; select the passage in the editing view instead.');
			return;
		}
		const lineOf = (offset: number) => text.slice(0, offset).split('\n').length - 1;
		const onScreen = view.previewMode.getScroll();
		let occ = 1;
		matches.forEach((m, i) => {
			const best = matches[occ - 1];
			if (best && Math.abs(lineOf(m.from) - onScreen) < Math.abs(lineOf(best.from) - onScreen)) occ = i + 1;
		});
		const range = findPassage(text, q, qe, occ);
		if (!range) return;
		const link = buildCitationLink(this.app, file, text, range.from, range.to, this.settings);
		if (!link) return;
		await navigator.clipboard.writeText(link);
		new Notice('Citation link copied.');
	}

	/** Shows the citations panel in the right sidebar. */
	async openCitationsPanel() {
		const existing = this.app.workspace.getLeavesOfType(CITATIONS_VIEW)[0];
		const leaf = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		if (!existing) await leaf.setViewState({ type: CITATIONS_VIEW, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	/** Opens the literature graph in a new tab, or shows the open one. */
	async openGraph() {
		const existing = this.app.workspace
			.getLeavesOfType(GRAPH_VIEW)
			.find((leaf) => (leaf.getViewState().state as { local?: boolean } | undefined)?.local !== true);
		const leaf = existing ?? this.app.workspace.getLeaf('tab');
		if (!existing) await leaf.setViewState({ type: GRAPH_VIEW, active: true, state: { local: false } });
		await this.app.workspace.revealLeaf(leaf);
	}

	/** Opens the local literature graph (around the active note) in the right sidebar. */
	async openLocalGraph() {
		const existing = this.app.workspace
			.getLeavesOfType(GRAPH_VIEW)
			.find((leaf) => (leaf.getViewState().state as { local?: boolean } | undefined)?.local === true);
		const leaf = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		if (!existing) await leaf.setViewState({ type: GRAPH_VIEW, active: false, state: { local: true, depth: 1 } });
		await this.app.workspace.revealLeaf(leaf);
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

	onunload() {
		void this.openAlex.flush();
	}

	/** Called when a setting changes in the settings tab. */
	onSettingsChanged() {
		setHighlightDuration(Number(this.settings.highlightSeconds));
		for (const leaf of this.app.workspace.getLeavesOfType(GRAPH_VIEW)) {
			if (leaf.view instanceof LiteratureGraphView) leaf.view.applyColorGroups();
		}
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
