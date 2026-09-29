import { Events, Notice, Plugin, TFile } from 'obsidian';
import { CitationIndex } from './citationIndex';
import { BETTER_CITATIONS_READY, betterCitations } from './navigation';
import { OpenAlexClient } from './openalex';
import { GRAPH_VIEW, LiteratureGraphView } from './graphView';
import { CITATIONS_VIEW, CitationsView } from './panel';
import { PositionStore } from './positions';
import { WORK_VIEW, WorkView } from './workView';
import { DEFAULT_SETTINGS, LiteratureGraphSettings, LiteratureGraphSettingTab } from './settings';

export default class LiteratureGraphPlugin extends Plugin {
	settings!: LiteratureGraphSettings;
	index!: CitationIndex;
	openAlex!: OpenAlexClient;
	positions!: PositionStore;

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
					async (groups) => {
						this.settings.graphColorGroups = groups;
						await this.saveSettings();
						this.onSettingsChanged();
					},
					this.positions,
				),
		);
		this.registerView(WORK_VIEW, (leaf) => new WorkView(leaf, this.openAlex, () => this.settings));
		this.addRibbonIcon('network', 'Open literature graph', () => void this.openGraph());
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
		await this.index.build();
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
	}

	/** Called when a setting changes in the settings tab. */
	onSettingsChanged() {
		for (const leaf of this.app.workspace.getLeavesOfType(GRAPH_VIEW)) {
			if (leaf.view instanceof LiteratureGraphView) leaf.view.applySettings();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<LiteratureGraphSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
