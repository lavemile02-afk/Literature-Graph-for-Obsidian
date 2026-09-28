import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findExactPassages, findPassage, normalizeForSearch } from '../src/passage';

const note = [
	'# A paper',
	'',
	'Once canopy cover passed a threshold of ca 40%, plant succession started and led to the',
	're-establishment of forest communities 17 years after planting.',
	'',
	'The *threshold dynamics model* is one model. Another threshold dynamics model exists.',
	'The three-dimensional arrange- ment of all its amino acid residues matters.',
	'We thank those who provided their software<sup>1</sup> : Per Kraulis.',
	'| peat<br>baths and poultices,<br>peat-based fungi- and<br>bactericides |',
	'He said “quoted” words and café ideas.',
].join('\n');

const at = (m: { from: number; to: number } | null) => (m ? note.slice(m.from, m.to) : null);

test('normalizes case, accents, marks, tags, quotes, dashes and spaces', () => {
	assert.equal(normalizeForSearch('Café *au* <b>lait</b> “noir”  arrange-\n ment').text, 'cafe au lait "noir" arrangement');
	const norm = normalizeForSearch('ab <br> cd');
	assert.equal(norm.text, 'ab cd');
	assert.equal(norm.offsets.length, norm.text.length);
});

test('finds a passage exactly, across a line break and in another case', () => {
	assert.equal(at(findPassage(note, 'ONCE CANOPY COVER passed a threshold')), 'Once canopy cover passed a threshold');
	assert.equal(at(findPassage(note, 'led to the re-establishment of forest')), 'led to the\nre-establishment of forest');
});

test('extends the passage to qe', () => {
	assert.equal(
		at(findPassage(note, 'Once canopy cover', 'after planting.')),
		'Once canopy cover passed a threshold of ca 40%, plant succession started and led to the\nre-establishment of forest communities 17 years after planting.',
	);
});

test('picks the requested occurrence', () => {
	assert.equal(findExactPassages(note, 'threshold dynamics model').length, 2);
	const second = findPassage(note, 'threshold dynamics model', undefined, 2);
	assert.ok(second && second.from > note.indexOf('Another'));
});

test('tolerates hyphenation, emphasis, <sup> and <br>', () => {
	assert.ok(findPassage(note, 'the three-dimensional arrangement of all its amino acid residues'));
	assert.ok(findPassage(note, 'The threshold dynamics model is one model'));
	assert.ok(findPassage(note, 'who provided their software1 : Per Kraulis'));
	assert.ok(findPassage(note, 'peat baths and poultices, peat-based fungi- and bactericides'));
	assert.ok(findPassage(note, 'He said "quoted" words and cafe ideas'));
});

test('matches a changed passage approximately, and reports it', () => {
	const m = findPassage(note, 'Once canopy cover exceeded a threshold of about 40%');
	assert.ok(m?.approximate);
	assert.ok(at(m)?.startsWith('Once canopy cover'));
});

test('returns null when the passage is not in the note', () => {
	assert.equal(findPassage(note, 'this sentence is nowhere in the note at all'), null);
});
