import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCitationParams, parseCitationUrl } from '../src/citation';
import { citationUrl, encodeParam, familyNames } from '../src/citationLink';

test('parses an encoded citation link', () => {
	const target = parseCitationUrl(
		'obsidian://cite?note=Bourgeois%20et%20al.%2C%202016%20%281%29&occ=2&qe=after%20planting.&q=Once%20canopy%20cover%20passed%2040%25',
	);
	assert.deepEqual(target, {
		note: 'Bourgeois et al., 2016 (1)',
		q: 'Once canopy cover passed 40%',
		qe: 'after planting.',
		occ: 2,
		doi: undefined,
	});
});

test('parses a readable link whose passage contains "&" and a stray "%"', () => {
	const target = parseCitationUrl(
		'obsidian://cite?note=Bourgeois et al., 2016 (1)&q=succession models (Hobbs & Suding 2009) at 40%',
	);
	assert.equal(target?.note, 'Bourgeois et al., 2016 (1)');
	assert.equal(target?.q, 'succession models (Hobbs & Suding 2009) at 40%');
});

test('parses a link that cites a DOI only', () => {
	assert.deepEqual(parseCitationUrl('obsidian://cite?doi=10.1111%2Fgcb.12394')?.doi, '10.1111/gcb.12394');
});

test('ignores other URLs', () => {
	assert.equal(parseCitationUrl('https://example.org/?q=x'), null);
	assert.equal(parseCitationUrl('obsidian://open?vault=x'), null);
});

test('rejoins a passage that Obsidian split on "&" (protocol handler)', () => {
	const target = parseCitationParams({ action: 'cite', note: 'N', q: 'models (Hobbs ', ' Suding 2009)': 'true' });
	assert.equal(target.q, 'models (Hobbs & Suding 2009)');
});

test('encodes every character that would end a Markdown link', () => {
	assert.equal(encodeParam("a (b) c's *d*!"), 'a%20%28b%29%20c%27s%20%2Ad%2A%21');
});

test('writes canonical URLs with q last', () => {
	assert.equal(
		citationUrl({ q: 'the passage', note: 'Smith, 2020', occ: 2, qe: 'end' }),
		'obsidian://cite?note=Smith%2C%202020&occ=2&qe=end&q=the%20passage',
	);
});

test('reads family names from an authors property', () => {
	assert.deepEqual(familyNames('Bourgeois, B., Vanasse, A., González, E., Poulin, M.-C.'), [
		'Bourgeois',
		'Vanasse',
		'González',
		'Poulin',
	]);
	assert.deepEqual(familyNames('van Andel, J., Aronson, J.'), ['van Andel', 'Aronson']);
});
