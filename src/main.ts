import { Events, Notice, Plugin, TFile } from 'obsidian';
import { CitationIndex } from './citationIndex';
import { BETTER_CITATIONS_READY, betterCitations } from './navigation';
import { OpenAlexClient } from './openalex';
import { GRAPH_VIEW, LiteratureGraphView } from './graphView';
import { CITATIONS_VIEW, CitationsView } from './panel';
import { DuplicatesModal } from './duplicatesModal';
import { PositionStore } from './positions';
import { GhostNoteStore } from './ghostNotes';
import { MeaningCache } from './meaningCache';
import { MeaningModelStore } from './meaningModelStore';
import { writeSuggestionsFile } from './suggestionsFile';
import { writeKeywordsToNotes } from './keywordNotes';
import { WORK_VIEW, WorkView } from './workView';
import { DEFAULT_SETTINGS, LiteratureGraphSettings, LiteratureGraphSettingTab } from './settings';

export default class LiteratureGraphPlugin extends Plugin {
	settings!: LiteratureGraphSettings;
	index!: CitationIndex;
	openAlex!: OpenAlexClient;
	positions!: PositionStore;
	ghosts!: GhostNoteStore;
	meaningCache!: MeaningCache;
	meaningModel!: MeaningModelStore;
	/** Resolves when the citation index is first built. */
	private indexReady: Promise<void> | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new LiteratureGraphSettingTab(this.app, this));

		this.index = new CitationIndex(this.app, () => this.settings);
		this.openAlex = new OpenAlexClient(this.app, `${this.manifest.dir ?? ''}/openalex-cache.json`, () => ({
			enabled: this.settings.openAlexEnabled,
			email: this.settings.openAlexEmail,
			apiKey: this.settings.openAlexKeySecret
				? (this.app.secretStorage.getSecret(this.settings.openAlexKeySecret) ?? '')
				: '',
		}));
		this.openAlex.onLimit = (error) => new Notice(error.message, 12000);
		this.positions = new PositionStore(this.app, `${this.manifest.dir ?? ''}/layout-positions.json`);
		this.ghosts = new GhostNoteStore(this.app, `${this.manifest.dir ?? ''}/ghost-notes.json`);
		this.meaningCache = new MeaningCache(this.app, `${this.manifest.dir ?? ''}/meaning-cache.json`);
		this.meaningModel = new MeaningModelStore(this.app, `${this.manifest.dir ?? ''}/meaning-model.json`);
		this.app.workspace.onLayoutReady(() => {
			void this.startIndex();
			this.connectBetterCitations();
		});
		// Better Citations may load after this plugin: it says when it is ready.
		this.registerEvent((this.app.workspace as Events).on(BETTER_CITATIONS_READY, () => this.connectBetterCitations()));

		this.registerView(CITATIONS_VIEW, (leaf) => new CitationsView(leaf, this.index, () => this.settings, this.openAlex));
		this.addRibbonIcon('quote', 'Open citations panel', () => void this.openCitationsPanel());
		this.registerView(
			GRAPH_VIEW,
			(leaf) =>
				new LiteratureGraphView(
					leaf,
					this.index,
					this.openAlex,
					() => this.settings,
					async (changes) => {
						Object.assign(this.settings, changes);
						await this.saveSettings();
						this.onSettingsChanged();
					},
					this.positions,
					this.ghosts,
					this.meaningCache,
					this.meaningModel,
				),
		);
		this.registerView(WORK_VIEW, (leaf) => new WorkView(leaf, this.openAlex, () => this.settings, this.ghosts));
		this.addRibbonIcon('network', 'Open literature graph', () => void this.openGraph());
		this.addCommand({
			id: 'recompute-meaning',
			name: 'Recompute the meaning of the works',
			callback: async () => {
				// Learned again from the notes as they are now, at the next display.
				await this.meaningModel.clear();
				this.meaningCache.reset();
				for (const leaf of this.app.workspace.getLeavesOfType(GRAPH_VIEW)) {
					if (leaf.view instanceof LiteratureGraphView) leaf.view.recomputeMeaning();
				}
				new Notice('The meaning of the works is computed again.');
			},
		});
		this.addCommand({
			id: 'open-graph',
			name: 'Open graph',
			callback: () => void this.openGraph(),
		});
		this.addCommand({
			id: 'open-local-graph',
			name: 'Open local graph',
			callback: () => void this.openLocalGraph(),
		});
		this.addCommand({
			id: 'open-citations-panel',
			name: 'Open citations panel',
			callback: () => void this.openCitationsPanel(),
		});
		this.addCommand({
			id: 'find-duplicate-works',
			name: 'Find duplicate works',
			callback: () => new DuplicatesModal(this.app, this.index.duplicates()).open(),
		});
		this.addCommand({
			id: 'open-reading-suggestions',
			name: 'Open reading suggestions',
			callback: () => void this.openReadingSuggestions(),
		});
		this.addCommand({
			id: 'export-reading-suggestions',
			name: 'Export reading suggestions',
			callback: () => void this.exportReadingSuggestions(),
		});
		this.addCommand({
			id: 'write-keywords-to-notes',
			name: 'Write keywords to notes',
			callback: () => void this.writeKeywords(),
		});
	}

	/**
	 * Writes OpenAlex's keywords into the keywords property of the literature
	 * notes where it is empty; keywords already there (maybe edited) are kept.
	 */
	async writeKeywords() {
		const notice = new Notice('Keywords: starting…', 0);
		try {
			await this.indexReady;
			const { written, kept, none } = await writeKeywordsToNotes(this.app, this.index, this.openAlex, this.settings, (message) =>
				notice.setMessage(`Keywords: ${message}`),
			);
			notice.hide();
			new Notice(`Keywords written to ${written} notes; ${kept} already had keywords (kept as they are); ${none} have none on OpenAlex.`);
			this.onSettingsChanged();
		} catch (error) {
			notice.hide();
			new Notice(`The keywords could not be written: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Opens the literature graph with its list of reading suggestions. */
	async openReadingSuggestions() {
		await this.openGraph();
		const view = this.app.workspace.getActiveViewOfType(LiteratureGraphView);
		view?.toggleSuggestions(true);
	}

	/** Writes the reading suggestions to their file, for AI agents and other programs. */
	async exportReadingSuggestions() {
		const path = this.settings.suggestionsFile.trim() || `${this.manifest.dir ?? ''}/reading-suggestions.jsonl`;
		const notice = new Notice('Reading suggestions: building the list…', 0);
		try {
			await this.indexReady;
			const count = await writeSuggestionsFile(this.app, this.index, this.openAlex, this.settings, path, (message) =>
				notice.setMessage(`Reading suggestions: ${message}`),
			);
			notice.hide();
			new Notice(`${count} reading suggestions written to ${path}.`);
		} catch (error) {
			notice.hide();
			new Notice(`The reading suggestions could not be written: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * With Better Citations installed, its hover previews of works cited by DOI
	 * only show their title, from the OpenAlex cache (or OpenAlex).
	 */
	private connectBetterCitations() {
		betterCitations(this.app)?.setDoiTitleProvider(async (doi) => {
			const cached = this.openAlex.cachedIdForDoi(doi);
			const work = cached ? this.openAlex.cachedWork(cached) : await this.openAlex.workByDoi(doi);
			return work?.title ?? null;
		});
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
		this.indexReady = this.index.build();
		await this.indexReady;
		this.registerEvent(this.app.metadataCache.on('changed', (file) => void this.index.indexFile(file)));
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile) this.index.removeFile(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile && file.extension === 'md') this.index.renameFile(file, oldPath);
			}),
		);
	}

	onunload() {
		betterCitations(this.app)?.setDoiTitleProvider(null);
		void this.openAlex.flush();
		void this.positions.flush();
		void this.ghosts.flush();
		void this.meaningCache.flush();
	}

	/** Called when a setting changes in the settings tab. */
	onSettingsChanged() {
		for (const leaf of this.app.workspace.getLeavesOfType(GRAPH_VIEW)) {
			if (leaf.view instanceof LiteratureGraphView) leaf.view.applySettings();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<LiteratureGraphSettings>);
		// A setting of earlier versions: PDFs are now saved in the vault (pdfFolder).
		delete (this.settings as LiteratureGraphSettings & { downloadFolder?: string }).downloadFolder;
		// Earlier versions kept the Meaning regions on for every graph; they are now off whenever a graph opens.
		delete (this.settings as LiteratureGraphSettings & { graphShowRegions?: boolean }).graphShowRegions;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
