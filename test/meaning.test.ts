import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitPlane, lsa, meaningBasis, nearestNeighbors, placeIn, planeOf, project, similarity, tfidf, tokenize, vectorize, vocabularyOf } from '../src/meaning';

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

test('gives a work the same place whatever other works it is shown with', async () => {
	// Learned from a fixed corpus (the notes of the vault), applied to any work.
	const corpus = [...Array.from({ length: 6 }, (_, i) => tokenize(peat(i))), ...Array.from({ length: 6 }, (_, i) => tokenize(mind(i)))];
	const vocabulary = vocabularyOf(corpus, { maxShare: 0.9 });
	const basis = await meaningBasis(corpus.map((w) => vectorize(w, vocabulary)), vocabulary.idf.length, 8);
	const plane = fitPlane(corpus.map((w) => project(vectorize(w, vocabulary), basis)));
	assert.ok(plane);
	const work = project(vectorize(tokenize('sphagnum peat water table after rewetting'), vocabulary), basis);
	assert.ok(work);
	const alone = placeIn(plane, work);
	// Other works around it change nothing.
	const others = [tokenize('children memory'), tokenize('drainage ditch peat')].map((w) => project(vectorize(w, vocabulary), basis));
	assert.ok(others.every(Boolean));
	assert.deepEqual(placeIn(plane, work), alone);
	// Near the peat notes, far from the others.
	const middle = (from: number): [number, number] => {
		const places = corpus.slice(from, from + 6).map((w) => placeIn(plane, project(vectorize(w, vocabulary), basis)!));
		return [places.reduce((s, p) => s + p[0], 0) / 6, places.reduce((s, p) => s + p[1], 0) / 6];
	};
	const peatPlace = middle(0);
	const mindPlace = middle(6);
	const d = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]);
	assert.ok(d(alone, peatPlace) < d(alone, mindPlace));
});

test('finds the nearest works in meaning, most similar first', async () => {
	const v = (x: number, y: number) => {
		const n = Math.hypot(x, y);
		return Float32Array.from([x / n, y / n]);
	};
	const kin = await nearestNeighbors([v(1, 0), v(1, 0.1), v(1, 0.5), v(-1, 0), null], 2);
	assert.deepEqual(kin[0]?.map(([j]) => j), [1, 2]);
	assert.deepEqual(kin[3], []);
	assert.deepEqual(kin[4], []);
	assert.ok((kin[0]?.[0]?.[1] ?? 0) > (kin[0]?.[1]?.[1] ?? 0));
});
