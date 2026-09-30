import type { GraphNode } from './graphData';

/** Lowercase, without accents, for comparing typed text with labels and titles. */
function fold(text: string): string {
	return text
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase();
}

/**
 * The works of a graph matching typed text (authors, year, words of the
 * title, in any order): every word typed must be found in the work's label
 * or title. Works whose label starts with the text come first, then the works
 * of the vault, then the most cited.
 */
export function searchWorks(query: string, nodes: GraphNode[], limit = 30): GraphNode[] {
	const words = fold(query).split(/[\s,;]+/).filter(Boolean);
	if (words.length === 0) return [];
	const start = fold(query.trim());
	const found = nodes
		.map((node) => ({ node, label: fold(node.label), text: fold(`${node.label} ${node.title}`) }))
		.filter((n) => words.every((w) => n.text.includes(w)));
	found.sort(
		(a, b) =>
			Number(b.label.startsWith(start)) - Number(a.label.startsWith(start)) ||
			Number(a.node.depth !== 0) - Number(b.node.depth !== 0) ||
			b.node.citedBy - a.node.citedBy ||
			a.node.label.localeCompare(b.node.label),
	);
	return found.slice(0, limit).map((n) => n.node);
}
