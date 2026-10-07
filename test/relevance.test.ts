import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphEdge, GraphNode, LiteratureGraph } from '../src/graphData';
import { explainSuggestion, rankCitingWorks, rankSuggestions, WorkInfo } from '../src/relevance';

const node = (id: string, depth: 0 | 1, openAlexId: string | null = null): GraphNode => ({
	id,
	depth,
	file: null,
	doi: null,
	openAlexId,
	label: id,
	title: '',
	citedBy: 0,
});
const edge = (source: string, target: string): GraphEdge => ({ source, target, sources: new Set(['openalex']) });

// Three works of the vault; A cites X, Y and Z, B cites X and Y, C cites X;
// W (outside) cites the vault's work A and is cited by no one.
const graph: LiteratureGraph = {
	nodes: [node('A', 0, 'WA'), node('B', 0, 'WB'), node('C', 0, 'WC'), node('X', 1), node('Y', 1), node('Z', 1), node('W', 1), node('V', 1)],
	edges: [edge('A', 'X'), edge('B', 'X'), edge('C', 'X'), edge('A', 'Y'), edge('B', 'Y'), edge('A', 'Z'), edge('A', 'B'), edge('X', 'V'), edge('Y', 'V')],
	leftOut: 0,
};
const infos: Record<string, WorkInfo> = {
	W: { year: 2024, citedByCount: 3, references: ['WA', 'WB', 'W999'] },
	Z: { year: 1990, citedByCount: 5000, references: [] },
};

test('ranks first the works most cited by the vault', () => {
	const ranked = rankSuggestions(graph, (n) => infos[n.id] ?? null, 2026);
	assert.deepEqual(
		ranked.map((s) => s.node.id),
		['X', 'Y', 'Z', 'W', 'V'],
	);
	// Only works outside the vault are suggested.
	assert.ok(ranked.every((s) => s.node.depth !== 0));
});

test('counts each signal of a suggestion', () => {
	const ranked = rankSuggestions(graph, (n) => infos[n.id] ?? null, 2026);
	const by = new Map(ranked.map((s) => [s.node.id, s]));
	assert.equal(by.get('X')?.vaultCiters.length, 3);
	// Z is cited by A, which also cites the "core" works X and Y (cited twice or more).
	assert.equal(by.get('Z')?.coCited, 2);
	// W cites two works of the vault, found in its OpenAlex references.
	assert.deepEqual(by.get('W')?.citesVault.map((n) => n.id).sort(), ['A', 'B']);
	assert.equal(by.get('V')?.outsideCiters, 2);
	assert.equal(by.get('W')?.year, 2024);
});

test('explains a suggestion in words', () => {
	const ranked = rankSuggestions(graph, (n) => infos[n.id] ?? null, 2026);
	const z = ranked.find((s) => s.node.id === 'Z');
	assert.ok(z);
	assert.deepEqual(explainSuggestion(z), [
		'Cited by 1 work of your vault: A',
		'Cited along with 2 of the 2 works your vault cites most (cited by several of its works)',
		'Published in 1990',
		'Cited 5000 times in all (OpenAlex)',
	]);
});

test('ranks first the works citing the most works of the vault', () => {
	const [a, b, c] = [node('A', 0, 'WA'), node('B', 0, 'WB'), node('C', 0, 'WC')];
	const ranked = rankCitingWorks(
		[
			{ node: node('W1', 1, 'W1'), cites: [a], year: 2025, citedByCount: 900 },
			{ node: node('W2', 1, 'W2'), cites: [a, b, c], year: 1999, citedByCount: 0 },
			{ node: node('W3', 1, 'W3'), cites: [a, b], year: null, citedByCount: null },
			{ node: node('W4', 1, 'W4'), cites: [b], year: 2026, citedByCount: 0 },
		],
		2026,
	);
	assert.deepEqual(
		ranked.map((s) => s.node.id),
		['W2', 'W3', 'W1', 'W4'],
	);
	// One work of the vault cited weighs more than recency and citations together.
	assert.ok((ranked[0]?.score ?? 0) >= 3 && (ranked[2]?.score ?? 0) < 2);
	assert.match(explainSuggestion(ranked[0] ?? ranked[1]!).join('\n'), /Cites 3 works of your vault: A; B; C/);
});
