import { debounce, ItemView, MarkdownView, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import { citationText } from './citationLink';
import type { CitationIndex, CitedWork } from './citationIndex';
import type { BibEntry } from './bibliography';
import type { CitationLink } from './links';
import { openCitation, openFileAtLine } from './navigation';
import { OpenAlexClient, WorkSummary, workCitation } from './openalex';
import type { LiteratureGraphSettings } from './settings';

export const CITATIONS_VIEW = 'literature-graph-citations';

/**
 * A work shown in the panel: a note of the vault, a work known by DOI or
 * OpenAlex id, a broken link, or an entry of a reference list that is not
 * linked to anything (it opens at its line in `file`).
 */
interface WorkRow {
	kind: 'note' | 'doi' | 'broken' | 'entry';
	file: TFile | null;
	/** Line to open in `file` (entries). */
	line?: number;
	doi: string | null;
	/** OpenAlex id, when known. */
	openAlexId: string | null;
	label: string;
	detail: string;
}

const STATUS_ICON: Record<WorkRow['kind'], string> = {
	note: 'file-check',
	doi: 'external-link',
	broken: 'file-x',
	entry: 'list',
};
const STATUS_LABEL: Record<WorkRow['kind'], string> = {
	note: 'In the vault',
	doi: 'Outside the vault',
	broken: 'Broken link',
	entry: 'Reference list entry',
};

/** How many works citing a work are listed at the second level. */
const CITING_LIMIT = 50;

/**
 * Sidebar view listing, for the active note, the works it cites, the notes
 * that cite it, and (from OpenAlex) the references of its work. Each work
 * expands to its own references and citing works: a tree of two levels.
 *
 * A work of the vault opens at the beginning of its note; each cited passage
 * opens precisely; a work outside the vault opens its DOI.
 */
export class CitationsView extends ItemView {
	private file: TFile | null = null;
	/** Keys of the entries the user toggled, kept across refreshes. */
	private readonly toggled = new Set<string>();
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
		this.registerEvent(this.index.on('moved', () => this.refresh()));
		this.followActiveNote();
	}

	/** Shows the note of the active Markdown view (the panel itself is ignored). */
	private followActiveNote(): void {
		const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
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

		// Cites: works cited by the note's citation links.
		const cited = this.citedByLinks(file);
		const cites = this.section(root, 'cites', 'Cites', cited.length, true);
		if (cited.length === 0) cites.createDiv({ cls: 'search-empty-state', text: 'No citation links.' });
		for (const { row, links } of cited) this.renderWork(cites, row, `cites:${this.rowKey(row)}`, 1, links);

		// Cited by: notes whose citation links, or whose reference list, cite this note.
		const citing = this.index.citing(file).sort((a, b) => a.path.localeCompare(b.path));
		const inBibliographies = this.index.citedInBibliographies(file).sort((a, b) => a.path.localeCompare(b.path));
		const citedBy = this.section(root, 'cited-by', 'Cited by', citing.length + inBibliographies.length, true);
		if (citing.length + inBibliographies.length === 0) {
			citedBy.createDiv({ cls: 'search-empty-state', text: 'No note cites this one.' });
		}
		for (const { path, links } of citing) this.renderCitingNote(citedBy, path, links);
		for (const { path, entries } of inBibliographies) this.renderCitingBibliography(citedBy, path, entries);

		// References of the work, from OpenAlex, when the note has a DOI...
		const doi = this.index.doiForFile(file);
		if (doi) void this.renderOpenAlexReferences(root, file, doi);
		// ...and from the note's own reference list.
		const entries = this.index.bibliographyOf(file);
		if (entries.length > 0) this.renderNoteBibliography(root, file, entries, doi === null);
	}

	/** The reference list of the note itself, each entry linked to a note or a DOI when possible. */
	private renderNoteBibliography(root: HTMLElement, file: TFile, entries: BibEntry[], open: boolean): void {
		const section = this.section(root, 'bibliography', 'References (from the note)', entries.length, open);
		const rows = entries.map((entry) => {
			const target = this.index.resolveEntry(entry, file.path);
			if (target) return { row: this.rowForFile(target), entry };
			const label = entry.firstAuthor && entry.year ? `${entry.firstAuthor}, ${entry.year}` : entry.text.slice(0, 40);
			const row: WorkRow = entry.doi
				? { kind: 'doi', file: null, doi: entry.doi, openAlexId: null, label, detail: entry.text }
				: { kind: 'entry', file, doi: null, openAlexId: null, label, detail: entry.text, line: entry.line };
			return { row, entry };
		});
		const linked = rows.filter((r) => r.row.kind === 'note').length;
		section.createDiv({
			cls: 'search-empty-state',
			text: `${linked} of ${entries.length} entries are notes of the vault. Entries are read from the note's reference list and matched by DOI, or by first author, year and title.`,
		});
		for (const { row, entry } of rows) this.renderWork(section, row, `bib:${file.path}:${entry.line}`, row.kind === 'entry' ? 2 : 1);
	}

	/** A note whose reference list cites the active note. */
	private renderCitingBibliography(parent: HTMLElement, path: string, entries: BibEntry[]): void {
		const citing = this.app.vault.getAbstractFileByPath(path);
		if (!(citing instanceof TFile)) return;
		const lines = entries.map((e) => e.line + 1).sort((a, b) => a - b);
		const row: WorkRow = {
			kind: 'entry',
			file: citing,
			doi: null,
			openAlexId: null,
			label: citing.basename,
			detail: `Reference list, line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}`,
			line: (lines[0] ?? 1) - 1,
		};
		this.renderWork(parent, row, '', 2);
	}

	// ----- Rows and sections -----

	private rowKey(row: WorkRow): string {
		return row.file?.path ?? row.doi ?? row.openAlexId ?? row.label;
	}

	private rowForFile(file: TFile): WorkRow {
		const title: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.[this.settings().titleProperty];
		return {
			kind: 'note',
			file,
			doi: this.index.doiForFile(file),
			openAlexId: null,
			label: citationText(this.app, file, this.settings()),
			detail: typeof title === 'string' && title ? title : file.basename,
		};
	}

	private rowForWork(work: WorkSummary): WorkRow {
		const file = work.doi ? this.index.fileForDoi(work.doi) : null;
		if (file) return { ...this.rowForFile(file), openAlexId: work.id };
		return {
			kind: 'doi',
			file: null,
			doi: work.doi,
			openAlexId: work.id,
			label: workCitation(work, this.settings().citationLanguage),
			detail: work.title,
		};
	}

	private rowForCited(work: CitedWork, link: CitationLink): WorkRow {
		if (work.kind === 'note') return this.rowForFile(work.file);
		if (work.kind === 'doi') {
			return { kind: 'doi', file: null, doi: work.doi, openAlexId: null, label: link.text, detail: `https://doi.org/${work.doi}` };
		}
		return {
			kind: 'broken',
			file: null,
			doi: null,
			openAlexId: null,
			label: link.text,
			detail: `Not found: ${work.text || 'the link has no note or DOI'}`,
		};
	}

	/** The works cited by a note's citation links, grouped, with the links. */
	private citedByLinks(file: TFile): { row: WorkRow; links: CitationLink[] }[] {
		const byKey = new Map<string, { row: WorkRow; links: CitationLink[] }>();
		for (const link of this.index.linksFrom(file)) {
			const row = this.rowForCited(this.index.resolve(link.target, link.text), link);
			const key = `${row.kind}:${this.rowKey(row)}`;
			const entry = byKey.get(key) ?? { row, links: [] };
			entry.links.push(link);
			byKey.set(key, entry);
		}
		return [...byKey.values()].sort((a, b) => a.row.label.localeCompare(b.row.label));
	}

	/**
	 * An expandable row. `defaultOpen` sets the state before any toggle; the
	 * children are built by `fill` the first time the row opens.
	 */
	private expandable(
		parent: HTMLElement,
		key: string,
		defaultOpen: boolean,
		buildSelf: (self: HTMLElement) => void,
		fill: (children: HTMLElement) => void,
		cls = 'tree-item',
	): HTMLElement {
		const item = parent.createDiv({ cls });
		const self = item.createDiv({ cls: 'tree-item-self is-clickable' });
		const toggle = self.createDiv({ cls: 'tree-item-icon collapse-icon' });
		setIcon(toggle, 'right-triangle');
		buildSelf(self);
		const children = item.createDiv({ cls: 'tree-item-children' });
		let filled = false;
		const isOpen = () => this.toggled.has(key) !== defaultOpen;
		const apply = () => {
			const open = isOpen();
			item.toggleClass('is-collapsed', !open);
			toggle.toggleClass('is-collapsed', !open);
			children.toggle(open);
			if (open && !filled) {
				filled = true;
				fill(children);
			}
		};
		toggle.addEventListener('click', (evt) => {
			evt.stopPropagation();
			if (this.toggled.has(key)) this.toggled.delete(key);
			else this.toggled.add(key);
			apply();
		});
		apply();
		// A click on a section header (no own action) toggles it too.
		if (!self.hasClass('has-action')) self.addEventListener('click', () => toggle.click());
		return children;
	}

	/** A top-level section with a heading and a count. */
	private section(root: HTMLElement, key: string, title: string, count: number | string, defaultOpen: boolean): HTMLElement {
		return this.expandable(
			root,
			`section:${key}`,
			defaultOpen,
			(self) => {
				self.addClass('literature-graph-section-header');
				self.createDiv({ cls: 'tree-item-inner', text: title });
				self.createDiv({ cls: 'tree-item-flair-outer' }).createSpan({ cls: 'tree-item-flair', text: String(count) });
			},
			() => undefined,
			'tree-item literature-graph-section',
		);
	}

	/**
	 * A work. At level 1 it expands to its cited passages (if any), its
	 * references and the works citing it; at level 2 it does not expand.
	 */
	private renderWork(parent: HTMLElement, row: WorkRow, key: string, level: 1 | 2, links: CitationLink[] = []): void {
		const buildSelf = (self: HTMLElement) => {
			self.addClass('has-action');
			const status = self.createDiv({ cls: 'literature-graph-status' });
			setIcon(status, STATUS_ICON[row.kind]);
			status.setAttr('aria-label', STATUS_LABEL[row.kind]);
			const inner = self.createDiv({ cls: 'tree-item-inner' });
			inner.createDiv({ cls: 'literature-graph-work-label', text: row.label });
			const detail = inner.createDiv({ cls: 'literature-graph-work-detail', text: row.detail });
			if (links.length > 0) {
				self.createDiv({ cls: 'tree-item-flair-outer' }).createSpan({ cls: 'tree-item-flair', text: String(links.length) });
			}
			self.addEventListener('click', () => this.openRow(row));
			// Works cited only by DOI (the detail is the DOI): show their title from OpenAlex.
			if (row.kind === 'doi' && row.doi && !row.openAlexId && row.detail.startsWith('https://doi.org/')) {
				void this.fillTitle(row, detail);
			}
		};
		const cls = `tree-item literature-graph-work is-${row.kind}`;
		if (level === 2 || row.kind === 'broken' || row.kind === 'entry') {
			if (links.length === 0) {
				const item = parent.createDiv({ cls });
				buildSelf(item.createDiv({ cls: 'tree-item-self is-clickable' }));
				return;
			}
		}
		this.expandable(parent, key, false, buildSelf, (children) => {
			for (const link of links) this.renderPassage(children, link);
			if (level === 1 && row.kind !== 'broken') {
				this.renderRelated(children, row, `${key}/refs`, 'references');
				this.renderRelated(children, row, `${key}/cited-by`, 'citing');
			}
		}, cls);
	}

	private renderPassage(parent: HTMLElement, link: CitationLink): void {
		const passage = parent.createDiv({ cls: 'tree-item-self is-clickable literature-graph-passage' });
		passage.setText(link.target.q ? `“${link.target.q}${link.target.qe ? ` … ${link.target.qe}` : ''}”` : '(whole work)');
		passage.addEventListener('click', () => {
			void openCitation(this.app, link.target, false, (doi) => this.index.fileForDoi(doi));
		});
	}

	/** "References" or "Cited by" of a work, loaded when opened. */
	private renderRelated(parent: HTMLElement, row: WorkRow, key: string, which: 'references' | 'citing'): void {
		let flair: HTMLElement | null = null;
		this.expandable(
			parent,
			key,
			false,
			(self) => {
				self.addClass('literature-graph-subsection');
				self.createDiv({ cls: 'tree-item-inner', text: which === 'references' ? 'References' : 'Cited by' });
				flair = self.createDiv({ cls: 'tree-item-flair-outer' }).createSpan({ cls: 'tree-item-flair', text: '' });
			},
			(children) => void this.fillRelated(children, row, which, flair),
			'tree-item literature-graph-related',
		);
	}

	private async fillRelated(
		children: HTMLElement,
		row: WorkRow,
		which: 'references' | 'citing',
		flair: HTMLElement | null,
	): Promise<void> {
		const status = children.createDiv({ cls: 'search-empty-state', text: 'Loading…' });
		const rows = new Map<string, WorkRow>();
		let total: number | null = null;
		let note = '';

		// From the vault's citation links.
		if (row.file) {
			const files =
				which === 'references'
					? this.index.linksFrom(row.file).map((l) => this.index.resolve(l.target, l.text))
					: this.index.citing(row.file).map((c) => ({ kind: 'note' as const, file: this.app.vault.getAbstractFileByPath(c.path) }));
			for (const work of files) {
				if (work.kind === 'note' && work.file instanceof TFile) {
					const r = this.rowForFile(work.file);
					rows.set(this.rowKey(r), r);
				}
			}
		}

		// From OpenAlex.
		try {
			const id = row.openAlexId ?? (row.doi ? (await this.openAlex.workByDoi(row.doi))?.id : undefined);
			if (id) {
				if (which === 'references') {
					const [work] = await this.openAlex.worksByIds([id]);
					const refs = work ? await this.openAlex.worksByIds(work.references) : [];
					total = work?.references.length ?? null;
					for (const w of refs) {
						const r = this.rowForWork(w);
						if (!rows.has(this.rowKey(r))) rows.set(this.rowKey(r), r);
					}
				} else {
					const citing = await this.openAlex.citingWorks(id, CITING_LIMIT);
					if (citing) {
						total = citing.total;
						if (citing.total > citing.works.length) note = `The ${citing.works.length} most cited of ${citing.total} works.`;
						for (const w of citing.works) {
							const r = this.rowForWork(w);
							if (!rows.has(this.rowKey(r))) rows.set(this.rowKey(r), r);
						}
					}
				}
			}
		} catch (error) {
			console.error('Literature Graph.md: OpenAlex request failed', error);
			note = 'OpenAlex could not be reached; showing what is known locally.';
		}

		status.remove();
		const sorted = [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));
		flair?.setText(String(total !== null ? Math.max(total, sorted.length) : sorted.length));
		if (sorted.length === 0) children.createDiv({ cls: 'search-empty-state', text: note || 'None known.' });
		for (const r of sorted) this.renderWork(children, r, '', 2);
		if (sorted.length > 0 && note) children.createDiv({ cls: 'search-empty-state', text: note });
	}

	/** Title of a work cited only by DOI, from OpenAlex (cached). */
	private async fillTitle(row: WorkRow, detail: HTMLElement): Promise<void> {
		try {
			const work = row.doi ? await this.openAlex.workByDoi(row.doi) : null;
			if (work) {
				row.openAlexId = work.id;
				detail.setText(work.title);
			}
		} catch {
			// Offline: keep the DOI as the detail.
		}
	}

	/** One note that cites the active note, which expands to its citing lines. */
	private renderCitingNote(parent: HTMLElement, path: string, links: CitationLink[]): void {
		const citing = this.app.vault.getAbstractFileByPath(path);
		if (!(citing instanceof TFile)) return;
		this.expandable(
			parent,
			`citing:${path}`,
			false,
			(self) => {
				self.addClass('has-action');
				self.createDiv({ cls: 'tree-item-inner', text: citing.basename });
				self.createDiv({ cls: 'tree-item-flair-outer' }).createSpan({ cls: 'tree-item-flair', text: String(links.length) });
				self.addEventListener('click', () => void openFileAtLine(this.app, citing, 0));
			},
			(children) => {
				for (const link of links) {
					const row = children.createDiv({ cls: 'tree-item-self is-clickable literature-graph-passage' });
					row.setText(`Line ${link.line + 1}: ${link.text}`);
					row.addEventListener('click', () => void openFileAtLine(this.app, citing, link.line));
				}
			},
			'tree-item literature-graph-citing',
		);
	}

	/** The bibliography of the active note's work, from OpenAlex (cached). */
	private async renderOpenAlexReferences(root: HTMLElement, file: TFile, doi: string): Promise<void> {
		const section = this.section(root, 'references', 'References (OpenAlex)', '', true);
		const flair = section.parentElement?.querySelector(':scope > .tree-item-self .tree-item-flair');
		const status = section.createDiv({ cls: 'search-empty-state', text: 'Loading…' });
		let works: WorkSummary[] = [];
		let known = 0;
		try {
			const work = await this.openAlex.workByDoi(doi);
			if (this.file !== file) return;
			if (!work) {
				status.setText(
					this.openAlex.isKnownDoi(doi)
						? 'OpenAlex does not know this DOI.'
						: !this.settings().openAlexEnabled
							? 'OpenAlex is turned off in the settings.'
							: (this.openAlex.lastError?.message ?? 'OpenAlex could not be reached.'),
				);
				flair?.setText('–');
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
		flair?.setText(String(known));
		if (known === 0) {
			status.setText('OpenAlex lists no references for this work.');
			return;
		}
		status.remove();
		const rows = works.map((w) => this.rowForWork(w)).sort((a, b) => a.label.localeCompare(b.label));
		for (const row of rows) this.renderWork(section, row, `refs:${this.rowKey(row)}`, 1);
		if (works.length < known) {
			section.createDiv({
				cls: 'search-empty-state',
				text: `${known - works.length} references could not be loaded (${
					this.openAlex.isRateLimited ? 'OpenAlex refuses requests for now' : 'offline, or not in OpenAlex'
				}).`,
			});
		}
	}

	private openRow(row: WorkRow): void {
		if (row.file) void openFileAtLine(this.app, row.file, row.line ?? 0);
		else if (row.doi) window.open(`https://doi.org/${row.doi}`);
		else if (row.openAlexId) window.open(`https://openalex.org/${row.openAlexId}`);
	}
}
