import type { GraphNode, LiteratureGraph } from './graphData';
import type { OpenAlexClient } from './openalex';

/**
 * Reading suggestions: the works outside the vault, ranked by how likely they
 * are to matter to the literature of the vault. The score is meant to be read
 * and explained, so it is a plain sum of a few signals, the first one weighing
 * most: how many works of the vault cite the work.
 */

/** What is known of a work beyond the graph (from the OpenAlex cache). */
export interface WorkInfo {
	year: number | null;
	/** Number of works citing it in all, according to OpenAlex. */
	citedByCount: number | null;
	/** OpenAlex ids of the works it cites. */
	references: string[];
}

export interface Suggestion {
	node: GraphNode;
	score: number;
	/** Works of the vault that cite it. */
	vaultCiters: GraphNode[];
	/** Works of the vault that it cites. */
	citesVault: GraphNode[];
	/** Works outside the vault, in the graph, that cite it. */
	outsideCiters: number;
	/** Works of the vault's core (cited by several works of the vault) cited along with it by a work of the vault. */
	coCited: number;
	/** Number of works in the vault's core, itself excepted. */
	coreSize: number;
	year: number | null;
	citedByCount: number | null;
}

/** Weights of the signals; a work of the vault citing the work counts 1. */
export const WEIGHTS = {
	citesVault: 0.5,
	/** Each work outside the vault citing it; at most OUTSIDE_MAX in all. */
	outsideCiter: 0.1,
	outsideMax: 1,
	/** Co-citation: this much when cited along with every work of the vault's core. */
	coCitation: 0.5,
	/** Recency: 0 for works RECENT_YEARS old or more, full for this year's. */
	recency: 0.2,
	recentYears: 30,
	/** Citations in all, on a log scale: full at 10 000. */
	citations: 0.2,
} as const;

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Ranks the works outside the vault of a graph, best first. `info` gives
 * what is known of a work beyond the graph (null when nothing is).
 */
export function rankSuggestions(
	graph: LiteratureGraph,
	info: (node: GraphNode) => WorkInfo | null,
	thisYear = new Date().getFullYear(),
): Suggestion[] {
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const vaultByOpenAlexId = new Map<string, GraphNode>();
	for (const n of graph.nodes) if (n.depth === 0 && n.openAlexId) vaultByOpenAlexId.set(n.openAlexId, n);

	const vaultCiters = new Map<string, Set<GraphNode>>();
	const citesVault = new Map<string, Set<GraphNode>>();
	const outsideCiters = new Map<string, number>();
	const add = (map: Map<string, Set<GraphNode>>, key: string, node: GraphNode) => {
		const set = map.get(key) ?? new Set<GraphNode>();
		set.add(node);
		map.set(key, set);
	};
	for (const edge of graph.edges) {
		const from = byId.get(edge.source);
		const to = byId.get(edge.target);
		if (!from || !to || (to.depth === 0 && from.depth === 0)) continue;
		if (to.depth !== 0 && from.depth === 0) add(vaultCiters, to.id, from);
		else if (to.depth !== 0) outsideCiters.set(to.id, (outsideCiters.get(to.id) ?? 0) + 1);
		else add(citesVault, from.id, to);
	}
	const outside = graph.nodes.filter((n) => n.depth !== 0);
	const infos = new Map(outside.map((n) => [n.id, info(n)]));
	// The references of a work outside the vault may name works of the vault
	// that the graph does not link to it (depth 2 not loaded).
	for (const n of outside) {
		for (const ref of infos.get(n.id)?.references ?? []) {
			const cited = vaultByOpenAlexId.get(ref);
			if (cited) add(citesVault, n.id, cited);
		}
	}

	// Co-citation: the works cited by several works of the vault (its "core"),
	// cited along with the work by at least one work of the vault.
	const coreByCiter = new Map<GraphNode, string[]>();
	const core = new Set<string>();
	for (const [id, citers] of vaultCiters) {
		if (citers.size < 2) continue;
		core.add(id);
		for (const citer of citers) coreByCiter.set(citer, [...(coreByCiter.get(citer) ?? []), id]);
	}

	const suggestions = outside.map((node): Suggestion => {
		const citers = [...(vaultCiters.get(node.id) ?? [])];
		const coCited = new Set<string>();
		for (const citer of citers) for (const id of coreByCiter.get(citer) ?? []) if (id !== node.id) coCited.add(id);
		const known = infos.get(node.id) ?? null;
		const year = known?.year ?? (node.entry?.year ? Number.parseInt(node.entry.year, 10) || null : null);
		const cites = [...(citesVault.get(node.id) ?? [])];
		const others = outsideCiters.get(node.id) ?? 0;
		const age = year === null ? null : thisYear - year;
		const coreSize = core.size - (core.has(node.id) ? 1 : 0);
		const score =
			citers.length +
			WEIGHTS.citesVault * cites.length +
			Math.min(WEIGHTS.outsideMax, WEIGHTS.outsideCiter * others) +
			(coreSize > 0 ? (WEIGHTS.coCitation * coCited.size) / coreSize : 0) +
			(age === null ? 0 : WEIGHTS.recency * Math.min(1, Math.max(0, 1 - age / WEIGHTS.recentYears))) +
			WEIGHTS.citations * Math.min(1, Math.log10(1 + (known?.citedByCount ?? 0)) / 4);
		return {
			node,
			score: round(score),
			vaultCiters: citers,
			citesVault: cites,
			outsideCiters: others,
			coCited: coCited.size,
			coreSize,
			year,
			citedByCount: known?.citedByCount ?? null,
		};
	});
	return suggestions.sort((a, b) => b.score - a.score || b.vaultCiters.length - a.vaultCiters.length || a.node.label.localeCompare(b.node.label));
}

/**
 * Why a work is suggested, one reason per line, strongest first; with the
 * labels of the works of the vault it is linked to, unless `names` is false.
 */
export function explainSuggestion(s: Suggestion, names = true): string[] {
	const list = (nodes: GraphNode[]) => {
		if (!names) return '';
		const shown = nodes.slice(0, 5).map((n) => n.label);
		return nodes.length > 5 ? `${shown.join('; ')}… (+${nodes.length - 5})` : shown.join('; ');
	};
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
	const lines: string[] = [];
	const of = (nodes: GraphNode[]) => (names ? `: ${list(nodes)}` : '');
	if (s.vaultCiters.length > 0) lines.push(`Cited by ${plural(s.vaultCiters.length, 'work')} of your vault${of(s.vaultCiters)}`);
	if (s.citesVault.length > 0) lines.push(`Cites ${plural(s.citesVault.length, 'work')} of your vault${of(s.citesVault)}`);
	if (s.outsideCiters > 0) lines.push(`Cited by ${plural(s.outsideCiters, 'other work')} of the graph`);
	if (s.coCited > 0) lines.push(`Cited along with ${s.coCited} of the ${s.coreSize} works your vault cites most (cited by several of its works)`);
	if (s.year !== null) lines.push(`Published in ${s.year}`);
	if (s.citedByCount !== null) lines.push(`Cited ${s.citedByCount} times in all (OpenAlex)`);
	return lines;
}

/** What the OpenAlex cache knows of a work (nothing is requested). */
export function cachedInfo(openAlex: OpenAlexClient): (node: GraphNode) => WorkInfo | null {
	return (node) => {
		const work = node.openAlexId ? openAlex.cachedWork(node.openAlexId) : null;
		return work ? { year: work.year, citedByCount: work.citedByCount, references: work.references } : null;
	};
}
