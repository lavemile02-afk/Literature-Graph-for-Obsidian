import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryData, querySuggestions } from '../src/groupQueries';

const data: QueryData = {
	tags: ['ecole', 'litterature', 'maitrise', 'tourbe/restauration'],
	properties: new Map([
		['Annee', ['1996', '2016']],
		['Type', ['Article', 'Livre', 'Thèse']],
	]),
	folders: ['Documents', 'Documents/Thèses'],
};

test('suggests tags after "tag:"', () => {
	assert.deepEqual(querySuggestions('tag:', data), ['tag:#ecole', 'tag:#litterature', 'tag:#maitrise', 'tag:#tourbe/restauration']);
	assert.deepEqual(querySuggestions('tag:#ma', data), ['tag:#maitrise']);
	// A part typed anywhere in the tag, after those that start with it.
	assert.deepEqual(querySuggestions('tag:rest', data), ['tag:#tourbe/restauration']);
});

test('suggests properties after "[", then their values', () => {
	assert.deepEqual(querySuggestions('[ty', data), ['[Type:', '[Type]']);
	assert.deepEqual(querySuggestions('[Type:', data), ['[Type:Article]', '[Type:Livre]', '[Type:Thèse]']);
	// Case and accents do not matter.
	assert.deepEqual(querySuggestions('[type:these', data), ['[Type:Thèse]']);
	assert.deepEqual(querySuggestions('[Unknown:', data), []);
});

test('suggests folders after "path:", and the kinds of queries otherwise', () => {
	assert.deepEqual(querySuggestions('path:th', data), ['path:Documents/Thèses']);
	assert.deepEqual(querySuggestions('', data), ['tag:#', '[', 'path:', 'file:']);
	assert.deepEqual(querySuggestions('pa', data), ['path:']);
	assert.deepEqual(querySuggestions('Bourgeois', data), []);
});
