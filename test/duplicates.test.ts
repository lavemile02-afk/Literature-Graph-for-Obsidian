import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VaultWork } from '../src/bibliography';
import { findDuplicates } from '../src/duplicates';

const work = (authors: string[], year: string, title: string, doi: string | null = null): VaultWork => ({ authors, year, title, doi });

test('finds notes of the same work by DOI or by author, year and title', () => {
	const groups = findDuplicates([
		{ path: 'A.md', work: work(['smith'], '2020', 'Peat and water', '10.1/abc') },
		{ path: 'A copy.md', work: work(['smith'], '2020', 'Another title', '10.1/ABC') },
		{ path: 'B.md', work: work(['roy'], '1999', 'Restoration of mined peatlands in Quebec') },
		{ path: 'B (2).md', work: work(['roy'], '1999', 'Restoration of mined peatlands in Quebec.') },
		{ path: 'C.md', work: work(['jones'], '2001', 'Part I: the site') },
		{ path: 'D.md', work: work(['jones'], '2001', 'Part II: the results') },
	]);
	assert.deepEqual(groups, [
		{ paths: ['A copy.md', 'A.md'], reason: 'doi' },
		{ paths: ['B (2).md', 'B.md'], reason: 'title' },
	]);
});

test('never takes two notes with different DOIs for one work', () => {
	const groups = findDuplicates([
		{ path: 'Roy 1.md', work: work(['roy'], '2001', 'Sugar maple stands: soils', '10.1/one') },
		{ path: 'Roy 2.md', work: work(['roy'], '2001', 'Sugar maple stands: soils', '10.1/two') },
	]);
	assert.deepEqual(groups, []);
});

test('keeps apart two parts of one study', () => {
	const title = 'Étude de quatre érablières du Québec en relation avec le milieu pédologique : ';
	const groups = findDuplicates([
		{ path: 'Roy (1).md', work: work(['roy', 'sauvesty'], '2001', `${title}I. Microrelief, fertilité des sols, et dépérissement`) },
		{ path: 'Roy (2).md', work: work(['roy', 'sauvesty'], '2001', `${title}II. Paramètres physiologiques et dépérissement`) },
	]);
	assert.deepEqual(groups, []);
});
