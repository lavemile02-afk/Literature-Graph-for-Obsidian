import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blendColors, colorsFromSharedKeywords, mainTopics, orderTopics, sampleGradient, TopicInfo, topicPalette, workColor } from '../src/topics';

const info: Record<string, TopicInfo> = {
	T1: { name: 'Peatlands', subfield: 'subfields/2303', subfieldName: 'Ecology', field: 'fields/23', fieldName: 'Environmental Science' },
	T2: { name: 'Wetland hydrology', subfield: 'subfields/2312', subfieldName: 'Water Science', field: 'fields/23', fieldName: 'Environmental Science' },
	T3: { name: 'Soil carbon', subfield: 'subfields/1111', subfieldName: 'Soil Science', field: 'fields/11', fieldName: 'Agricultural and Biological Sciences' },
	T4: { name: 'Algebra', subfield: 'subfields/2602', subfieldName: 'Algebra', field: 'fields/26', fieldName: 'Mathematics' },
	T5: { name: 'Sociology', subfield: 'subfields/3312', subfieldName: 'Sociology', field: 'fields/33', fieldName: 'Social Sciences' },
};
const lookup = (id: string) => info[id];

test('orders topics so that related ones follow each other', () => {
	// Social sciences, then life sciences, the environment, and mathematics last.
	assert.deepEqual(orderTopics(['T4', 'T2', 'T5', 'T1', 'T3'], lookup), ['T5', 'T3', 'T1', 'T2', 'T4']);
	// A topic without known place goes last.
	assert.deepEqual(orderTopics(['T9', 'T1'], lookup), ['T1', 'T9']);
});

test('samples a gradient from end to end', () => {
	assert.equal(sampleGradient([0x000000, 0xffffff], 0), 0x000000);
	assert.equal(sampleGradient([0x000000, 0xffffff], 1), 0xffffff);
	assert.equal(sampleGradient([0x000000, 0xff0000, 0x00ff00], 0.5), 0xff0000);
	assert.equal(sampleGradient([0x123456], 0.7), 0x123456);
});

test('spreads the topics present over the whole gradient', () => {
	const even = topicPalette(['T1', 'T2', 'T4'], lookup, [0x000000, 0xffffff]);
	// Three topics with one work each: at 1/6, 1/2 and 5/6 of the gradient, in order.
	assert.deepEqual(['T1', 'T2', 'T4'].map((id) => (even.get(id) ?? 0) & 0xff), [0x2b, 0x80, 0xd5]);
	// A topic with four works gets twice the stretch of one with one work: 0 to 1/2, then 1/2 to 3/4, and 3/4 to 1.
	const weighted = topicPalette(['T1', 'T1', 'T1', 'T1', 'T2', 'T4'], lookup, [0x000000, 0xffffff]);
	assert.deepEqual(['T1', 'T2', 'T4'].map((id) => (weighted.get(id) ?? 0) & 0xff), [0x40, 0x9f, 0xdf]);
});

test('mixes the colors of a work by the scores of its topics', () => {
	const palette = new Map([
		['T1', 0xff0000],
		['T2', 0x0000ff],
	]);
	assert.equal(workColor([['T1', 1]], palette), 0xff0000);
	assert.equal(workColor([['T1', 0.5], ['T2', 0.5]], palette), 0x800080);
	assert.equal(workColor([['T9', 1]], palette), null);
	assert.equal(workColor(undefined, palette), null);
	assert.equal(blendColors([]), null);
});

test('colors works without topics from the works sharing their keywords', () => {
	const keywords = new Map([
		['a', new Set(['Tourbe', 'Hydrologie'])],
		['b', new Set(['Tourbe'])],
		['c', new Set(['Hydrologie'])],
		['d', new Set(['Tourbe', 'Hydrologie'])],
		['e', new Set(['Chimie'])],
	]);
	const colored = new Map([
		['b', 0xff0000],
		['c', 0x0000ff],
	]);
	const result = colorsFromSharedKeywords(keywords, colored);
	assert.equal(result.get('a'), 0x800080);
	assert.equal(result.get('d'), 0x800080);
	// No shared keyword: no color guessed.
	assert.equal(result.has('e'), false);
	assert.equal(result.has('b'), false);
});

test('lists the main topics of the graph, most frequent first', () => {
	const legend = mainTopics([[['T1', 0.9], ['T2', 0.5]], [['T1', 1]], [['T3', 1]], undefined], 2);
	assert.deepEqual(legend, [
		{ id: 'T1', works: 2 },
		{ id: 'T3', works: 1 },
	]);
});
