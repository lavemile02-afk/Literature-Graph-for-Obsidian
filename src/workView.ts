import { ItemView, normalizePath, Notice, requestUrl, setIcon, ViewStateResult, WorkspaceLeaf } from 'obsidian';
// The download folder may be anywhere on the computer (the plugin is for
// desktop only), so Node's file system is used for it, not the vault's.
import { mkdir, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type { GhostNoteStore, GhostWork } from './ghostNotes';
import type { OpenAlexClient } from './openalex';
import type { LiteratureGraphSettings } from './settings';
import { defaultTemplate, fillTemplate, valuesFromDetails, valuesFromEntry, WorkValues } from './workNote';

export const WORK_VIEW = 'literature-graph-work';

/** Which work a ghost note shows: an OpenAlex work (id or DOI), or a reference-list entry. */
export interface WorkState {
	id?: string | null;
	doi?: string | null;
	/** A work known only from a reference list. */
	entry?: { text: string; title: string; label: string; year: string } | null;
}

/** A line of the note's properties: a key and its value, or a line kept as it is (a list item). */
interface PropertyLine {
	key: string | null;
	value: string;
	raw: string;
	/** The items of a list property (one per line in the note), if it is one. */
	list?: string[];
}

/**
 * The "ghost note" of a work that is not in the vault: it looks like its
 * note-to-be (title, properties filled from OpenAlex, text of the template),
 * but it is not a file. What is written in it (properties and text) is kept
 * with the plugin (see `ghostNotes.ts`) and shown again next time; only the
 * "Create note" button creates the note, in the literature folder.
 */
export class WorkView extends ItemView {
	private work: WorkState = {};
	private values: WorkValues | null = null;
	private pdfUrl: string | null = null;
	private openAccessUrl: string | null = null;
	private lines: PropertyLine[] = [];
	private body = '';
	private creating = false;
	/** The work as the ghost notes know it (its OpenAlex id once known). */
	private ghost: GhostWork = {};

	constructor(
		leaf: WorkspaceLeaf,
		private readonly openAlex: OpenAlexClient,
		private readonly settings: () => LiteratureGraphSettings,
		private readonly ghosts: GhostNoteStore,
	) {
		super(leaf);
	}

	getViewType(): string {
		return WORK_VIEW;
	}

	getDisplayText(): string {
		return this.values?.fileName ?? 'Work outside the vault';
	}

	getIcon(): string {
		return 'ghost';
	}

	getState(): Record<string, unknown> {
		return { ...this.work };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as Partial<WorkState>;
		this.work = { id: s.id ?? null, doi: s.doi ?? null, entry: s.entry ?? null };
		await super.setState(state, result);
		await this.loadWork();
	}

	/** Fetches the work's data (OpenAlex, or its entry) and shows its note-to-be. */
	private async loadWork(): Promise<void> {
		const el = this.contentEl;
		el.empty();
		el.addClass('literature-graph-work-view');
		el.createDiv({ cls: 'literature-graph-work-status', text: 'Loading…' });
		const s = this.settings();
		const language = s.citationLanguage === 'fr' ? 'fr' : 'en';
		this.pdfUrl = null;
		this.openAccessUrl = null;
		this.ghost = { ...this.work };
		await this.ghosts.load();
		if (this.work.entry) {
			this.values = valuesFromEntry(this.work.entry);
		} else {
			const details = await this.openAlex.workDetails({ id: this.work.id, doi: this.work.doi });
			if (!details) {
				el.empty();
				el.createDiv({
					cls: 'literature-graph-work-status',
					text: this.openAlex.isRateLimited
						? 'OpenAlex refuses requests for now, and this work is not in the cache yet.'
						: 'OpenAlex does not know this work, or cannot be reached.',
				});
				if (this.work.doi) this.addButton(el, 'external-link', 'Open DOI', () => window.open(`https://doi.org/${this.work.doi}`));
				return;
			}
			this.values = valuesFromDetails(details, language);
			this.ghost = { id: details.id, doi: this.values.doi || this.work.doi };
			this.pdfUrl = details.pdfUrl;
			this.openAccessUrl = details.openAccessUrl;
			// Its topics and keywords, from the cache (fetched once if missing).
			await this.openAlex.loadExtras([details.id]);
			const summary = this.openAlex.cachedWork(details.id);
			this.values.topics = (summary?.topics ?? []).map(([topic]) => this.openAlex.topicInfo(topic)?.name ?? '').filter(Boolean);
			this.values.keywords = (summary?.keywords ?? []).map(([name]) => name);
		}
		const template =
			s.noteTemplate.trim() ||
			defaultTemplate({
				title: s.titleProperty || 'title',
				citationText: s.citationTextProperty || 'citation-text',
				authors: s.authorsProperty || 'authors',
				year: s.yearProperty || 'year',
				doi: s.doiProperty || 'doi',
				keywords: s.keywordsProperty.trim() || 'keywords',
			});
		this.split(this.ghosts.get(this.ghost) ?? fillTemplate(template, this.values));
		// The tab's title follows the work.
		(this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
		this.render();
	}

	/** Splits the note's text into its properties (one per line) and its body. */
	private split(text: string): void {
		const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
		const unquote = (v: string) => v.replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
		this.lines = [];
		for (const raw of (match?.[1] ?? '').split('\n')) {
			// An item of a list property ("  - value") belongs to the property above it.
			const item = /^\s+-\s+(.*)$/.exec(raw);
			const last = this.lines[this.lines.length - 1];
			if (item && last && last.key !== null && last.value === '') {
				(last.list ??= []).push(unquote(item[1] ?? ''));
				continue;
			}
			const property = /^([^\s:#-][^:]*):\s*(.*)$/.exec(raw);
			if (!property) {
				this.lines.push({ key: null, value: '', raw });
				continue;
			}
			this.lines.push({ key: property[1] ?? '', value: unquote(property[2] ?? ''), raw });
		}
		this.body = match ? text.slice(match[0].length) : text;
	}

	/** The note's text from its properties and body, as they are now. */
	private text(): string {
		const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
		const lines = this.lines.map((l) => {
			if (l.key === null) return l.raw;
			// A list property: one item per line (or empty).
			if (l.list) return [`${l.key}:`, ...l.list.map((v) => `  - ${quote(v)}`)].join('\n');
			return l.value ? `${l.key}: ${quote(l.value)}` : `${l.key}:`;
		});
		return lines.length > 0 ? `---\n${lines.join('\n')}\n---\n${this.body}` : this.body;
	}

	private addButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
		const button = parent.createEl('button', { cls: 'literature-graph-work-button' });
		setIcon(button.createSpan(), icon);
		button.createSpan({ text: label });
		button.addEventListener('click', onClick);
	}

	private render(): void {
		const values = this.values;
		if (!values) return;
		const el = this.contentEl;
		el.empty();
		const folder = this.settings().literatureFolder.replace(/\/+$/, '');
		const banner = el.createDiv({ cls: 'literature-graph-work-banner' });
		banner.createDiv({
			text: `Not in your vault. What you write here is kept with the plugin; “Create note” makes it “${values.fileName}” in ${folder || 'the vault'}.`,
		});
		const buttons = banner.createDiv({ cls: 'literature-graph-work-buttons' });
		this.addButton(buttons, 'file-plus', 'Create note', () => void this.create());
		if (this.ghosts.get(this.ghost) !== undefined) this.addButton(buttons, 'rotate-ccw', 'Discard changes', () => this.discard());
		if (values.doi) this.addButton(buttons, 'external-link', 'Open DOI', () => window.open(`https://doi.org/${values.doi}`));
		if (this.pdfUrl) this.addButton(buttons, 'download', 'Download PDF', () => void this.download());
		else if (this.openAccessUrl) {
			const url = this.openAccessUrl;
			this.addButton(buttons, 'book-open', 'Read for free', () => window.open(url));
		}

		el.createEl('h1', { cls: 'literature-graph-work-title', text: values.fileName });
		const table = el.createDiv({ cls: 'literature-graph-work-properties' });
		this.lines.forEach((line) => {
			if (line.key === null) {
				if (line.raw.trim()) table.createDiv({ cls: 'literature-graph-work-property-extra', text: line.raw });
				return;
			}
			const row = table.createDiv({ cls: 'literature-graph-work-property' });
			row.createDiv({ cls: 'literature-graph-work-property-key', text: line.key });
			// A list property shows its items separated by commas.
			const input = row.createEl('input', { type: 'text', value: line.list ? line.list.join(', ') : line.value });
			input.addEventListener('input', () => {
				if (line.list) {
					line.list = input.value
						.split(',')
						.map((v) => v.trim())
						.filter(Boolean);
				} else line.value = input.value;
				this.keep();
			});
		});
		const body = el.createEl('textarea', { cls: 'literature-graph-work-body' });
		body.value = this.body;
		body.placeholder = 'Write here: your notes on this work.';
		body.addEventListener('input', () => {
			this.body = body.value;
			this.keep();
		});
	}

	/** Keeps what was written, with the plugin; the first change brings the "Discard changes" button. */
	private keep(): void {
		const first = this.ghosts.get(this.ghost) === undefined;
		this.ghosts.set(this.ghost, this.text());
		if (first) {
			const buttons = this.contentEl.querySelector<HTMLElement>('.literature-graph-work-buttons');
			if (buttons) this.addButton(buttons, 'rotate-ccw', 'Discard changes', () => this.discard());
		}
	}

	/** Forgets what was written: the ghost note is filled from its template again. */
	private discard(): void {
		this.ghosts.delete(this.ghost);
		void this.loadWork();
	}

	/** Creates the note (once) and opens it in place of the ghost note; what was kept for it is then forgotten. */
	private async create(): Promise<void> {
		if (this.creating || !this.values) return;
		this.creating = true;
		try {
			const folder = this.settings().literatureFolder.replace(/\/+$/, '');
			if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
			const base = this.values.fileName || 'Untitled work';
			let path = normalizePath(`${folder ? `${folder}/` : ''}${base}.md`);
			for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) {
				path = normalizePath(`${folder ? `${folder}/` : ''}${base} (${n}).md`);
			}
			const file = await this.app.vault.create(path, this.text());
			this.ghosts.delete(this.ghost);
			await this.leaf.openFile(file, { active: true });
			new Notice(`Created “${file.basename}”.`);
		} catch (error) {
			this.creating = false;
			new Notice(`The note could not be created: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Downloads the free PDF into the download folder of the settings (or the
	 * Downloads folder), named like the note. A link that does not give a PDF
	 * (a web page) is opened in the browser instead.
	 */
	private async download(): Promise<void> {
		const url = this.pdfUrl;
		const values = this.values;
		if (!url || !values) return;
		try {
			const response = await requestUrl({ url, throw: false });
			const bytes = new Uint8Array(response.arrayBuffer.slice(0, 5));
			const isPdf = String.fromCharCode(...bytes) === '%PDF-';
			if (response.status >= 400 || !isPdf) {
				window.open(url);
				new Notice('This free version is a web page, not a PDF: it was opened in your browser.');
				return;
			}
			const folder = this.settings().downloadFolder.trim() || join(homedir(), 'Downloads');
			await mkdir(folder, { recursive: true });
			const target = join(folder, `${values.fileName || 'work'}.pdf`);
			await writeFile(target, new Uint8Array(response.arrayBuffer));
			new Notice(`PDF saved: ${target}`);
		} catch (error) {
			new Notice(`The PDF could not be downloaded: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
