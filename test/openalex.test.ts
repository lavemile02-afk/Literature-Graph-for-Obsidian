import assert from 'node:assert/strict';
import { test } from 'node:test';
import { surnameOf, workCitation } from '../src/openalex';

test('keeps name particles in surnames from OpenAlex', () => {
	assert.equal(surnameOf('Paul J. Van den Brink'), 'Van den Brink');
	assert.equal(surnameOf('Cajo J. F. ter Braak'), 'ter Braak');
	assert.equal(surnameOf('Miquel De Cáceres'), 'De Cáceres');
	assert.equal(surnameOf('Benoît Bourgeois'), 'Bourgeois');
	assert.equal(surnameOf('Line Rochefort'), 'Rochefort');
	assert.equal(surnameOf('Van Morrison'), 'Morrison');
});

test('writes citations of works outside the vault', () => {
	const base = { id: 'W1', doi: null, title: 'T', venue: null, references: [], citedByCount: 0 };
	assert.equal(
		workCitation({ ...base, year: 1999, authors: ['Paul J. Van den Brink', 'Cajo J. F. ter Braak'] }, 'fr'),
		'Van den Brink et ter Braak, 1999',
	);
	assert.equal(workCitation({ ...base, year: null, authors: ['A B', 'C D', 'E F'] }, 'en'), 'B et al., n.d.');
});
