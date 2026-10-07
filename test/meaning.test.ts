import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ballCenters, fitPlane, groupNames, groupTargets, titleTerms, meaningGroups, lsa, meaningBasis, fingerprint, nearestInPlane, placeIn, planeOf, project, similarity, tfidf, tokenize, vectorize, vocabularyOf } from '../src/meaning';

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

test('finds the nearest works in the plane, the closest first', () => {
	const places: ([number, number] | null)[] = [[0, 0], [0.1, 0], [0.5, 0], [-3, 2], null];
	for (let i = 0; i < 40; i++) places.push([5 + (i % 7) * 0.3, 5 + Math.floor(i / 7) * 0.3]);
	const kin = nearestInPlane(places, 2);
	assert.deepEqual(kin[0]?.map(([j]) => j), [1, 2]);
	assert.ok((kin[0]?.[0]?.[1] ?? 0) > (kin[0]?.[1]?.[1] ?? 0));
	assert.ok((kin[0]?.[0]?.[1] ?? 0) <= 1);
	assert.deepEqual(kin[4], []);
	// A work far from the others still gets its nearest ones.
	assert.equal(kin[3]?.length, 2);
});

test('fingerprints texts: the same text, the same fingerprint', () => {
	assert.equal(fingerprint('peat and water'), fingerprint('peat and water'));
	assert.notEqual(fingerprint('peat and water'), fingerprint('peat and waters'));
	assert.match(fingerprint(''), /^[0-9a-f]{8}$/);
});

test('forms groups of meaning, gives each a ball, and draws works between groups between their balls', () => {
	const places: ([number, number] | null)[] = [];
	for (let i = 0; i < 30; i++) places.push([-1 + (i % 5) * 0.02, (i % 3) * 0.02]);
	for (let i = 0; i < 30; i++) places.push([1 + (i % 5) * 0.02, (i % 3) * 0.02]);
	places.push([0.02, 0.01], null);
	const groups = meaningGroups(places, 2);
	assert.notEqual(groups.group[0], groups.group[30]);
	assert.equal(groups.group[61], -1);
	const { centers, radii } = ballCenters(groups, 10);
	const d = Math.hypot((centers[0]?.[0] ?? 0) - (centers[1]?.[0] ?? 0), (centers[0]?.[1] ?? 0) - (centers[1]?.[1] ?? 0));
	assert.ok(d >= (radii[0] ?? 0) + (radii[1] ?? 0), 'the balls do not overlap');
	const targets = groupTargets(places, groups, centers, 1);
	const ball = (i: number) => centers[groups.group[i] ?? 0] ?? [0, 0];
	// A work of a group goes to its ball.
	assert.ok(Math.hypot((targets[0]?.[0] ?? 0) - ball(0)[0], (targets[0]?.[1] ?? 0) - ball(0)[1]) < d * 0.05);
	// The work midway goes midway.
	const mid = targets[60] ?? [0, 0];
	const middle = [((centers[0]?.[0] ?? 0) + (centers[1]?.[0] ?? 0)) / 2, ((centers[0]?.[1] ?? 0) + (centers[1]?.[1] ?? 0)) / 2];
	assert.ok(Math.hypot(mid[0] - (middle[0] ?? 0), mid[1] - (middle[1] ?? 0)) < d * 0.2, `midway ${JSON.stringify(mid)} vs ${JSON.stringify(middle)}`);
	assert.equal(targets[61], null);
});

test('names each group of meaning by its most typical keyword, never twice', () => {
	const keywords = [
		['Peatland restoration', 'Sphagnum'], ['Peatland restoration', 'Water table'], ['peatland restoration', 'Sphagnum'], ['Sphagnum'],
		['Water table', 'Hydraulic conductivity'], ['Hydraulic conductivity', 'Water table'], ['Hydraulic conductivity'], ['Water table'],
		['Memory'], [],
	];
	const group = [0, 0, 0, 0, 1, 1, 1, 1, 2, -1];
	const names = groupNames(keywords, group, 3, 3);
	assert.equal(names[0], 'Peatland restoration');
	assert.equal(names[1], 'Hydraulic conductivity');
	// Too few works with a keyword: no name.
	assert.equal(names[2], null);
	assert.notEqual(names[0], names[1]);
});

test('takes the words and the pairs of adjacent words of a title', () => {
	assert.deepEqual(titleTerms('Restoration of the cutover peatlands: water table'), ['restoration', 'cutover', 'cutover peatlands', 'peatlands', 'water', 'water table', 'table']);
	assert.deepEqual(titleTerms('Die Moore und der Torf'), ['moore', 'torf']);
});

test('finds the nearest works in the plane, even on a crowded map', () => {
	// Two dense islands far apart, and one work between.
	const places: [number, number][] = [];
	for (let i = 0; i < 2000; i++) places.push([(i % 50) * 0.001, Math.floor(i / 50) * 0.001]);
	for (let i = 0; i < 2000; i++) places.push([100 + (i % 50) * 0.001, Math.floor(i / 50) * 0.001]);
	places.push([50, 0]);
	const near = nearestInPlane(places, 5);
	const dist = (i: number, j: number) => Math.hypot((places[j]?.[0] ?? 0) - (places[i]?.[0] ?? 0), (places[j]?.[1] ?? 0) - (places[i]?.[1] ?? 0));
	// The same distances as comparing every pair.
	for (const i of [0, 777, 2500, 4000]) {
		const brute = places
			.map((_, j) => j)
			.filter((j) => j !== i)
			.map((j) => dist(i, j))
			.sort((a, b) => a - b)
			.slice(0, 5);
		const found = (near[i] ?? []).map(([j]) => dist(i, j));
		assert.equal(found.length, 5);
		found.forEach((d, k) => assert.ok(Math.abs(d - (brute[k] ?? 0)) < 1e-12));
	}
});
