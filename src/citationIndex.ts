import { App, Events, parseFrontMatterAliases, TAbstractFile, TFile, TFolder } from 'obsidian';
import { BibEntry, VaultWork, bibliographyEntries, entryMatches, isReferenceHeading, nameKey } from './bibliography';
import { CITE_URL_PREFIX, CitationTarget } from './citation';
import { CitationLink, citationLinksIn } from './links';
import { resolveCitedNote } from './navigation';
import type { LiteratureGraphSettings } from './settings';

/** What a citation points to: a note of the vault, a DOI outside it, or nothing. */
export type CitedWork =
	| { kind: 'note'; file: TFile }
	| { kind: 'doi'; doi: string }
	| { kind: 'broken'; text: string };

/** Lower case, without the https://doi.org/ prefix. */
export function normalizeDoi(doi: string): string {
	return doi
		.trim()
		.replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '')
		.replace(/^doi:\s*/i, '')
		.toLowerCase();
}

const DOI_IN_TEXT = /doi\.org\/(10\.\d{4,9}\/[^\s)\]>"']+)/i;
/** How far from the start of a note its own DOI is looked for, without a DOI property. */
const DOI_SEARCH_LENGTH = 5000;

/** The text of a note before its first reference-list heading. */
function beforeReferences(text: string): string {
	const heading = /^#{1,6}\s+(.*)$/gm;
	let match: RegExpExecArray | null;
	while ((match = heading.exec(text)) !== null) {
		if (isReferenceHeading(match[1] ?? '')) return text.slice(0, match.index);
	}
	return text;
}

type Located = { path: string; entry: BibEntry };

/**
 * An index of the citation links of the vault, kept up to date as notes change.
 *
 * Obsidian does not index obsidian:// links (on purpose: they stay out of the
 * graph view and backlinks), so the plugin reads the notes itself. Links are
 * stored as written and resolved when queried, so a link to a DOI starts
 * pointing to a note as soon as a note with that DOI is added.
 */
export class CitationIndex extends Events {
	/** Citation links of each note that has some, by path. */
	private readonly linksByPath = new Map<string, CitationLink[]>();
	/** Notes of the vault by DOI (from the DOI property, else the first doi.org URL). */
	private readonly fileByDoi = new Map<string, string>();
	private readonly doiByPath = new Map<string, string>();
	/** Reference-list entries of each literature note, by path. */
	private readonly bibByPath = new Map<string, BibEntry[]>();
	/** Reference-list entries by "first author|year" and by DOI, to find who cites a work. */
	private readonly bibByKey = new Map<string, Located[]>();
	private readonly bibByDoi = new Map<string, Located[]>();
	/** Literature notes by "first author|year" of their own work. */
	private readonly worksByKey = new Map<string, Set<string>>();
	private readonly workKeyByPath = new Map<string, string>();

	constructor(
		private readonly app: App,
		private readonly settings: () => LiteratureGraphSettings,
	) {
		super();
	}

	/** Whether a note is in the literature folder (every note when the setting is empty). */
	isLiterature(file: TFile): boolean {
		const folder = this.settings().literatureFolder.replace(/\/+$/, '');
		return folder === '' || file.path.startsWith(`${folder}/`);
	}

	/** What the properties of a note say about its work (authors, year, title, DOI). */
	vaultWork(file: TFile): VaultWork | null {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) return null;
		const read = (key: string): string => {
			const value: unknown = fm[key];
			return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
		};
		const s = this.settings();
		const authors = read(s.authorsProperty)
			.split(/\s*[,;]\s*/)
			.filter((p) => p !== '' && !/^(\p{Lu}\.?[\s.-]*)+$/u.test(p))
			.map(nameKey)
			.filter(Boolean);
		return {
			authors,
			year: read(s.yearProperty),
			title: read(s.titleProperty),
			doi: this.doiByPath.get(file.path) ?? null,
			otherTitles: parseFrontMatterAliases(fm) ?? [],
		};
	}

	/** Reads every Markdown note. */
	async build(): Promise<void> {
		this.linksByPath.clear();
		this.fileByDoi.clear();
		this.doiByPath.clear();
		this.bibByPath.clear();
		this.bibByKey.clear();
		this.bibByDoi.clear();
		this.worksByKey.clear();
		this.workKeyByPath.clear();
		this.descriptions.clear();
		for (const file of this.app.vault.getMarkdownFiles()) await this.indexFile(file, false);
		this.trigger('changed');
	}

	/**
	 * Re-reads one note. Triggers "changed" when what the note cites, its DOI,
	 * its reference list or the description of its work changed (the graph
	 * depends on these), and "moved" when only the lines of its citation links
	 * moved (the panel shows them); typing elsewhere triggers nothing.
	 */
	async indexFile(file: TFile, notify = true): Promise<void> {
		const text = await this.app.vault.cachedRead(file);
		const before = this.signature(file.path);
		const beforeLines = this.linesOf(file.path);
		const links = text.includes(CITE_URL_PREFIX) ? citationLinksIn(text) : [];
		if (links.length > 0) this.linksByPath.set(file.path, links);
		else this.linksByPath.delete(file.path);
		this.setDoi(file.path, this.doiOf(file, text));
		const literature = this.isLiterature(file);
		this.setBibliography(file.path, literature ? bibliographyEntries(text) : []);
		this.setWorkKey(file.path, literature ? this.workKey(file) : null);
		this.descriptions.set(file.path, this.describe(file));
		if (!notify) return;
		if (this.signature(file.path) !== before) this.trigger('changed');
		else if (this.linesOf(file.path) !== beforeLines) this.trigger('moved');
	}

	/** Properties that describe a note's work (they change labels and matches). */
	private readonly descriptions = new Map<string, string>();

	private describe(file: TFile): string {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const s = this.settings();
		return [s.citationTextProperty, s.authorsProperty, s.yearProperty, s.titleProperty, 'aliases']
			.map((key) => JSON.stringify(fm[key] ?? null))
			.join('|');
	}

	/** Everything about a note that other notes or the graph depend on. */
	private signature(path: string): string {
		return [
			(this.linksByPath.get(path) ?? []).map((l) => `${l.text}\u0000${l.url}`).join('\u0001'),
			this.doiByPath.get(path) ?? '',
			(this.bibByPath.get(path) ?? []).map((e) => e.text).join('\u0001'),
			this.workKeyByPath.get(path) ?? '',
			this.descriptions.get(path) ?? '',
		].join('\u0002');
	}

	private linesOf(path: string): string {
		return [
			...(this.linksByPath.get(path) ?? []).map((l) => l.line),
			...(this.bibByPath.get(path) ?? []).map((e) => e.line),
		].join(',');
	}

	/** Forgets a deleted note. */
	removeFile(path: string): void {
		this.linksByPath.delete(path);
		this.setDoi(path, null);
		this.setBibliography(path, []);
		this.setWorkKey(path, null);
		this.descriptions.delete(path);
		this.trigger('changed');
	}

	/** Moves the entries of a renamed note (its links are unchanged). */
	renameFile(file: TFile, oldPath: string): void {
		const links = this.linksByPath.get(oldPath);
		this.linksByPath.delete(oldPath);
		if (links) this.linksByPath.set(file.path, links);
		const doi = this.doiByPath.get(oldPath) ?? null;
		this.setDoi(oldPath, null);
		this.setDoi(file.path, doi);
		const literature = this.isLiterature(file);
		const entries = this.bibByPath.get(oldPath) ?? [];
		this.setBibliography(oldPath, []);
		this.setBibliography(file.path, literature ? entries : []);
		this.setWorkKey(oldPath, null);
		this.setWorkKey(file.path, literature ? this.workKey(file) : null);
		const description = this.descriptions.get(oldPath);
		this.descriptions.delete(oldPath);
		if (description !== undefined) this.descriptions.set(file.path, description);
		this.trigger('changed');
	}

	private workKey(file: TFile): string | null {
		const work = this.vaultWork(file);
		return work?.authors[0] && work.year ? `${work.authors[0]}|${work.year}` : null;
	}

	private setWorkKey(path: string, key: string | null): void {
		const old = this.workKeyByPath.get(path);
		if (old) this.worksByKey.get(old)?.delete(path);
		if (!key) {
			this.workKeyByPath.delete(path);
			return;
		}
		this.workKeyByPath.set(path, key);
		this.worksByKey.set(key, (this.worksByKey.get(key) ?? new Set<string>()).add(path));
	}

	private setBibliography(path: string, entries: BibEntry[]): void {
		const remove = (map: Map<string, Located[]>, key: string) => {
			const list = (map.get(key) ?? []).filter((e) => e.path !== path);
			if (list.length > 0) map.set(key, list);
			else map.delete(key);
		};
		for (const old of this.bibByPath.get(path) ?? []) {
			if (old.authors[0] && old.year) remove(this.bibByKey, `${old.authors[0]}|${old.year}`);
			if (old.doi) remove(this.bibByDoi, old.doi);
		}
		if (entries.length === 0) {
			this.bibByPath.delete(path);
			return;
		}
		this.bibByPath.set(path, entries);
		const add = (map: Map<string, Located[]>, key: string, entry: BibEntry) => {
			const list = map.get(key) ?? [];
			list.push({ path, entry });
			map.set(key, list);
		};
		for (const entry of entries) {
			if (entry.authors[0] && entry.year) add(this.bibByKey, `${entry.authors[0]}|${entry.year}`, entry);
			if (entry.doi) add(this.bibByDoi, entry.doi, entry);
		}
	}

	/** The literature note that a reference-list entry designates, if exactly one does. */
	resolveEntry(entry: BibEntry, fromPath: string): TFile | null {
		if (entry.doi) {
			const byDoi = this.fileForDoi(entry.doi);
			if (byDoi) return byDoi.path === fromPath ? null : byDoi;
		}
		if (!entry.authors[0] || !entry.year) return null;
		const matching: TFile[] = [];
		for (const path of this.worksByKey.get(`${entry.authors[0]}|${entry.year}`) ?? []) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (path === fromPath || !(file instanceof TFile)) continue;
			const work = this.vaultWork(file);
			if (work && entryMatches(entry, work)) matching.push(file);
		}
		return matching.length === 1 ? (matching[0] ?? null) : null;
	}

	/** The reference-list entries of a literature note. */
	bibliographyOf(file: TFile): BibEntry[] {
		return this.bibByPath.get(file.path) ?? [];
	}

	/** Literature notes whose reference list cites a note, with the entries. */
	citedInBibliographies(file: TFile): { path: string; entries: BibEntry[] }[] {
		const key = this.workKeyByPath.get(file.path);
		const doi = this.doiByPath.get(file.path);
		const candidates = [...(key ? (this.bibByKey.get(key) ?? []) : []), ...(doi ? (this.bibByDoi.get(doi) ?? []) : [])];
		const byPath = new Map<string, Set<BibEntry>>();
		for (const { path, entry } of candidates) {
			if (path === file.path || this.resolveEntry(entry, path) !== file) continue;
			byPath.set(path, (byPath.get(path) ?? new Set<BibEntry>()).add(entry));
		}
		return [...byPath.entries()].map(([path, entries]) => ({ path, entries: [...entries] }));
	}

	private doiOf(file: TFile, text: string): string | null {
		const value: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.[this.settings().doiProperty];
		if (typeof value === 'string' && value.trim()) return normalizeDoi(value);
		// Without the property, the note's own DOI is the first one near its
		// start, before any reference list (whose DOIs are other works').
		const inText = DOI_IN_TEXT.exec(beforeReferences(text).slice(0, DOI_SEARCH_LENGTH));
		return inText?.[1] ? normalizeDoi(inText[1].replace(/[.,;]+$/, '')) : null;
	}

	private setDoi(path: string, doi: string | null): void {
		const old = this.doiByPath.get(path);
		if (old && this.fileByDoi.get(old) === path) this.fileByDoi.delete(old);
		if (doi) {
			this.doiByPath.set(path, doi);
			if (!this.fileByDoi.has(doi)) this.fileByDoi.set(doi, path);
		} else {
			this.doiByPath.delete(path);
		}
	}

	/** The note of the vault with this DOI, if any. */
	fileForDoi(doi: string): TFile | null {
		const path = this.fileByDoi.get(normalizeDoi(doi));
		const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
		return file instanceof TFile ? file : null;
	}

	/** The DOI of a note, if known. */
	doiForFile(file: TFile): string | null {
		return this.doiByPath.get(file.path) ?? null;
	}

	/** What a citation target points to, resolved now. */
	resolve(target: CitationTarget, text = ''): CitedWork {
		const byNote = target.note ? resolveCitedNote(this.app, target.note) : null;
		if (byNote) return { kind: 'note', file: byNote };
		if (target.doi) {
			const byDoi = this.fileForDoi(target.doi);
			return byDoi ? { kind: 'note', file: byDoi } : { kind: 'doi', doi: normalizeDoi(target.doi) };
		}
		return { kind: 'broken', text: target.note ?? text };
	}

	/** Citation links of a note. */
	linksFrom(file: TFile): CitationLink[] {
		return this.linksByPath.get(file.path) ?? [];
	}

	/** Every note with citation links, with its links. */
	allLinks(): [string, CitationLink[]][] {
		return [...this.linksByPath.entries()];
	}

	/** Notes that cite a note (by its name, path or DOI), with the citing links. */
	citing(file: TFile): { path: string; links: CitationLink[] }[] {
		const result: { path: string; links: CitationLink[] }[] = [];
		for (const [path, links] of this.linksByPath) {
			const matching = links.filter((l) => {
				const work = this.resolve(l.target, l.text);
				return work.kind === 'note' && work.file === file;
			});
			if (matching.length > 0) result.push({ path, links: matching });
		}
		return result;
	}

	/** Paths of notes whose links name `oldPath` (by name or path) or a file under a renamed folder. */
	linksNaming(renamed: TAbstractFile, oldPath: string): { path: string; links: CitationLink[] }[] {
		const oldNoPath = oldPath.replace(/\.md$/, '');
		const oldName = oldNoPath.split('/').pop() ?? oldNoPath;
		const names = (note: string) => {
			const n = note.replace(/\.md$/, '');
			if (renamed instanceof TFolder) return n.startsWith(`${oldPath}/`);
			return n === oldNoPath || n === oldName;
		};
		const result: { path: string; links: CitationLink[] }[] = [];
		for (const [path, links] of this.linksByPath) {
			const matching = links.filter((l) => l.target.note !== undefined && names(l.target.note));
			if (matching.length > 0) result.push({ path, links: matching });
		}
		return result;
	}
}
