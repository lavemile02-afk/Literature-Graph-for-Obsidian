import { App, normalizePath } from 'obsidian';
import type { CitationIndex } from './citationIndex';
import { buildGraph } from './graphData';
import type { OpenAlexClient } from './openalex';
import { cachedInfo, explainSuggestion, rankSuggestions, Suggestion } from './relevance';
import type { LiteratureGraphSettings } from './settings';

/**
 * The reading suggestions written to a file that programs, such as AI agents,
 * can read: JSON Lines, a first line describing the file (`_meta`), then one
 * work outside the vault per line, most relevant first.
 */

export const SUGGESTIONS_SCHEMA_VERSION = 1;

/**
 * Works written, at most: the most relevant. The whole ranking of a large
 * vault (tens of thousands of works, over 10 MB) would weigh on a vault
 * synchronized or kept in git, while the first ones are the useful ones.
 */
export const MAX_SUGGESTIONS_WRITTEN = 1000;

const SCHEMA_DOC: Record<string, string> = {
	rank: 'Position in the list, 1 for the most relevant work.',
	score: 'Relevance score: 1 per work of the vault citing it, plus smaller amounts for the other signals (see "why").',
	label: 'In-text citation, such as "Smith et al., 2020".',
	title: 'Title of the work (as OpenAlex gives it, or read from a reference list).',
	authors: 'Author names as OpenAlex gives them; empty when the work is known only from a reference list.',
	year: 'Year of publication, or null.',
	doi: 'DOI (without https://doi.org/), or null.',
	openalex_id: 'OpenAlex id (such as "W2741809807"), or null for a work known only from a reference list.',
	reference: 'For a work known only from a reference list (no DOI): the entry as written in the citing note; otherwise null.',
	cited_by_vault: 'Paths of the notes of the vault that cite the work.',
	cites_vault: 'Paths of the notes of the vault that the work cites.',
	co_cited: 'Number of works of the core of the vault (works cited by several of its notes) cited along with this one by a note of the vault.',
	core_size: 'Number of works in the core of the vault, this one excepted.',
	cited_by_count: 'Number of works citing it in all, according to OpenAlex, or null.',
	why: 'The reasons for its score, in words.',
};

function record(s: Suggestion, rank: number, openAlex: OpenAlexClient): Record<string, unknown> {
	const n = s.node;
	const work = n.openAlexId ? openAlex.cachedWork(n.openAlexId) : null;
	const path = (node: { id: string }) => node.id;
	return {
		rank,
		score: s.score,
		label: n.label,
		title: n.title || null,
		authors: work?.authors ?? [],
		year: s.year,
		doi: n.doi,
		openalex_id: n.openAlexId,
		reference: n.entry?.text ?? null,
		cited_by_vault: s.vaultCiters.map(path),
		cites_vault: s.citesVault.map(path),
		co_cited: s.coCited,
		core_size: s.coreSize,
		cited_by_count: s.citedByCount,
		why: explainSuggestion(s, false),
	};
}

/**
 * Builds the graph of the vault's works and the works they cite (generation
 * 1, without node limit), ranks the works outside the vault, and writes the
 * most relevant to `path` (a path in the vault). Returns how many were written.
 */
export async function writeSuggestionsFile(
	app: App,
	index: CitationIndex,
	openAlex: OpenAlexClient,
	settings: LiteratureGraphSettings,
	path: string,
	onStatus: (message: string) => void,
): Promise<number> {
	const graph = await buildGraph(
		app,
		index,
		openAlex,
		settings,
		{ generations: 1, minCitations: 1, maxNodes: Infinity, localWorks: true },
		{ onStage: () => {}, onStatus },
	);
	const ranked = rankSuggestions(graph, cachedInfo(openAlex));
	const meta = {
		_meta: true,
		schema_version: SUGGESTIONS_SCHEMA_VERSION,
		generated_at: new Date().toISOString(),
		generator: 'Literature Graph (Obsidian plugin), command "Export reading suggestions"',
		literature_folder: settings.literatureFolder,
		vault_works: graph.nodes.filter((n) => n.generation === 0).length,
		works_ranked: ranked.length,
		works_written: Math.min(ranked.length, MAX_SUGGESTIONS_WRITTEN),
		openalex_limited: openAlex.isRateLimited,
		schema_doc: SCHEMA_DOC,
	};
	const written = ranked.slice(0, MAX_SUGGESTIONS_WRITTEN);
	const lines = [JSON.stringify(meta), ...written.map((s, i) => JSON.stringify(record(s, i + 1, openAlex)))];
	const target = normalizePath(path);
	const folder = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
	if (folder && !(await app.vault.adapter.exists(folder))) await app.vault.adapter.mkdir(folder);
	await app.vault.adapter.write(target, `${lines.join('\n')}\n`);
	return written.length;
}
