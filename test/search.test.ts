import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphNode } from '../src/graphData';
import { searchWorks } from '../src/search';

const node = (label: string, title: string, depth: 0 | 1, citedBy: number): GraphNode => ({
	id: label,
	depth,
	file: null,
	doi: null,
	openAlexId: null,
	label,
	title,
	citedBy,
});

const nodes = [
	node('Price et Schlotzhauer, 1999', 'Importance of shrinkage and compression', 1, 14),
	node('Schlotzhauer et Price, 1999', 'Soil water flow dynamics in a managed cutover peatland', 1, 13),
	node('Price, 2003', 'Rôle et caractère de la déformation', 0, 3),
	node('Clymo, 1984', 'The limits to peat bog growth', 1, 15),
];

test('finds works by author, year and title words, in any order, without accents', () => {
	assert.deepEqual(
		searchWorks('price 1999', nodes).map((n) => n.label),
		['Price et Schlotzhauer, 1999', 'Schlotzhauer et Price, 1999'],
	);
	assert.deepEqual(searchWorks('role deformation', nodes).map((n) => n.label), ['Price, 2003']);
	assert.deepEqual(searchWorks('peat', nodes).map((n) => n.label), ['Clymo, 1984', 'Schlotzhauer et Price, 1999']);
	assert.deepEqual(searchWorks('   ', nodes), []);
});

test('puts first the labels that start with the text, then the works of the vault', () => {
	assert.deepEqual(
		searchWorks('price', nodes).map((n) => n.label),
		['Price, 2003', 'Price et Schlotzhauer, 1999', 'Schlotzhauer et Price, 1999'],
	);
});
