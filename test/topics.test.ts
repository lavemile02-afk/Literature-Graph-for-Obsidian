import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blendColors, colorOfPlace, colorsFromSharedKeywords, evenHues, hslColor, mainTopics } from '../src/topics';

test('makes colors from hue, saturation and lightness', () => {
	assert.equal(hslColor(0, 1, 0.5), 0xff0000);
	assert.equal(hslColor(120, 1, 0.5), 0x00ff00);
	assert.equal(hslColor(240, 1, 0.5), 0x0000ff);
	assert.equal(hslColor(0, 0, 0.5), 0x808080);
});

test('mixes colors by weight', () => {
	assert.equal(blendColors([{ color: 0xff0000, weight: 1 }, { color: 0x0000ff, weight: 1 }]), 0x800080);
	assert.equal(blendColors([]), null);
});

test('colors works without topics from the works sharing their keywords', () => {
	const keywords = new Map([
		['a', new Set(['Tourbe', 'Hydrologie'])],
		['b', new Set(['Tourbe'])],
		['c', new Set(['Hydrologie'])],
		['e', new Set(['Chimie'])],
	]);
	const colored = new Map([
		['b', 0xff0000],
		['c', 0x0000ff],
	]);
	const result = colorsFromSharedKeywords(keywords, colored);
	assert.equal(result.get('a'), 0x800080);
	// No shared keyword: no color guessed.
	assert.equal(result.has('e'), false);
	assert.equal(result.has('b'), false);
});

test('lists the main topics of the graph, most frequent first', () => {
	const legend = mainTopics([[['TP', 0.9], ['TM', 0.5]], [['TP', 1]], [['TE', 1]], undefined], 2);
	assert.deepEqual(legend, [
		{ id: 'TP', works: 2 },
		{ id: 'TE', works: 1 },
	]);
});

test('colors places around the wheel: opposite places, far hues', () => {
	const a = colorOfPlace([1, 0], 0.5);
	const b = colorOfPlace([-1, 0], 0.5);
	assert.notEqual(a, b);
	assert.equal(colorOfPlace([1, 0], 0.5), a);
});

test('spreads the hues evenly over the works of the map', () => {
	// Works crowded between 0 and 1 radian: their hues still cover the whole wheel.
	const angles = Array.from({ length: 100 }, (_, i) => i / 100);
	const hue = evenHues(angles);
	assert.ok(hue(0.005) < 10);
	assert.ok(Math.abs(hue(0.5) - 180) < 5);
	assert.ok(hue(0.995) > 350);
	// In order.
	assert.ok(hue(0.2) < hue(0.3));
});
