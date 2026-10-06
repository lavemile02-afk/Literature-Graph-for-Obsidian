import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NamedWork, regionNames } from '../src/regionNames';

const unit = (...xs: number[]) => {
	const n = Math.hypot(...xs);
	return Float32Array.from(xs, (x) => x / n);
};

test('names each region by its meaning, its topic and its typical terms', () => {
	const works: NamedWork[] = [];
	const group: number[] = [];
	for (let i = 0; i < 20; i++) {
		works.push({
			vector: unit(1, 0.02 * i, 0),
			keywords: ['Peatland restoration', ...(i % 2 ? ['Sphagnum'] : []), ...(i === 0 ? ['Straw mulch'] : [])],
			topics: ['Peatlands and Wetlands Ecology'],
			titleTerms: ['water table', 'restoration'],
		});
		group.push(0);
	}
	for (let i = 0; i < 20; i++) {
		works.push({
			vector: unit(0, 0.02 * i, 1),
			keywords: ['Methane emissions', ...(i % 2 ? ['CO2 flux'] : [])],
			topics: ['Methane Hydrates and Related Phenomena'],
			titleTerms: ['methane', 'carbon dioxide'],
		});
		group.push(1);
	}
	const names = regionNames(works, group, 2);
	assert.equal(names[0]?.title, 'Peatland restoration');
	assert.equal(names[1]?.title, 'Methane emissions');
	assert.equal(names[0]?.topic, 'Peatlands and Wetlands Ecology');
	assert.ok(names[0]?.terms.includes('Sphagnum'));
	// A keyword of one work does not name the region; the name is not repeated in the terms.
	assert.ok(!names[0]?.terms.some((t) => /straw|peatland restoration/i.test(t)));
	assert.ok(names[1]?.terms.includes('CO2 flux'));
});

test('names a region of works mostly known only from reference lists', () => {
	const works: NamedWork[] = [];
	const group: number[] = [];
	// 10 described works, 40 known only by a title: their keywords and topics still name the region.
	for (let i = 0; i < 50; i++) {
		const described = i < 10;
		works.push({
			vector: unit(1, 0.01 * i, 0),
			keywords: described ? ['Wetland ecology', 'Restoration ecology'] : [],
			topics: described ? ['Ecology and Vegetation Dynamics Studies'] : [],
			titleTerms: ['wetlands', 'restoration'],
		});
		group.push(0);
	}
	for (let i = 0; i < 50; i++) {
		works.push({ vector: unit(0, 1, 0.01 * i), keywords: ['Methane'], topics: ['Methane'], titleTerms: ['methane'] });
		group.push(1);
	}
	const [first] = regionNames(works, group, 2);
	assert.ok(first?.title, 'the region has a name');
	assert.equal(first?.topic, 'Ecology and Vegetation Dynamics Studies');
	assert.ok((first?.terms.length ?? 0) > 0, 'and typical terms');
});

test('never names a region by a keyword most works have', () => {
	const works: NamedWork[] = [];
	const group: number[] = [];
	const subjects = ['Water table', 'Methane', 'Sphagnum', 'Fire', 'Salt marsh', 'Beaver', 'Drainage', 'Holocene', 'Nitrogen', 'Carbon'];
	subjects.forEach((subject, g) => {
		for (let i = 0; i < 20; i++) {
			const v = new Float32Array(10).fill(0.01);
			v[g] = 1;
			// Every work also has the broad keyword, scored lower by OpenAlex but present.
			works.push({ vector: v, keywords: ['Environmental science', subject], topics: [], titleTerms: [] });
			group.push(g);
		}
	});
	const names = regionNames(works, group, subjects.length);
	assert.deepEqual(names.map((n) => n.title), subjects);
	assert.ok(names.every((n) => !n.terms.includes('Environmental science')));
});
