import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEntry } from '../src/bibliography';
import { entryCitation } from '../src/graphData';

test('labels a reference-list entry like an in-text citation', () => {
	const two = parseEntry('Quinty, F., & Rochefort, L. (2003). Peatland restoration guide (2nd ed.).', 0);
	const many = parseEntry('Campeau, S., Miousse, L., et Quinty, F. (2004). Caractérisation du site expérimental de Shippagan.', 0);
	const one = parseEntry('Gorham, E. 1991. Northern peatlands: role in the carbon cycle.', 0);
	const accented = parseEntry('Pouliot, R., & Hugron, S. (2015). Tourbières et sphaignes.', 0);
	assert.ok(two && many && one && accented);
	assert.equal(entryCitation(two, 'fr'), 'Quinty et Rochefort, 2003');
	assert.equal(entryCitation(two, 'en'), 'Quinty & Rochefort, 2003');
	assert.equal(entryCitation(many, 'fr'), 'Campeau et al., 2004');
	assert.equal(entryCitation(one, 'en'), 'Gorham, 1991');
	assert.equal(entryCitation(accented, 'fr'), 'Pouliot et Hugron, 2015');
});

test('reads initials followed by a dot as initials', () => {
	const entry = parseEntry('Boelter DH. 1972. Water table drawdown around an open ditch in organic soils. J Hydrol 15: 329-340.', 0);
	assert.equal(entry?.firstAuthor, 'Boelter');
	assert.equal(entry && entryCitation(entry, 'en'), 'Boelter, 1972');
});
