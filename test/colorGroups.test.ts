import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatColorGroups, parseColorGroups } from '../src/colorGroups';

test('reads groups, skipping comments, blank lines and lines without a color', () => {
	const groups = parseColorGroups('// my groups\n[Type:Livre] = #d9a441\n\ntag:#thesis = hsl(140, 40%, 55%)\nnothing here');
	assert.deepEqual(groups, [
		{ query: '[Type:Livre]', color: '#d9a441' },
		{ query: 'tag:#thesis', color: 'hsl(140, 40%, 55%)' },
	]);
});

test('writes groups back, keeping comments and leaving out empty queries', () => {
	const text = formatColorGroups(
		[
			{ query: 'path:Literature ', color: '#6fa8dc' },
			{ query: '', color: '#ffffff' },
		],
		'// my groups\nold = #000000',
	);
	assert.equal(text, '// my groups\npath:Literature = #6fa8dc');
	assert.deepEqual(parseColorGroups(text), [{ query: 'path:Literature', color: '#6fa8dc' }]);
});

test('keeps an equals sign inside a query', () => {
	assert.deepEqual(parseColorGroups('[Statut:a=b] = red'), [{ query: '[Statut:a=b]', color: 'red' }]);
});
