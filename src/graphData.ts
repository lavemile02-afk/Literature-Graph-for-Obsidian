import { App, TFile } from 'obsidian';
import { citationText } from './citationText';
import type { CitationIndex } from './citationIndex';
import { BibEntry, entryKey, entryTitle, MIN_TITLE_OVERLAP, nameKey, titleOverlap } from './bibliography';
import { OpenAlexClient, surnameOf, WorkSummary, workCitation } from './openalex';
import type { LiteratureGraphSettings } from './settings';

/** Where a citation between two works was found. */
export type EdgeSource = 'link' | 'bibliography' | 'openalex';

/**
 * A work of the graph. Generation 0: a note of the literature folder;
 * generation 1: a work outside the vault cited by notes of the vault;
 * generation 2: a work cited by generation-1 works.
 */
export interface GraphNode {
	/** The note's path, or "W…" (OpenAlex id), or "doi:…". */
	id: string;
	generation: 0 | 1 | 2;
	file: TFile | null;
	doi: string | null;
	openAlexId: string | null;
	/** Short label, such as "Bourgeois et al., 2016". */
	label: string;
	title: string;
	/** Number of works of the graph that cite this one. */
	citedBy: number;
	/** For a work known only from a reference list: the entry as written, and its year. */
	entry?: { text: string; year: string };
}

export interface GraphEdge {
	/** Id of the citing work. */
	source: string;
	/** Id of the cited work. */
	target: string;
	sources: Set<EdgeSource>;
}

export interface LiteratureGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
	/** Works left out because of the node limit. */
	leftOut: number;
}

export interface GraphOptions {
	/** 0, 1 or 2. */
	generations: number;
	/** A work outside the vault is shown only if at least this many works of the graph cite it. */
	minCitations: number;
	/** At most this many nodes; the most cited works outside the vault are kept. */
	maxNodes: number;
	/**
	 * Also show the works of the reference lists that have no DOI (known only
	 * from the notes, without OpenAlex). On unless set to false.
	 */
	localWorks?: boolean;
	/**
	 * Also show the notes outside the literature folder that cite works with
	 * citation links, and the notes they cite that way (never through
	 * wikilinks). Off unless true.
	 */
	allNotes?: boolean;
	/** Where citations may come from; a source set to false is left out (all by default). */
	edgeSources?: Partial<Record<EdgeSource, boolean>>;
}

/**
 * "Name et al., 2001" for a reference-list entry, with the names as the
 * entry writes them ("Quinty et Rochefort, 2003" / "Quinty & Rochefort, 2003").
 */
export function entryCitation(entry: BibEntry, language: 'en' | 'fr'): string {
	const first = entry.firstAuthor ?? '?';
	const year = entry.year ?? (language === 'fr' ? 's.d.' : 'n.d.');
	if (entry.etAl || entry.authors.length >= 3) return `${first} et al., ${year}`;
	if (entry.authors.length === 2) {
		// The second name as written, found back from its reduced form.
		const second = entry.text.split(/[\s,;&.()*_]+/).find((t) => t.length > 1 && nameKey(t) === entry.authors[1]);
		if (second) return `${first} ${language === 'fr' ? 'et' : '&'} ${second}, ${year}`;
	}
	return `${first}, ${year}`;
}

/** Two records whose titles share this much (both ways) are taken for the same work. */
const SAME_TITLE = 0.8;

/** Label of a work outside the vault that OpenAlex has not described (yet). */
const UNKNOWN_WORK = 'Unknown work';

/** Progress messages and intermediate graphs, generation by generation. */
export interface GraphProgress {
	onStage: (graph: LiteratureGraph) => void;
	onStatus: (message: string) => void;
}

class GraphBuilder {
	readonly nodes = new Map<string, GraphNode>();
	readonly edges = new Map<string, GraphEdge>();
	leftOut = 0;

	constructor(readonly allowed: (source: EdgeSource) => boolean) {}

	addEdge(from: string, to: string, source: EdgeSource): void {
		if (!this.allowed(source) || from === to || !this.nodes.has(from) || !this.nodes.has(to)) return;
		const key = `${from}\u0000${to}`;
		const edge = this.edges.get(key) ?? { source: from, target: to, sources: new Set<EdgeSource>() };
		edge.sources.add(source);
		this.edges.set(key, edge);
	}

	snapshot(): LiteratureGraph {
		const citedBy = new Map<string, number>();
		for (const edge of this.edges.values()) citedBy.set(edge.target, (citedBy.get(edge.target) ?? 0) + 1);
		for (const node of this.nodes.values()) node.citedBy = citedBy.get(node.id) ?? 0;
		return { nodes: [...this.nodes.values()], edges: [...this.edges.values()], leftOut: this.leftOut };
	}
}

/** Keeps the keys cited at least `min` times, most cited first, at most `limit`. */
function mostCited(counts: Map<string, number>, min: number, limit: number): { kept: string[]; leftOut: number } {
	const eligible = [...counts.entries()].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]);
	const kept = eligible.slice(0, Math.max(0, limit)).map(([k]) => k);
	return { kept, leftOut: eligible.length - kept.length };
}

/**
 * Builds the literature graph, generation by generation (each stage is passed
 * to `progress.onStage` as soon as it is ready).
 */
export async function buildGraph(
	app: App,
	index: CitationIndex,
	openAlex: OpenAlexClient,
	settings: LiteratureGraphSettings,
	options: GraphOptions,
	progress: GraphProgress,
): Promise<LiteratureGraph> {
	const allowed = (source: EdgeSource) => options.edgeSources?.[source] !== false;
	const g = new GraphBuilder(allowed);
	const language = settings.citationLanguage;

	// ----- Generation 0: the notes of the literature folder -----
	const files = app.vault.getMarkdownFiles().filter((f) => index.isLiterature(f));
	// With "all notes": the other notes that cite with citation links, and the
	// other notes they cite that way.
	const others: TFile[] = [];
	if (options.allNotes) {
		const citing = app.vault.getMarkdownFiles().filter((f) => !index.isLiterature(f) && index.linksFrom(f).length > 0);
		const shown = new Set<TFile>(citing);
		for (const file of [...files, ...citing]) {
			for (const link of index.linksFrom(file)) {
				const work = index.resolve(link.target, link.text);
				if (work.kind === 'note' && !index.isLiterature(work.file)) shown.add(work.file);
			}
		}
		others.push(...[...shown].sort((a, b) => a.path.localeCompare(b.path)));
	}
	const allFiles = [...files, ...others];
	for (const file of allFiles) {
		const title: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.[settings.titleProperty];
		g.nodes.set(file.path, {
			id: file.path,
			generation: 0,
			file,
			doi: index.doiForFile(file),
			openAlexId: null,
			label: citationText(app, file, settings),
			title: typeof title === 'string' ? title : file.basename,
			citedBy: 0,
		});
	}
	for (const file of allFiles) {
		for (const link of index.linksFrom(file)) {
			const work = index.resolve(link.target, link.text);
			if (work.kind === 'note') g.addEdge(file.path, work.file.path, 'link');
		}
		for (const entry of index.bibliographyOf(file)) {
			const cited = index.resolveEntry(entry, file.path);
			if (cited) g.addEdge(file.path, cited.path, 'bibliography');
		}
	}

	// OpenAlex ids of the vault's works, and their references.
	const pathById = new Map<string, string>();
	let vaultWorks: WorkSummary[] = [];
	try {
		progress.onStatus('Loading OpenAlex data for the works of the vault…');
		vaultWorks = await openAlex.worksByDois(files.map((f) => index.doiForFile(f)).filter((d): d is string => d !== null));
		for (const work of vaultWorks) {
			const file = work.doi ? index.fileForDoi(work.doi) : null;
			if (file) {
				pathById.set(work.id, file.path);
				const node = g.nodes.get(file.path);
				if (node) node.openAlexId = work.id;
			}
		}
		for (const work of vaultWorks) {
			const from = pathById.get(work.id);
			if (!from) continue;
			for (const ref of work.references) {
				const to = pathById.get(ref);
				if (to) g.addEdge(from, to, 'openalex');
			}
		}
	} catch (error) {
		console.error('Literature Graph: OpenAlex request failed; the graph uses local data only', error);
	}
	progress.onStage(g.snapshot());
	if (options.generations < 1) return g.snapshot();
	if (openAlex.isRateLimited) {
		progress.onStatus('OpenAlex refuses requests for now: works outside the vault come from the cache only');
	}

	// ----- Generation 1: works outside the vault cited by the vault's works -----
	const counts1 = new Map<string, number>();
	/** Cited work → citing work → where the citation was found. */
	const citers1 = new Map<string, Map<string, EdgeSource>>();
	const cite = (
		counts: Map<string, number>,
		citers: Map<string, Map<string, EdgeSource>>,
		from: string,
		to: string,
		source: EdgeSource,
	) => {
		if (!allowed(source)) return;
		const map = citers.get(to) ?? new Map<string, EdgeSource>();
		if (map.has(from)) return;
		map.set(from, source);
		citers.set(to, map);
		counts.set(to, (counts.get(to) ?? 0) + 1);
	};
	for (const work of vaultWorks) {
		const from = pathById.get(work.id);
		if (!from) continue;
		for (const ref of work.references) if (!pathById.has(ref)) cite(counts1, citers1, from, ref, 'openalex');
	}
	// Works cited by DOI (citation links and reference lists) that are not notes
	// of the vault. Their DOIs are looked up on OpenAlex first, so that a work
	// found both ways is one node.
	const citedDois = new Map<string, { doi: string; source: EdgeSource }[]>();
	for (const file of allFiles) {
		citedDois.set(file.path, [
			...index
				.linksFrom(file)
				.map((l) => index.resolve(l.target, l.text))
				.flatMap((w) => (w.kind === 'doi' ? [{ doi: w.doi, source: 'link' as const }] : [])),
			...index
				.bibliographyOf(file)
				.flatMap((e) => (e.doi && !index.resolveEntry(e, file.path) ? [{ doi: e.doi, source: 'bibliography' as const }] : [])),
		].filter((c) => allowed(c.source)));
	}
	try {
		const all = [...new Set([...citedDois.values()].flat().map((c) => c.doi))];
		await openAlex.worksByDois(all, (done, total) =>
			progress.onStatus(`Looking up the DOIs of reference lists: ${done} of ${total}…`),
		);
	} catch (error) {
		console.error('Literature Graph: OpenAlex request failed', error);
	}
	for (const file of allFiles) {
		for (const { doi, source } of citedDois.get(file.path) ?? []) {
			const id = openAlex.cachedIdForDoi(doi);
			const key = id ?? `doi:${doi}`;
			if (!pathById.has(key)) cite(counts1, citers1, file.path, key, source);
		}
	}
	// Works of the reference lists without a DOI, known only from the notes
	// (no request). One work cited by several notes is one node; when OpenAlex
	// already knows it (cited elsewhere with its DOI), it joins that node.
	const localWorks = new Map<string, BibEntry>();
	if (options.localWorks !== false && allowed('bibliography')) {
		// Works OpenAlex knows, by first author and year, to recognize an entry
		// without DOI by its title (as the vault's notes are).
		const known = new Map<string, { id: string; title: string }[]>();
		for (const id of counts1.keys()) {
			const work = openAlex.cachedWork(id);
			const first = work?.authors[0];
			if (!work || !first || !work.year) continue;
			const key = `${nameKey(surnameOf(first))}|${work.year}`;
			known.set(key, [...(known.get(key) ?? []), { id, title: work.title }]);
		}
		const openAlexWork = (entry: BibEntry): string | null => {
			const candidates = (known.get(`${entry.authors[0] ?? ''}|${entry.year ?? ''}`) ?? []).filter(
				(c) => titleOverlap(c.title, entry.text) >= MIN_TITLE_OVERLAP,
			);
			const first = candidates[0];
			if (!first) return null;
			// OpenAlex often has several records of one work (an article and its
			// preprint...): with the same title they are one work, and the most
			// cited record stands for it. Different titles stay ambiguous.
			const sameWork = candidates.every(
				(c) => titleOverlap(c.title, first.title) >= SAME_TITLE && titleOverlap(first.title, c.title) >= SAME_TITLE,
			);
			if (!sameWork) return null;
			return candidates.reduce((a, b) => ((counts1.get(b.id) ?? 0) > (counts1.get(a.id) ?? 0) ? b : a)).id;
		};
		for (const file of files) {
			for (const entry of index.bibliographyOf(file)) {
				if (entry.doi || index.resolveEntry(entry, file.path)) continue;
				const key = entryKey(entry);
				if (!key) continue;
				const id = openAlexWork(entry);
				const target = id ?? `ref:${key}`;
				if (!id && !localWorks.has(target)) localWorks.set(target, entry);
				cite(counts1, citers1, file.path, target, 'bibliography');
			}
		}
	}
	// With two generations, generation 1 gets half of the remaining nodes.
	const remaining = options.maxNodes - g.nodes.size;
	const budget1 = options.generations >= 2 ? Math.floor(remaining / 2) : remaining;
	const gen1 = mostCited(counts1, options.minCitations, budget1);
	g.leftOut += gen1.leftOut;

	const ids1 = gen1.kept.filter((k) => !k.startsWith('doi:') && !k.startsWith('ref:'));
	let works1: WorkSummary[] = [];
	try {
		works1 = await openAlex.worksByIds(ids1, (done, total) =>
			progress.onStatus(`Loading works outside the vault (generation 1): ${done} of ${total}…`),
		);
	} catch (error) {
		console.error('Literature Graph: OpenAlex request failed', error);
	}
	const byId1 = new Map(works1.map((w) => [w.id, w]));
	for (const key of gen1.kept) {
		const local = localWorks.get(key);
		if (local) {
			g.nodes.set(key, {
				id: key,
				generation: 1,
				file: null,
				doi: null,
				openAlexId: null,
				label: entryCitation(local, language),
				title: entryTitle(local),
				citedBy: 0,
				entry: { text: local.text, year: local.year ?? '' },
			});
			for (const [from, source] of citers1.get(key) ?? []) g.addEdge(from, key, source);
			continue;
		}
		// A work OpenAlex no longer has (merged or deleted): nothing to show or open.
		if (openAlex.isMissing(key)) continue;
		const work = byId1.get(key) ?? openAlex.cachedWork(key);
		const doi = key.startsWith('doi:') ? key.slice(4) : (work?.doi ?? null);
		g.nodes.set(key, {
			id: key,
			generation: 1,
			file: null,
			doi,
			openAlexId: work?.id ?? (key.startsWith('doi:') ? null : key),
			// Not fetched from OpenAlex (yet): its DOI, rather than an opaque id.
			label: work ? workCitation(work, language) : (doi ?? UNKNOWN_WORK),
			title: work?.title ?? '',
			citedBy: 0,
		});
		for (const [from, source] of citers1.get(key) ?? []) g.addEdge(from, key, source);
	}
	progress.onStage(g.snapshot());
	if (options.generations < 2) return g.snapshot();

	// ----- Generation 2: works cited by generation-1 works -----
	const counts2 = new Map<string, number>();
	const citers2 = new Map<string, Map<string, EdgeSource>>();
	for (const work of works1) {
		for (const ref of work.references) {
			const known = pathById.get(ref) ?? (g.nodes.has(ref) ? ref : null);
			if (known) g.addEdge(work.id, known, 'openalex');
			else cite(counts2, citers2, work.id, ref, 'openalex');
		}
	}
	const budget2 = options.maxNodes - g.nodes.size;
	const gen2 = mostCited(counts2, options.minCitations, budget2);
	g.leftOut += gen2.leftOut;
	let works2: WorkSummary[] = [];
	try {
		works2 = await openAlex.worksByIds(gen2.kept, (done, total) =>
			progress.onStatus(`Loading works outside the vault (generation 2): ${done} of ${total}…`),
		);
	} catch (error) {
		console.error('Literature Graph: OpenAlex request failed', error);
	}
	const byId2 = new Map(works2.map((w) => [w.id, w]));
	for (const key of gen2.kept) {
		if (openAlex.isMissing(key)) continue;
		const work = byId2.get(key);
		g.nodes.set(key, {
			id: key,
			generation: 2,
			file: null,
			doi: work?.doi ?? null,
			openAlexId: key,
			label: work ? workCitation(work, language) : UNKNOWN_WORK,
			title: work?.title ?? '',
			citedBy: 0,
		});
		for (const [from, source] of citers2.get(key) ?? []) g.addEdge(from, key, source);
	}
	const graph = g.snapshot();
	progress.onStage(graph);
	return graph;
}
