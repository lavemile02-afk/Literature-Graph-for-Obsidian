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
