import { App, TFile } from 'obsidian';
import { citationText } from './citationLink';
import type { CitationIndex } from './citationIndex';
import type { OpenAlexClient } from './openalex';
import type { LiteratureGraphSettings } from './settings';

/** Where a citation between two works was found. */
export type EdgeSource = 'link' | 'bibliography' | 'openalex';

export interface GraphNode {
	/** The note's path. */
	id: string;
	file: TFile;
	/** Short label, such as "Bourgeois et al., 2016". */
	label: string;
	title: string;
	/** Number of works of the graph that cite this one. */
	citedBy: number;
}

export interface GraphEdge {
	/** Path of the citing note. */
	source: string;
	/** Path of the cited note. */
	target: string;
	sources: Set<EdgeSource>;
}

export interface LiteratureGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

/**
 * Generation 0: the notes of the literature folder, and the citations between
 * them found in citation links, in their reference lists, and in OpenAlex
 * (the references of each work with a DOI).
 */
export async function buildGeneration0(
	app: App,
	index: CitationIndex,
	openAlex: OpenAlexClient,
	settings: LiteratureGraphSettings,
): Promise<LiteratureGraph> {
	const files = app.vault.getMarkdownFiles().filter((f) => index.isLiterature(f));
	const inGraph = new Set(files.map((f) => f.path));
	const edges = new Map<string, GraphEdge>();
	const addEdge = (from: string, to: string, source: EdgeSource) => {
		if (from === to || !inGraph.has(from) || !inGraph.has(to)) return;
		const key = `${from}\u0000${to}`;
		const edge = edges.get(key) ?? { source: from, target: to, sources: new Set<EdgeSource>() };
		edge.sources.add(source);
		edges.set(key, edge);
	};

	for (const file of files) {
		for (const link of index.linksFrom(file)) {
			const work = index.resolve(link.target, link.text);
			if (work.kind === 'note') addEdge(file.path, work.file.path, 'link');
		}
		for (const entry of index.bibliographyOf(file)) {
			const cited = index.resolveEntry(entry, file.path);
			if (cited) addEdge(file.path, cited.path, 'bibliography');
		}
	}

	// OpenAlex: the works of the vault with a DOI, and which of them each one cites.
	const withDoi = files
		.map((file) => ({ file, doi: index.doiForFile(file) }))
		.filter((x): x is { file: TFile; doi: string } => x.doi !== null);
	try {
		const works = await openAlex.worksByDois(withDoi.map((x) => x.doi));
		const pathById = new Map<string, string>();
		for (const work of works) {
			const file = work.doi ? index.fileForDoi(work.doi) : null;
			if (file) pathById.set(work.id, file.path);
		}
		for (const work of works) {
			const from = pathById.get(work.id);
			if (!from) continue;
			for (const ref of work.references) {
				const to = pathById.get(ref);
				if (to) addEdge(from, to, 'openalex');
			}
		}
	} catch (error) {
		console.error('Literature Graph.md: OpenAlex request failed; the graph uses local data only', error);
	}

	const citedBy = new Map<string, number>();
	for (const edge of edges.values()) citedBy.set(edge.target, (citedBy.get(edge.target) ?? 0) + 1);
	const nodes = files.map((file) => {
		const title: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.[settings.titleProperty];
		return {
			id: file.path,
			file,
			label: citationText(app, file, settings),
			title: typeof title === 'string' ? title : file.basename,
			citedBy: citedBy.get(file.path) ?? 0,
		};
	});
	return { nodes, edges: [...edges.values()] };
}
