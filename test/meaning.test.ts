import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lsa, planeOf, similarity, tfidf, tokenize } from '../src/meaning';

test('keeps the words that say something, without accents or plurals', () => {
	assert.deepEqual(tokenize('Les tourbières et la nappe phréatique des sphaignes'), ['tourbiere', 'nappe', 'phreatique', 'sphaigne']);
	assert.deepEqual(tokenize('The water table of the bogs, and its moss'), ['water', 'table', 'bog', 'moss']);
});

test('weighs rare shared words and leaves out words everyone or no one uses', () => {
	const docs = [['peat', 'water', 'peat'], ['peat', 'moss'], ['water', 'moss'], ['unique']];
	const { vectors, terms } = tfidf(docs, { minDocuments: 2, maxShare: 1 });
	assert.equal(terms, 3);
	for (const v of vectors.slice(0, 3)) assert.ok(Math.abs(v.weights.reduce((s, w) => s + w * w, 0) - 1) < 1e-9);
	assert.equal(vectors[3]?.terms.length, 0);
});

const peat = (i: number) => `peat bog water table sphagnum moss hydrology drainage restoration ${i % 2 ? 'rewetting' : 'ditch'} peatland`;
const mind = (i: number) => `cognition memory attention learning behaviour perception brain ${i % 2 ? 'children' : 'adults'} psychology`;

test('gives close vectors to texts on one subject, distant ones across subjects', async () => {
	const docs = [...Array.from({ length: 6 }, (_, i) => tokenize(peat(i))), ...Array.from({ length: 6 }, (_, i) => tokenize(mind(i)))];
	const { vectors, terms } = tfidf(docs, { maxShare: 0.9 });
	const meaning = await lsa(vectors, terms, 8);
	const [a, b, c] = [meaning[0], meaning[1], meaning[7]];
	assert.ok(a && b && c);
	assert.ok(similarity(a, b) > 0.6, `same subject ${similarity(a, b)}`);
	assert.ok(similarity(a, b) - similarity(a, c) > 0.5, `same ${similarity(a, b)}, other ${similarity(a, c)}`);
	// The same corpus gives the same vectors.
	const again = await lsa(vectors, terms, 8);
	assert.ok(Math.abs(similarity(a, again[0]!) - 1) < 1e-6);
});

test('lays the vectors in a plane where the subjects are apart', async () => {
	const docs = [...Array.from({ length: 6 }, (_, i) => tokenize(peat(i))), ...Array.from({ length: 6 }, (_, i) => tokenize(mind(i))), []];
	const { vectors, terms } = tfidf(docs, { maxShare: 0.9 });
	const places = planeOf(await lsa(vectors, terms, 8));
	assert.equal(places[12], null);
	const d = (i: number, j: number) => Math.hypot(places[i]![0] - places[j]![0], places[i]![1] - places[j]![1]);
	assert.ok(d(0, 1) < d(0, 7), `${d(0, 1)} < ${d(0, 7)}`);
});
