import { debounce, ItemView, MarkdownView, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import { citationText } from './citationLink';
import type { CitationIndex, CitedWork } from './citationIndex';
import type { CitationLink } from './links';
import { openCitation, openFileAtLine } from './navigation';
import { OpenAlexClient, WorkSummary, workCitation } from './openalex';
import type { LiteratureGraphSettings } from './settings';

export const CITATIONS_VIEW = 'literature-graph-citations';

/** A work cited by the active note, with the links that cite it. */
interface CitedEntry {
	work: CitedWork;
	label: string;
	detail: string;
	links: CitationLink[];
}

/**
 * Sidebar view listing, for the active note, the works it cites and the notes
 * that cite it. A work of the vault opens at the beginning of its note; each
 * cited passage opens precisely; a work outside the vault opens its DOI.
 */
export class CitationsView extends ItemView {
	private file: TFile | null = null;
	/** Keys of the entries the user expanded, kept across refreshes. */
	private readonly expanded = new Set<string>();
	private readonly refresh = debounce(() => this.render(), 300, true);

	constructor(
		leaf: WorkspaceLeaf,
		private readonly index: CitationIndex,
		private readonly settings: () => LiteratureGraphSettings,
		private readonly openAlex: OpenAlexClient,
	) {
		super(leaf);
	}

	getViewType(): string {
		return CITATIONS_VIEW;
	}

	getDisplayText(): string {
		return 'Citations';
	}

	getIcon(): string {
		return 'quote';
	}

	async onOpen(): Promise<void> {
		this.registerEvent(this.app.workspace.on('file-open', () => this.followActiveNote()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.followActiveNote()));
		this.registerEvent(this.index.on('changed', () => this.refresh()));
		this.followActiveNote();
	}

	/** Shows the note of the active Markdown view (the panel itself is ignored). */
	private followActiveNote(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file ?? null;
		if (file && file !== this.file) {
			this.file = file;
			this.render();
		} else if (!this.file) {
			this.render();
		}
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass('literature-graph-panel');
		const file = this.file;
		if (!file) {
			root.createDiv({ cls: 'pane-empty', text: 'Open a note to see its citations.' });
			return;
		}
		root.createDiv({ cls: 'literature-graph-panel-title', text: file.basename });

		const cited = this.citedEntries(file);
		const citesSection = this.section(root, 'cites', 'Cites', cited.length);
		if (cited.length === 0) citesSection.createDiv({ cls: 'search-empty-state', text: 'No citation links.' });
		for (const entry of cited) this.renderCited(citesSection, entry);

		const citing = this.index.citing(file).sort((a, b) => a.path.localeCompare(b.path));
		const citedBySection = this.section(root, 'cited-by', 'Cited by', citing.length);
		if (citing.length === 0) citedBySection.createDiv({ cls: 'search-empty-state', text: 'No note cites this one.' });
		for (const { path, links } of citing) this.renderCiting(citedBySection, path, links);

		const doi = this.index.doiForFile(file);
		if (doi) void this.renderReferences(root, file, doi);
	}

	/** Groups the citation links of a note by the work they cite. */
	private citedEntries(file: TFile): CitedEntry[] {
		const byKey = new Map<string, CitedEntry>();
		for (const link of this.index.linksFrom(file)) {
			const work = this.index.resolve(link.target, link.text);
			const key = work.kind === 'note' ? `note:${work.file.path}` : work.kind === 'doi' ? `doi:${work.doi}` : `broken:${work.text}`;
			let entry = byKey.get(key);
			if (!entry) {
				entry = { work, ...this.describe(work, link), links: [] };
				byKey.set(key, entry);
			}
			entry.links.push(link);
		}
		return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
	}

	private describe(work: CitedWork, link: CitationLink): { label: string; detail: string } {
		if (work.kind === 'note') {
			const title: unknown = this.app.metadataCache.getFileCache(work.file)?.frontmatter?.[this.settings().titleProperty];
			return {
				label: citationText(this.app, work.file, this.settings()),
				detail: typeof title === 'string' && title ? title : work.file.basename,
			};
		}
		if (work.kind === 'doi') return { label: link.text, detail: `https://doi.org/${work.doi}` };
		return { label: link.text, detail: `Not found: ${work.text || 'the link has no note or DOI'}` };
	}

	/** A collapsible section with a heading and a count. */
	private section(root: HTMLElement, key: string, title: string, count: number): HTMLElement {
		const section = root.createDiv({ cls: 'literature-graph-section' });
		const header = section.createDiv({ cls: 'tree-item-self is-clickable literature-graph-section-header' });
		const collapse = header.createDiv({ cls: 'tree-item-icon collapse-icon' });
		setIcon(collapse, 'right-triangle');
		header.createDiv({ cls: 'tree-item-inner', text: title });
		header.createDiv({ cls: 'tree-item-flair-outer' }).createSpan({ cls: 'tree-item-flair', text: String(count) });
		const children = section.createDiv({ cls: 'tree-item-children' });
		const closedKey = `section:${key}`;
		const apply = () => {
			const closed = this.expanded.has(closedKey);
			section.toggleClass('is-collapsed', closed);
			collapse.toggleClass('is-collapsed', closed);
			children.toggle(!closed);
		};
		header.addEventListener('click', () => {
			if (this.expanded.has(closedKey)) this.expanded.delete(closedKey);
			else this.expanded.add(closedKey);
			apply();
		});
		apply();
		return children;
	}

	/** One cited work, which expands to show the cited passages. */
	private renderCited(parent: HTMLElement, entry: CitedEntry): void {
		const key = entry.work.kind === 'note' ? entry.work.file.path : entry.detail;
		const item = parent.createDiv({ cls: `tree-item literature-graph-work is-${entry.work.kind}` });
		const self = item.createDiv({ cls: 'tree-item-self is-clickable' });
		const toggle = self.createDiv({ cls: 'tree-item-icon collapse-icon' });
		setIcon(toggle, 'right-triangle');
		const status = self.createDiv({ cls: 'literature-graph-status' });
		setIcon(status, entry.work.kind === 'note' ? 'file-check' : entry.work.kind === 'doi' ? 'external-link' : 'file-x');
		status.setAttr(
			'aria-label',
			entry.work.kind === 'note' ? 'In the vault' : entry.work.kind === 'doi' ? 'Outside the vault (DOI)' : 'Broken link',
		);
		const inner = self.createDiv({ cls: 'tree-item-inner' });
		inner.createDiv({ cls: 'literature-graph-work-label', text: entry.label });
		inner.createDiv({ cls: 'literature-graph-work-detail', text: entry.detail });
		self.createDiv({ cls: 'tree-item-flair-outer' }).createSpan({ cls: 'tree-item-flair', text: String(entry.links.length) });

		const passages = item.createDiv({ cls: 'tree-item-children' });
		const apply = () => {
			const open = this.expanded.has(key);
			item.toggleClass('is-collapsed', !open);
			toggle.toggleClass('is-collapsed', !open);
			passages.toggle(open);
		};
		toggle.addEventListener('click', (evt) => {
			evt.stopPropagation();
			if (this.expanded.has(key)) this.expanded.delete(key);
			else this.expanded.add(key);
			apply();
		});
		self.addEventListener('click', () => this.openWork(entry.work));
		for (const link of entry.links) {
			const passage = passages.createDiv({ cls: 'tree-item-self is-clickable literature-graph-passage' });
			passage.setText(link.target.q ? `“${link.target.q}${link.target.qe ? ` … ${link.target.qe}` : ''}”` : '(whole work)');
			passage.addEventListener('click', () => {
				void openCitation(this.app, link.target, false, (doi) => this.index.fileForDoi(doi));
			});
		}
		apply();
	}

	/** One note that cites the active note, which expands to its citing lines. */
	private renderCiting(parent: HTMLElement, path: string, links: CitationLink[]): void {
		const citing = this.app.vault.getAbstractFileByPath(path);
		if (!(citing instanceof TFile)) return;
		const key = `citing:${path}`;
		const item = parent.createDiv({ cls: 'tree-item literature-graph-citing' });
		const self = item.createDiv({ cls: 'tree-item-self is-clickable' });
		const toggle = self.createDiv({ cls: 'tree-item-icon collapse-icon' });
		setIcon(toggle, 'right-triangle');
		self.createDiv({ cls: 'tree-item-inner', text: citing.basename });
		self.createDiv({ cls: 'tree-item-flair-outer' }).createSpan({ cls: 'tree-item-flair', text: String(links.length) });
		const lines = item.createDiv({ cls: 'tree-item-children' });
		const apply = () => {
			const open = this.expanded.has(key);
			item.toggleClass('is-collapsed', !open);
			toggle.toggleClass('is-collapsed', !open);
			lines.toggle(open);
		};
		toggle.addEventListener('click', (evt) => {
			evt.stopPropagation();
			if (this.expanded.has(key)) this.expanded.delete(key);
			else this.expanded.add(key);
			apply();
		});
		self.addEventListener('click', () => void openFileAtLine(this.app, citing, 0));
		for (const link of links) {
			const row = lines.createDiv({ cls: 'tree-item-self is-clickable literature-graph-passage' });
			row.setText(`Line ${link.line + 1}: ${link.text}`);
			row.addEventListener('click', () => void openFileAtLine(this.app, citing, link.line));
		}
		apply();
	}

	/** The bibliography of the active note's work, from OpenAlex (cached). */
	private async renderReferences(root: HTMLElement, file: TFile, doi: string): Promise<void> {
		const section = this.section(root, 'references', 'References (OpenAlex)', 0);
		const count = section.parentElement?.querySelector('.tree-item-flair');
		const status = section.createDiv({ cls: 'search-empty-state', text: 'Loading…' });
		let works: WorkSummary[] = [];
		let known = 0;
		try {
			const work = await this.openAlex.workByDoi(doi);
			if (this.file !== file) return;
			if (!work) {
				status.setText(
					this.settings().openAlexEnabled || this.openAlex.isKnownDoi(doi)
						? 'OpenAlex does not know this DOI.'
						: 'OpenAlex is turned off in the settings.',
				);
				count?.setText('–');
				return;
			}
			known = work.references.length;
			works = await this.openAlex.worksByIds(work.references);
		} catch (error) {
			console.error('Literature Graph.md: OpenAlex request failed', error);
			if (this.file === file) status.setText('OpenAlex could not be reached; showing what is cached.');
			return;
		}
		if (this.file !== file) return;
		count?.setText(String(known));
		if (known === 0) {
			status.setText('OpenAlex lists no references for this work.');
			return;
		}
		status.remove();
		const language = this.settings().citationLanguage;
		const rows = works
			.map((w) => ({ work: w, label: workCitation(w, language), file: w.doi ? this.index.fileForDoi(w.doi) : null }))
			.sort((a, b) => a.label.localeCompare(b.label));
		for (const row of rows) {
			const kind = row.file ? 'note' : 'doi';
			const item = section.createDiv({ cls: `tree-item literature-graph-work is-${kind}` });
			const self = item.createDiv({ cls: 'tree-item-self is-clickable' });
			const icon = self.createDiv({ cls: 'literature-graph-status' });
			setIcon(icon, row.file ? 'file-check' : 'external-link');
			icon.setAttr('aria-label', row.file ? 'In the vault' : 'Outside the vault');
			const inner = self.createDiv({ cls: 'tree-item-inner' });
			inner.createDiv({ cls: 'literature-graph-work-label', text: row.label });
			inner.createDiv({ cls: 'literature-graph-work-detail', text: row.work.title });
			const target = row.file;
			self.addEventListener('click', () => {
				if (target) void openFileAtLine(this.app, target, 0);
				else window.open(row.work.doi ? `https://doi.org/${row.work.doi}` : `https://openalex.org/${row.work.id}`);
			});
		}
		if (works.length < known) {
			section.createDiv({
				cls: 'search-empty-state',
				text: `${known - works.length} references could not be loaded (offline, or not in OpenAlex).`,
			});
		}
	}

	private openWork(work: CitedWork): void {
		if (work.kind === 'note') void openFileAtLine(this.app, work.file, 0);
		else if (work.kind === 'doi') window.open(`https://doi.org/${work.doi}`);
	}
}
