import assert from 'node:assert/strict';
import { test } from 'node:test';
import { citationLinksIn, markdownLinksInLine } from '../src/links';

test('finds Markdown links, with balanced parentheses and angle brackets', () => {
	const line = 'See ([A, 2016](obsidian://cite?note=A%20(1)&q=x)) and [B](<obsidian://cite?note=B b&q=y z>).';
	const links = markdownLinksInLine(line);
	assert.deepEqual(
		links.map((l) => [l.text, l.url]),
		[
			['A, 2016', 'obsidian://cite?note=A%20(1)&q=x'],
			['B', 'obsidian://cite?note=B b&q=y z'],
		],
	);
	assert.equal(line.slice(links[0]?.from, links[0]?.to), '[A, 2016](obsidian://cite?note=A%20(1)&q=x)');
});

test('finds citation links outside code blocks only', () => {
	const text = [
		'Cited ([A, 2016](obsidian://cite?note=A&q=one)).',
		'```',
		'([B, 2017](obsidian://cite?note=B&q=two))',
		'```',
		'A [normal link](https://example.org).',
	].join('\n');
	const links = citationLinksIn(text);
	assert.equal(links.length, 1);
	assert.equal(links[0]?.target.note, 'A');
	assert.equal(links[0]?.line, 0);
});

test('reads a readable citation link written without angle brackets', () => {
	const line = '8. ([Bourgeois et al., 2016](obsidian://cite?note=Bourgeois et al., 2016 (1)&q=Once canopy cover at 40%)).';
	const [link] = markdownLinksInLine(line);
	assert.equal(link?.url, 'obsidian://cite?note=Bourgeois et al., 2016 (1)&q=Once canopy cover at 40%');
	assert.equal(line.slice(link?.to), ').');
});
