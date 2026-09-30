import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blendColors, colorsFromSharedKeywords, hslColor, mainTopics, meaningPlaces, TopicInfo, topicColors, topicName, topicsFromNames, topicVector, WorkTopics } from '../src/topics';

const place = (subfield: string, field: string): Omit<TopicInfo, 'name'> => ({ subfield, subfieldName: '', field, fieldName: '' });
const info: Record<string, TopicInfo> = {
	// Hydrology of peatlands and of mountains: same field and subfield.
	TP: { name: 'Peatland hydrology', ...place('subfields/2312', 'fields/23') },
	TM: { name: 'Mountain hydrology', ...place('subfields/2312', 'fields/23') },
	TE: { name: 'Wetland ecology', ...place('subfields/2303', 'fields/23') },
	// Psychology: another domain.
	TC: { name: 'Cognition', ...place('subfields/3205', 'fields/32') },
	TD: { name: 'Development', ...place('subfields/3204', 'fields/32') },
};
const lookup = (id: string) => info[id];

/** Hue (degrees) of a color. */
function hue(color: number): number {
	const r = ((color >> 16) & 255) / 255;
	const g = ((color >> 8) & 255) / 255;
	const b = (color & 255) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	if (max === min) return 0;
	const d = max - min;
	const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return (h * 60 + 360) % 360;
}
const hueGap = (a: number, b: number) => {
	const d = Math.abs(hue(a) - hue(b)) % 360;
	return Math.min(d, 360 - d);
};

test('builds a vector of meaning over the whole hierarchy', () => {
	const v = topicVector([['TP', 1]], lookup);
	assert.deepEqual([...v.keys()].sort(), ['TP', 'domains/3', 'fields/23', 'subfields/2312']);
	assert.ok(Math.abs([...v.values()].reduce((s, w) => s + w * w, 0) - 1) < 1e-9);
	// Two topics of one subfield share most of their vector.
	assert.equal(topicVector([['TM', 1]], lookup).get('fields/23'), v.get('fields/23'));
});

const hydrology: WorkTopics[] = [
	...Array.from({ length: 5 }, (): WorkTopics => [['TP', 1]]),
	...Array.from({ length: 5 }, (): WorkTopics => [['TM', 1]]),
];

test('with only hydrology, small differences give very different colors', () => {
	const colors = topicColors(hydrology, lookup);
	assert.ok(hueGap(colors[0]!, colors[9]!) > 120, `${hueGap(colors[0]!, colors[9]!)}°`);
	// Works on the same topic: the same color.
	assert.equal(colors[0], colors[4]);
});

test('with another domain, hydrology draws together and the other domain stands apart', () => {
	const psychology: WorkTopics[] = Array.from({ length: 10 }, (_, i): WorkTopics => [[i % 2 ? 'TC' : 'TD', 1]]);
	const colors = topicColors([...hydrology, ...psychology], lookup);
	const peat = colors[0]!;
	const mountain = colors[9]!;
	const mind = colors[10]!;
	assert.ok(hueGap(peat, mountain) < hueGap(peat, mind), `${hueGap(peat, mountain)}° < ${hueGap(peat, mind)}°`);
	assert.ok(hueGap(peat, mind) > 90, `${hueGap(peat, mind)}°`);
	// Less than when hydrology was alone.
	const alone = topicColors(hydrology, lookup);
	assert.ok(hueGap(peat, mountain) < hueGap(alone[0]!, alone[9]!));
});

test('leaves works without topics uncolored', () => {
	const colors = topicColors([[['TP', 1]], undefined, [], [['TM', 1]]], lookup);
	assert.equal(colors[1], null);
	assert.equal(colors[2], null);
	assert.notEqual(colors[0], null);
});

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

test('reads the topics written in a note: OpenAlex names, and keywords of the user', () => {
	const idOf = (name: string) => Object.entries(info).find(([, t]) => t.name.toLowerCase() === name.toLowerCase())?.[0];
	const topics = topicsFromNames(['Peatland hydrology', 'Sphaignes rouges'], [['TP', 0.8], ['TE', 0.5]], idOf);
	assert.deepEqual(topics, [
		['TP', 0.8],
		['kw:sphaignes rouges', 1],
	]);
	assert.equal(topicName('kw:sphaignes rouges', lookup), 'sphaignes rouges');
	assert.equal(topicName('TP', lookup), 'Peatland hydrology');
	// A keyword counts in the vector of meaning.
	assert.ok((topicVector(topics, lookup).get('kw:sphaignes rouges') ?? 0) > 0);
});

test('places works on related topics near each other, far from other domains', () => {
	const works: (WorkTopics | undefined)[] = [[['TP', 1]], [['TP', 1]], [['TM', 1]], [['TC', 1]], [['TD', 1]], undefined];
	const places = meaningPlaces(works, lookup);
	assert.equal(places[5], null);
	const d = (a: number, b: number) => Math.hypot(places[a]![0] - places[b]![0], places[a]![1] - places[b]![1]);
	assert.ok(d(0, 1) < 1e-9);
	assert.ok(d(0, 2) < d(0, 3), `${d(0, 2)} < ${d(0, 3)}`);
});
