import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkDetails } from '../src/openalex';
import { fileNameOf, fillTemplate, initials, inTextCitation, referenceAuthors, splitName, valuesFromDetails, valuesFromEntry } from '../src/workNote';

const robert: WorkDetails = {
	id: 'W2097924327',
	doi: '10.1139/b99-019',
	title: 'Natural revegetation of two block-cut mined peatlands in eastern Canada',
	year: 1999,
	authors: ['Élisabeth Claire Robert', 'Line Rochefort', 'Michelle Garneau'],
	type: 'article',
	journal: 'Canadian Journal of Botany',
	volume: '77',
	issue: '3',
	firstPage: '447',
	lastPage: '459',
	publisher: 'Canadian Science Publishing',
	issn: '0008-4026',
	language: 'en',
	pdfUrl: null,
	openAccessUrl: null,
	abstract: 'Peatlands were mined.',
};

test('reads names and initials', () => {
	assert.equal(initials('Élisabeth Claire'), 'É. C.');
	assert.equal(initials('Jean-Pierre'), 'J.-P.');
	assert.deepEqual(splitName('Paul J. Van den Brink'), { family: 'Van den Brink', initials: 'P. J.' });
	assert.deepEqual(splitName('WHO'), { family: 'WHO', initials: '' });
});

test('writes in-text citations and reference authors in French and English', () => {
	assert.equal(inTextCitation(['Robert'], '1999', 'fr'), '(Robert, 1999)');
	assert.equal(inTextCitation(['Quinty', 'Rochefort'], '2003', 'fr'), '(Quinty et Rochefort, 2003)');
	assert.equal(inTextCitation(['Quinty', 'Rochefort'], '2003', 'en'), '(Quinty & Rochefort, 2003)');
	assert.equal(inTextCitation(['A', 'B', 'C'], '', 'fr'), '(A et al., s.d.)');
	const names = [
		{ family: 'Robert', initials: 'É. C.' },
		{ family: 'Rochefort', initials: 'L.' },
		{ family: 'Garneau', initials: 'M.' },
	];
	assert.equal(referenceAuthors(names, 'fr'), 'Robert, É. C., Rochefort, L. et Garneau, M.');
	assert.equal(referenceAuthors(names, 'en'), 'Robert, É. C., Rochefort, L., & Garneau, M.');
});

test('builds the values of a work from OpenAlex, with an APA reference', () => {
	const v = valuesFromDetails(robert, 'fr');
	assert.equal(v.citationText, '(Robert et al., 1999)');
	assert.equal(v.fileName, 'Robert et al., 1999');
	assert.equal(v.authors, 'Robert, É. C., Rochefort, L., Garneau, M.');
	assert.equal(
		v.citation,
		'Robert, É. C., Rochefort, L. et Garneau, M. (1999). Natural revegetation of two block-cut mined peatlands in eastern Canada. _Canadian Journal of Botany_, _77_(3), 447–459. https://doi.org/10.1139/b99-019',
	);
	assert.deepEqual([v.type, v.pages, v.url, v.doi], ['Article', '447-459', '', '10.1139/b99-019']);
});

test('fills a template: quoted values, empty properties left empty, text replaced', () => {
	const template = ['---', 'Titre: "{{title}}"', 'Journal: "{{journal}}"', 'Lieu:', 'Pages: {{pages}}', '---', '## Résumé', '{{abstract}}', ''].join('\n');
	const text = fillTemplate(template, { ...valuesFromDetails(robert, 'fr'), journal: '', title: 'Un "titre"' });
	assert.equal(text, ['---', 'Titre: "Un \\"titre\\""', 'Journal:', 'Lieu:', 'Pages: "447-459"', '---', '## Résumé', 'Peatlands were mined.', ''].join('\n'));
});

test('makes a file name without the characters a file name cannot have', () => {
	assert.equal(fileNameOf('(Smith: a/b, 2020)'), 'Smith ab, 2020');
});

test('writes the topics as a list property, or an empty property without topics', () => {
	const values = valuesFromEntry({ text: 'Rochefort, L. (2000).', title: 'Sphagnum', label: 'Rochefort, 2000', year: '2000' });
	const template = '---\nTopics: {{topics}}\ntags:\n  - literature\n---\n';
	assert.equal(fillTemplate(template, values), '---\nTopics:\ntags:\n  - literature\n---\n');
	values.topics = ['Peatlands and Wetlands Ecology', 'Soil "carbon"'];
	assert.equal(fillTemplate(template, values), '---\nTopics:\n  - "Peatlands and Wetlands Ecology"\n  - "Soil \\"carbon\\""\ntags:\n  - literature\n---\n');
});
